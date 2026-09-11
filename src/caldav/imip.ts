// iMIP (RFC 6047) scheduling messages for CalendarEvent/set.
//
// A CalDAV server without scheduling support (Radicale, most self-hosted
// stores) stores an event with its ATTENDEEs and does nothing else. JMAP for
// Calendars puts that duty on the server when a client sets
// `sendSchedulingMessages: true`, so the proxy sends the mail itself through
// the account's SMTP submission:
//
//   organizer creates / updates  → REQUEST to every attendee
//   organizer drops an attendee  → CANCEL to the dropped ones
//   organizer destroys           → CANCEL to every attendee
//   attendee changes own status  → REPLY to the organizer
//
// `planScheduling` is pure — it decides who gets what from the before /
// after state — and `sendScheduling` turns the plan into MIME and submits it.

import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Credentials } from "../auth/credentials.js";
import type { ProviderConfig } from "../util/config.js";
import { submit } from "../smtp/submit.js";
import { serializeEvent, type JsonObject, type ParticipantJson } from "./jscalendar.js";
import { log } from "../util/log.js";

export type ImipMethod = "REQUEST" | "CANCEL" | "REPLY";

export interface ImipMessage {
  method: ImipMethod;
  /** Recipient addresses (bare addr-spec). */
  to: string[];
  /** The JSCalendar event to serialise for this message. */
  event: JsonObject;
  subject: string;
  text: string;
}

export interface SchedulingInput {
  /** The account's own address, lower-case. */
  me: string;
  /** Display name for the From header. */
  meName?: string | null;
  before: JsonObject | null;
  after: JsonObject | null;
}

interface Attendee {
  email: string;
  name: string | null;
  status: string;
  agent: string;
  roles: Record<string, boolean>;
}

function emailOf(p: ParticipantJson): string | null {
  const raw = p.email ?? (typeof p.calendarAddress === "string" ? p.calendarAddress : p.sendTo?.imip);
  if (!raw) return null;
  return raw.replace(/^mailto:/i, "").trim().toLowerCase() || null;
}

/** Attendees of an event, keyed by lower-case email; the organizer-only entry is excluded. */
export function attendeesOf(ev: JsonObject | null): Map<string, Attendee> {
  const out = new Map<string, Attendee>();
  const parts = (ev?.participants ?? null) as Record<string, ParticipantJson> | null;
  if (!parts) return out;
  for (const p of Object.values(parts)) {
    const roles = p.roles ?? {};
    const isAttendee = roles.attendee || roles.optional || roles.chair || roles.informational;
    if (!isAttendee) continue;
    const email = emailOf(p);
    if (!email) continue;
    out.set(email, {
      email,
      name: p.name ?? null,
      status: (p.participationStatus ?? "needs-action").toLowerCase(),
      agent: (p.scheduleAgent ?? "server").toLowerCase(),
      roles,
    });
  }
  return out;
}

export function organizerOf(ev: JsonObject | null): string | null {
  if (!ev) return null;
  const replyTo = ev.replyTo as Record<string, string> | null | undefined;
  const raw = replyTo?.imip ?? (typeof ev.organizerCalendarAddress === "string" ? ev.organizerCalendarAddress : null);
  if (raw) return raw.replace(/^mailto:/i, "").trim().toLowerCase() || null;
  const parts = (ev.participants ?? null) as Record<string, ParticipantJson> | null;
  if (!parts) return null;
  for (const p of Object.values(parts)) if (p.roles?.owner) return emailOf(p);
  return null;
}

function title(ev: JsonObject): string {
  return typeof ev.title === "string" && ev.title ? ev.title : "(no title)";
}

function when(ev: JsonObject): string {
  const start = typeof ev.start === "string" ? ev.start.replace("T", " ") : "";
  const tz = typeof ev.timeZone === "string" ? ` (${ev.timeZone})` : "";
  return `${start}${tz}`;
}

/** Recipients the server should message: those that did not opt out via scheduleAgent. */
function serverHandled(a: Attendee, me: string): boolean {
  return a.email !== me && a.agent === "server";
}

export function planScheduling(input: SchedulingInput): ImipMessage[] {
  const { me, before, after } = input;
  const organizer = organizerOf(after) ?? organizerOf(before);
  if (!organizer) return [];
  const out: ImipMessage[] = [];

  if (organizer === me) {
    const now = attendeesOf(after);
    const then = attendeesOf(before);
    if (after) {
      const to = [...now.values()].filter((a) => serverHandled(a, me)).map((a) => a.email);
      if (to.length) {
        out.push({
          method: "REQUEST",
          to,
          event: after,
          subject: `${before ? "Updated invitation" : "Invitation"}: ${title(after)}`,
          text: `${input.meName || me} ${before ? "updated the event" : "invites you to"} "${title(after)}" on ${when(after)}.`,
        });
      }
      const dropped = [...then.values()].filter((a) => serverHandled(a, me) && !now.has(a.email)).map((a) => a.email);
      if (dropped.length && before) {
        out.push({
          method: "CANCEL",
          to: dropped,
          event: cancelled(before),
          subject: `Cancelled: ${title(before)}`,
          text: `You have been removed from "${title(before)}" on ${when(before)}.`,
        });
      }
    } else if (before) {
      const to = [...then.values()].filter((a) => serverHandled(a, me)).map((a) => a.email);
      if (to.length) {
        out.push({
          method: "CANCEL",
          to,
          event: cancelled(before),
          subject: `Cancelled: ${title(before)}`,
          text: `${input.meName || me} cancelled "${title(before)}" on ${when(before)}.`,
        });
      }
    }
    return out;
  }

  // We are an attendee: reply when our own status changed (or was set on an
  // event we just stored from an invitation).
  if (!after) return out;
  const mine = attendeesOf(after).get(me);
  if (!mine || mine.agent !== "server") return out;
  const previous = attendeesOf(before).get(me)?.status ?? null;
  if (mine.status === previous || mine.status === "needs-action") return out;
  const reply: JsonObject = {
    ...after,
    participants: Object.fromEntries(
      Object.entries((after.participants ?? {}) as Record<string, ParticipantJson>).filter(([, p]) => {
        const e = emailOf(p);
        return e === me || e === organizer;
      }),
    ),
    alerts: null,
  };
  out.push({
    method: "REPLY",
    to: [organizer],
    event: reply,
    subject: `${statusWord(mine.status)}: ${title(after)}`,
    text: `${input.meName || me} has ${statusWord(mine.status).toLowerCase()} "${title(after)}" on ${when(after)}.`,
  });
  return out;
}

function statusWord(status: string): string {
  switch (status) {
    case "accepted":
      return "Accepted";
    case "declined":
      return "Declined";
    case "tentative":
      return "Tentative";
    default:
      return "Replied";
  }
}

function cancelled(ev: JsonObject): JsonObject {
  return { ...ev, status: "cancelled", sequence: (Number(ev.sequence) || 0) + 1 };
}

export async function sendScheduling(
  opts: { provider: ProviderConfig; creds: Credentials; from: string; fromName?: string | null },
  messages: ImipMessage[],
): Promise<void> {
  for (const m of messages) {
    const ics = serializeEvent(m.event, { method: m.method });
    const composer = new MailComposer({
      from: opts.fromName ? { name: opts.fromName, address: opts.from } : opts.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      icalEvent: { method: m.method, content: ics },
      headers: { "Auto-Submitted": "auto-generated" },
    });
    const raw = await new Promise<Buffer>((resolve, reject) =>
      composer.compile().build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf))),
    );
    try {
      await submit({ provider: opts.provider, creds: opts.creds, envelopeFrom: opts.from, rcptTo: m.to, raw });
      log.info({ method: m.method, to: m.to }, "imip sent");
    } catch (e) {
      // A scheduling failure must not undo the calendar write that
      // triggered it; the event is stored, the invitation can be re-sent.
      log.warn({ err: (e as Error).message, method: m.method, to: m.to }, "imip send failed");
    }
  }
}
