// iCalendar (RFC 5545) ⇄ JSCalendar (RFC 8984) for the JMAP Calendars
// handlers. One .ics resource holds one UID: a master VEVENT plus any
// RECURRENCE-ID overrides, which JSCalendar folds into a single Event with
// `recurrenceOverrides`. Parsing is delegated to ical.js; the mapping rules
// here follow RFC 8984 §A and the property names the Bulwark webmail
// actually reads (see its lib/jmap/types.ts).
//
// Everything we do not model — X-* properties, ATTACH binaries, unusual
// parameters — is carried over verbatim on update by re-adding the original
// master's properties we did not rewrite (`preserveFrom`).

import ICAL from "ical.js";
import crypto from "node:crypto";
import {
  buildVTimezone,
  formatLocal,
  formatUtc,
  isValidTimeZone,
  localToUtc,
  parseLocal,
  toIcalLocal,
  toIcalUtc,
  utcToLocal,
  type LocalParts,
} from "./tz.js";

export type JsonObject = Record<string, unknown>;

export interface ParticipantJson {
  "@type": "Participant";
  name?: string;
  email?: string;
  calendarAddress?: string | null;
  sendTo?: Record<string, string>;
  kind?: string;
  roles: Record<string, boolean>;
  participationStatus?: string;
  participationComment?: string | null;
  expectReply?: boolean;
  scheduleAgent?: string;
  delegatedTo?: Record<string, boolean>;
  delegatedFrom?: Record<string, boolean>;
  memberOf?: Record<string, boolean>;
  language?: string;
}

export interface JsEvent extends JsonObject {
  "@type": "Event";
  uid: string;
  title: string;
  description: string;
  descriptionContentType: string;
  created: string | null;
  updated: string;
  sequence: number;
  start: string;
  duration: string;
  timeZone: string | null;
  showWithoutTime: boolean;
  status: "tentative" | "confirmed" | "cancelled";
  freeBusyStatus: "free" | "busy";
  privacy: "public" | "private" | "secret";
  color: string | null;
  keywords: Record<string, boolean> | null;
  locale: string | null;
  replyTo: Record<string, string> | null;
  organizerCalendarAddress: string | null;
  participants: Record<string, ParticipantJson> | null;
  recurrenceRules: JsonObject[] | null;
  excludedRecurrenceRules: JsonObject[] | null;
  recurrenceOverrides: Record<string, JsonObject> | null;
  alerts: Record<string, JsonObject> | null;
  locations: Record<string, JsonObject> | null;
  virtualLocations: Record<string, JsonObject> | null;
  links: Record<string, JsonObject> | null;
  relatedTo: Record<string, JsonObject> | null;
  useDefaultAlerts: boolean;
  mayInviteSelf: boolean;
  mayInviteOthers: boolean;
  hideAttendees: boolean;
  /** iCalendar METHOD of the enclosing VCALENDAR, when it carried one (iMIP). */
  method?: string | null;
}

/** iCalendar property names this module owns. Anything else is preserved as-is. */
const MODELED_PROPS = new Set([
  "uid", "summary", "description", "created", "dtstamp", "last-modified", "sequence",
  "dtstart", "dtend", "duration", "status", "transp", "class", "color", "categories",
  "location", "geo", "url", "attendee", "organizer", "rrule", "exrule", "exdate", "rdate",
  "recurrence-id", "related-to", "attach", "conference", "x-jmap-id", "priority",
]);

// -- helpers -----------------------------------------------------------------

function timeToLocal(t: ICAL.Time): LocalParts {
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
}

/** Time zone a DTSTART/DTEND/EXDATE property resolves to: IANA name, "Etc/UTC", or null (floating / date). */
function zoneOf(prop: ICAL.Property, value: ICAL.Time, vtimezones: Map<string, string>): string | null {
  if (value.isDate) return null;
  const tzid = prop.getParameter("tzid") as string | undefined;
  if (tzid) return resolveTzid(tzid, vtimezones);
  if (value.zone === ICAL.Timezone.utcTimezone || value.toICALString().endsWith("Z")) return "Etc/UTC";
  return null;
}

/** Map a TZID to an IANA zone: itself when valid, else the VTIMEZONE's X-LIC-LOCATION, else null. */
function resolveTzid(tzid: string, vtimezones: Map<string, string>): string | null {
  if (isValidTimeZone(tzid)) return tzid;
  const loc = vtimezones.get(tzid);
  if (loc && isValidTimeZone(loc)) return loc;
  // Outlook-style "/freeassociation.sourceforge.net/Europe/Paris" ids.
  const tail = /\/([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(tzid)?.[1];
  if (tail && isValidTimeZone(tail)) return tail;
  return null;
}

function durationToIso(d: ICAL.Duration): string {
  const s = d.toString();
  return s === "P" || s === "" ? "PT0S" : s;
}

function icalDurationBetween(a: ICAL.Time, b: ICAL.Time): string {
  const secs = b.toUnixTime() - a.toUnixTime();
  return secondsToIso(secs, a.isDate);
}

export function secondsToIso(secs: number, dateOnly = false): string {
  if (secs <= 0) return dateOnly ? "P1D" : "PT0S";
  let rest = Math.floor(secs);
  const weeks = dateOnly && rest % (7 * 86_400) === 0 ? rest / (7 * 86_400) : 0;
  if (weeks) return `P${weeks}W`;
  const days = Math.floor(rest / 86_400);
  rest -= days * 86_400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  rest -= minutes * 60;
  let out = "P";
  if (days) out += `${days}D`;
  if (hours || minutes || rest) {
    out += "T";
    if (hours) out += `${hours}H`;
    if (minutes) out += `${minutes}M`;
    if (rest) out += `${rest}S`;
  }
  return out;
}

/** ISO 8601 duration → seconds (no months/years: RFC 8984 forbids them for `duration`). */
export function isoToSeconds(iso: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const n = (i: number) => Number(m[i] ?? 0);
  return sign * (n(2) * 7 * 86_400 + n(3) * 86_400 + n(4) * 3600 + n(5) * 60 + n(6));
}

function lower<T extends string>(s: string | null | undefined, allowed: readonly T[], fallback: T): T {
  const v = (s ?? "").toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

function participantKey(uri: string): string {
  return crypto.createHash("sha1").update(uri.toLowerCase()).digest("base64url").slice(0, 12);
}

function mailtoEmail(uri: string): string | undefined {
  const m = /^mailto:(.+)$/i.exec(uri);
  return m?.[1];
}

// -- iCalendar → JSCalendar ---------------------------------------------------

export interface ParsedCalendar {
  events: JsEvent[];
  /** Number of VTODO / VJOURNAL components skipped. */
  skipped: number;
}

/**
 * Parse an iCalendar stream into JSCalendar Events, one per UID. Throws on
 * malformed input.
 */
export function parseICalendar(ics: string): ParsedCalendar {
  const root = new ICAL.Component(ICAL.parse(ics));
  const cal = root.name === "vcalendar" ? root : root.getFirstSubcomponent("vcalendar") ?? root;
  const method = (cal.getFirstPropertyValue("method") as string | null) ?? null;

  const vtimezones = new Map<string, string>();
  for (const vtz of cal.getAllSubcomponents("vtimezone")) {
    const tzid = vtz.getFirstPropertyValue("tzid") as string | null;
    const loc = vtz.getFirstPropertyValue("x-lic-location") as string | null;
    if (tzid && loc) vtimezones.set(tzid, loc);
  }

  const byUid = new Map<string, { master: ICAL.Component | null; overrides: ICAL.Component[] }>();
  let skipped = 0;
  for (const comp of cal.getAllSubcomponents()) {
    if (comp.name === "vtimezone") continue;
    if (comp.name !== "vevent") {
      if (comp.name === "vtodo" || comp.name === "vjournal") skipped++;
      continue;
    }
    const uid = (comp.getFirstPropertyValue("uid") as string | null) ?? `urn:uuid:${crypto.randomUUID()}`;
    let entry = byUid.get(uid);
    if (!entry) {
      entry = { master: null, overrides: [] };
      byUid.set(uid, entry);
    }
    if (comp.hasProperty("recurrence-id")) entry.overrides.push(comp);
    else entry.master = comp;
  }

  const events: JsEvent[] = [];
  for (const [uid, { master, overrides }] of byUid) {
    // An override without its master (an iMIP update for one occurrence) is
    // exposed as a stand-alone event carrying `recurrenceId`.
    const base = master ?? overrides.shift()!;
    const ev = eventFromComponent(base, uid, vtimezones);
    if (!master) {
      const rid = base.getFirstProperty("recurrence-id");
      const ridVal = rid?.getFirstValue() as ICAL.Time | undefined;
      if (rid && ridVal) {
        ev.recurrenceId = formatLocal(timeToLocal(ridVal));
        ev.recurrenceIdTimeZone = zoneOf(rid, ridVal, vtimezones);
      }
    }
    if (overrides.length > 0) {
      const map: Record<string, JsonObject> = ev.recurrenceOverrides ?? {};
      for (const o of overrides) {
        const rid = o.getFirstProperty("recurrence-id");
        const ridVal = rid?.getFirstValue() as ICAL.Time | undefined;
        if (!rid || !ridVal) continue;
        const key = overrideKey(rid, ridVal, ev.timeZone, vtimezones);
        const full = eventFromComponent(o, uid, vtimezones);
        map[key] = diffOverride(ev, full);
      }
      ev.recurrenceOverrides = Object.keys(map).length ? map : null;
    }
    if (method) ev.method = method;
    events.push(ev);
  }
  return { events, skipped };
}

/** RECURRENCE-ID as a LocalDateTime in the master's zone (RFC 8984 §4.3.3). */
function overrideKey(rid: ICAL.Property, value: ICAL.Time, masterTz: string | null, vtimezones: Map<string, string>): string {
  const zone = zoneOf(rid, value, vtimezones);
  if (zone && masterTz && zone !== masterTz) {
    const utc = localToUtc(zone, timeToLocal(value));
    return formatLocal(utcToLocal(masterTz, utc));
  }
  return formatLocal(timeToLocal(value));
}

/** Properties an override may differ in; everything else stays inherited. */
const OVERRIDABLE = [
  "title", "description", "start", "duration", "timeZone", "showWithoutTime", "status", "freeBusyStatus",
  "privacy", "color", "keywords", "locations", "virtualLocations", "links", "participants", "alerts",
] as const;

function diffOverride(master: JsEvent, full: JsEvent): JsonObject {
  const patch: JsonObject = {};
  for (const k of OVERRIDABLE) {
    const a = JSON.stringify(master[k] ?? null);
    const b = JSON.stringify(full[k] ?? null);
    if (a !== b) patch[k] = full[k] ?? null;
  }
  return patch;
}

function eventFromComponent(comp: ICAL.Component, uid: string, vtimezones: Map<string, string>): JsEvent {
  const text = (name: string): string | null => {
    const v = comp.getFirstPropertyValue(name);
    return v == null ? null : String(v);
  };

  const dtstartProp = comp.getFirstProperty("dtstart");
  const dtstart = (dtstartProp?.getFirstValue() as ICAL.Time | undefined) ?? ICAL.Time.now();
  const showWithoutTime = dtstart.isDate;
  const timeZone = dtstartProp ? zoneOf(dtstartProp, dtstart, vtimezones) : null;

  let duration: string;
  const durProp = comp.getFirstPropertyValue("duration") as ICAL.Duration | null;
  const dtendProp = comp.getFirstProperty("dtend");
  if (durProp) duration = durationToIso(durProp);
  else if (dtendProp) duration = icalDurationBetween(dtstart, dtendProp.getFirstValue() as ICAL.Time);
  else duration = showWithoutTime ? "P1D" : "PT0S";

  const startLocal = timeToLocal(dtstart);
  if (showWithoutTime) {
    startLocal.hour = 0;
    startLocal.minute = 0;
    startLocal.second = 0;
  }

  const ev: JsEvent = {
    "@type": "Event",
    uid,
    title: text("summary") ?? "",
    description: text("description") ?? "",
    descriptionContentType: "text/plain",
    created: utcOf(comp.getFirstPropertyValue("created") as ICAL.Time | null),
    updated:
      utcOf(comp.getFirstPropertyValue("last-modified") as ICAL.Time | null) ??
      utcOf(comp.getFirstPropertyValue("dtstamp") as ICAL.Time | null) ??
      formatUtc(Date.now()),
    sequence: Number(comp.getFirstPropertyValue("sequence") ?? 0) || 0,
    start: formatLocal(startLocal),
    duration,
    timeZone,
    showWithoutTime,
    status: lower(text("status"), ["tentative", "confirmed", "cancelled"] as const, "confirmed"),
    freeBusyStatus: (text("transp") ?? "").toUpperCase() === "TRANSPARENT" ? "free" : "busy",
    privacy: privacyOf(text("class")),
    color: text("color"),
    keywords: keywordsOf(comp),
    locale: null,
    replyTo: null,
    organizerCalendarAddress: null,
    participants: null,
    recurrenceRules: null,
    excludedRecurrenceRules: null,
    recurrenceOverrides: null,
    alerts: alertsOf(comp),
    locations: locationsOf(comp),
    virtualLocations: virtualLocationsOf(comp),
    links: linksOf(comp),
    relatedTo: relatedToOf(comp),
    useDefaultAlerts: false,
    mayInviteSelf: false,
    mayInviteOthers: false,
    hideAttendees: false,
  };
  if (ev.color && !ev.color.trim()) ev.color = null;

  // Recurrence
  const rrules = comp.getAllProperties("rrule").map((p) => recurToJs(p.getFirstValue() as ICAL.Recur, timeZone));
  if (rrules.length) ev.recurrenceRules = rrules;
  const exrules = comp.getAllProperties("exrule").map((p) => recurToJs(p.getFirstValue() as ICAL.Recur, timeZone));
  if (exrules.length) ev.excludedRecurrenceRules = exrules;
  const overrides: Record<string, JsonObject> = {};
  for (const p of comp.getAllProperties("exdate")) {
    for (const v of p.getValues() as ICAL.Time[]) overrides[overrideKey(p, v, timeZone, vtimezones)] = { excluded: true };
  }
  for (const p of comp.getAllProperties("rdate")) {
    for (const v of p.getValues() as ICAL.Time[]) {
      if (v instanceof ICAL.Time) overrides[overrideKey(p, v, timeZone, vtimezones)] = {};
    }
  }
  if (Object.keys(overrides).length) ev.recurrenceOverrides = overrides;

  // Participants
  const participants: Record<string, ParticipantJson> = {};
  const organizer = comp.getFirstProperty("organizer");
  if (organizer) {
    const uri = String(organizer.getFirstValue());
    const key = participantKey(uri);
    participants[key] = {
      "@type": "Participant",
      name: (organizer.getParameter("cn") as string | undefined) ?? undefined,
      email: mailtoEmail(uri),
      calendarAddress: uri,
      sendTo: { imip: uri },
      kind: "individual",
      roles: { owner: true },
      participationStatus: "accepted",
      expectReply: false,
      scheduleAgent: "server",
    };
    ev.replyTo = { imip: uri };
    ev.organizerCalendarAddress = uri;
  }
  for (const p of comp.getAllProperties("attendee")) {
    const uri = String(p.getFirstValue());
    const key = participantKey(uri);
    const existing = participants[key];
    const param = (n: string) => p.getParameter(n) as string | undefined;
    const roles: Record<string, boolean> = { ...(existing?.roles ?? {}) };
    const role = (param("role") ?? "REQ-PARTICIPANT").toUpperCase();
    if (role === "CHAIR") roles.chair = true;
    if (role === "OPT-PARTICIPANT") roles.optional = true;
    if (role === "NON-PARTICIPANT") roles.informational = true;
    if (role !== "NON-PARTICIPANT") roles.attendee = true;
    const cutype = (param("cutype") ?? "INDIVIDUAL").toUpperCase();
    const kind = cutype === "GROUP" ? "group" : cutype === "RESOURCE" ? "resource" : cutype === "ROOM" ? "location" : "individual";
    const partstat = (param("partstat") ?? "NEEDS-ACTION").toLowerCase();
    const part: ParticipantJson = {
      "@type": "Participant",
      ...(existing ?? {}),
      name: param("cn") ?? existing?.name,
      email: mailtoEmail(uri) ?? existing?.email,
      calendarAddress: uri,
      sendTo: { imip: uri },
      kind,
      roles,
      participationStatus: ["needs-action", "accepted", "declined", "tentative", "delegated"].includes(partstat) ? partstat : "needs-action",
      expectReply: (param("rsvp") ?? "FALSE").toUpperCase() === "TRUE",
      scheduleAgent: (param("schedule-agent") ?? "SERVER").toLowerCase(),
    };
    const delTo = param("delegated-to");
    if (delTo) part.delegatedTo = Object.fromEntries(delTo.split(",").map((u) => [participantKey(u.trim()), true]));
    const delFrom = param("delegated-from");
    if (delFrom) part.delegatedFrom = Object.fromEntries(delFrom.split(",").map((u) => [participantKey(u.trim()), true]));
    const member = param("member");
    if (member) part.memberOf = Object.fromEntries(member.split(",").map((u) => [participantKey(u.trim()), true]));
    const lang = param("language");
    if (lang) part.language = lang;
    for (const k of Object.keys(part) as Array<keyof ParticipantJson>) if (part[k] === undefined) delete part[k];
    participants[key] = part;
  }
  if (Object.keys(participants).length) ev.participants = participants;

  return ev;
}

function utcOf(t: ICAL.Time | null | undefined): string | null {
  if (!t) return null;
  try {
    return formatUtc(t.toUnixTime() * 1000);
  } catch {
    return null;
  }
}

function privacyOf(cls: string | null): "public" | "private" | "secret" {
  const c = (cls ?? "PUBLIC").toUpperCase();
  if (c === "PRIVATE") return "private";
  if (c === "CONFIDENTIAL") return "secret";
  return "public";
}

function keywordsOf(comp: ICAL.Component): Record<string, boolean> | null {
  const out: Record<string, boolean> = {};
  for (const p of comp.getAllProperties("categories")) {
    for (const v of p.getValues()) {
      const s = String(v).trim();
      if (s) out[s] = true;
    }
  }
  return Object.keys(out).length ? out : null;
}

function alertsOf(comp: ICAL.Component): Record<string, JsonObject> | null {
  const out: Record<string, JsonObject> = {};
  let i = 0;
  for (const va of comp.getAllSubcomponents("valarm")) {
    const trigProp = va.getFirstProperty("trigger");
    if (!trigProp) continue;
    const trig = trigProp.getFirstValue();
    let trigger: JsonObject;
    if (trig instanceof ICAL.Duration) {
      const related = String(trigProp.getParameter("related") ?? "START").toUpperCase();
      trigger = { "@type": "OffsetTrigger", offset: durationToIsoSigned(trig), relativeTo: related === "END" ? "end" : "start" };
    } else if (trig instanceof ICAL.Time) {
      trigger = { "@type": "AbsoluteTrigger", when: formatUtc(trig.toUnixTime() * 1000) };
    } else continue;
    const action = String(va.getFirstPropertyValue("action") ?? "DISPLAY").toUpperCase();
    const id = (va.getFirstPropertyValue("uid") as string | null) ?? (va.getFirstPropertyValue("x-jmap-id") as string | null) ?? String(++i);
    const alert: JsonObject = { "@type": "Alert", trigger, action: action === "EMAIL" ? "email" : "display" };
    const ack = va.getFirstPropertyValue("acknowledged") as ICAL.Time | null;
    if (ack) alert.acknowledged = formatUtc(ack.toUnixTime() * 1000);
    out[id] = alert;
  }
  return Object.keys(out).length ? out : null;
}

function durationToIsoSigned(d: ICAL.Duration): string {
  const s = d.toString();
  if (s === "P" || s === "-P" || s === "") return "PT0S";
  return s;
}

function locationsOf(comp: ICAL.Component): Record<string, JsonObject> | null {
  const name = comp.getFirstPropertyValue("location") as string | null;
  const geo = comp.getFirstPropertyValue("geo") as unknown;
  if (!name && !geo) return null;
  const loc: JsonObject = { "@type": "Location", name: name ?? "" };
  if (Array.isArray(geo) && geo.length === 2) loc.coordinates = `geo:${geo[0]},${geo[1]}`;
  else if (typeof geo === "string" && /^-?\d/.test(geo)) loc.coordinates = `geo:${geo.replace(";", ",")}`;
  return { "1": loc };
}

function virtualLocationsOf(comp: ICAL.Component): Record<string, JsonObject> | null {
  const out: Record<string, JsonObject> = {};
  let i = 0;
  for (const p of comp.getAllProperties("conference")) {
    const uri = String(p.getFirstValue());
    if (!uri) continue;
    const vl: JsonObject = { "@type": "VirtualLocation", uri, name: (p.getParameter("label") as string | undefined) ?? "" };
    const feature = p.getParameter("feature") as string | string[] | undefined;
    if (feature) {
      const list = Array.isArray(feature) ? feature : String(feature).split(",");
      vl.features = Object.fromEntries(list.map((f) => [f.trim().toLowerCase(), true]));
    }
    out[String(++i)] = vl;
  }
  return Object.keys(out).length ? out : null;
}

function linksOf(comp: ICAL.Component): Record<string, JsonObject> | null {
  const out: Record<string, JsonObject> = {};
  let i = 0;
  const url = comp.getFirstPropertyValue("url") as string | null;
  if (url) out[String(++i)] = { "@type": "Link", href: url, rel: "describedby" };
  for (const p of comp.getAllProperties("attach")) {
    if ((p.getParameter("value") as string | undefined)?.toUpperCase() === "BINARY") continue;
    const href = String(p.getFirstValue());
    if (!href) continue;
    const link: JsonObject = { "@type": "Link", href, rel: "enclosure" };
    const fmt = p.getParameter("fmttype") as string | undefined;
    if (fmt) link.contentType = fmt;
    const size = p.getParameter("size") as string | undefined;
    if (size && /^\d+$/.test(size)) link.size = Number(size);
    const title = p.getParameter("filename") as string | undefined;
    if (title) link.title = title;
    out[String(++i)] = link;
  }
  return Object.keys(out).length ? out : null;
}

function relatedToOf(comp: ICAL.Component): Record<string, JsonObject> | null {
  const out: Record<string, JsonObject> = {};
  for (const p of comp.getAllProperties("related-to")) {
    const uid = String(p.getFirstValue());
    if (!uid) continue;
    const rel = String(p.getParameter("reltype") ?? "PARENT").toLowerCase();
    out[uid] = { "@type": "Relation", relation: { [rel]: true } };
  }
  return Object.keys(out).length ? out : null;
}

const DAY_MAP: Record<string, string> = { SU: "su", MO: "mo", TU: "tu", WE: "we", TH: "th", FR: "fr", SA: "sa" };

function recurToJs(r: ICAL.Recur, tz: string | null): JsonObject {
  const out: JsonObject = { "@type": "RecurrenceRule", frequency: String(r.freq).toLowerCase() };
  if (r.interval && r.interval !== 1) out.interval = r.interval;
  if (r.count != null) out.count = r.count;
  if (r.until) {
    // RFC 8984: `until` is a LocalDateTime in the event's zone; a UTC UNTIL
    // is converted when the start carries a zone.
    const u = r.until as ICAL.Time;
    const isUtc = !u.isDate && (u.zone === ICAL.Timezone.utcTimezone || u.toICALString().endsWith("Z"));
    if (isUtc && tz && tz !== "Etc/UTC") {
      out.until = formatLocal(utcToLocal(tz, u.toUnixTime() * 1000));
    } else {
      const l = timeToLocal(u);
      if (u.isDate) {
        l.hour = 23;
        l.minute = 59;
        l.second = 59;
      }
      out.until = formatLocal(l);
    }
  }
  const parts = r.parts as Record<string, unknown[]>;
  const nums = (k: string) => (parts[k] ? (parts[k] as number[]).map(Number) : null);
  if (parts["BYDAY"]) {
    out.byDay = (parts["BYDAY"] as string[]).map((d) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d);
      const day = DAY_MAP[m?.[2] ?? d] ?? d.toLowerCase();
      const nth = m?.[1] ? Number(m[1]) : undefined;
      return nth ? { "@type": "NDay", day, nthOfPeriod: nth } : { "@type": "NDay", day };
    });
  }
  if (parts["BYMONTHDAY"]) out.byMonthDay = nums("BYMONTHDAY");
  if (parts["BYMONTH"]) out.byMonth = (parts["BYMONTH"] as unknown[]).map(String);
  if (parts["BYYEARDAY"]) out.byYearDay = nums("BYYEARDAY");
  if (parts["BYWEEKNO"]) out.byWeekNo = nums("BYWEEKNO");
  if (parts["BYHOUR"]) out.byHour = nums("BYHOUR");
  if (parts["BYMINUTE"]) out.byMinute = nums("BYMINUTE");
  if (parts["BYSECOND"]) out.bySecond = nums("BYSECOND");
  if (parts["BYSETPOS"]) out.bySetPosition = nums("BYSETPOS");
  if (r.wkst && r.wkst !== ICAL.Time.MONDAY) {
    const names = ["su", "mo", "tu", "we", "th", "fr", "sa"];
    out.firstDayOfWeek = names[r.wkst - 1] ?? "mo";
  }
  return out;
}

// -- JSCalendar → iCalendar ---------------------------------------------------

export interface SerializeOptions {
  /** Original .ics of the resource being updated; unmodeled properties are carried over. */
  preserveFrom?: string;
  /** PRODID to stamp. */
  prodId?: string;
  /** METHOD for iMIP messages. */
  method?: string;
}

/**
 * Build an iCalendar stream for one JSCalendar Event (with its overrides).
 * Accepts either the RFC 8984 plural (`recurrenceRules`) or Stalwart's
 * singular (`recurrenceRule`) spellings.
 */
export function serializeEvent(input: JsonObject, opts: SerializeOptions = {}): string {
  const ev = normaliseInput(input);
  const cal = new ICAL.Component("vcalendar");
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("prodid", opts.prodId ?? "-//bulwarkmail//legacy-proxy//EN");
  if (opts.method) cal.addPropertyWithValue("method", opts.method.toUpperCase());

  let original: ICAL.Component | null = null;
  if (opts.preserveFrom) {
    try {
      const root = new ICAL.Component(ICAL.parse(opts.preserveFrom));
      original = root.getAllSubcomponents("vevent").find((c) => !c.hasProperty("recurrence-id")) ?? null;
    } catch {
      original = null;
    }
  }

  const zones = new Set<string>();
  const master = componentFromEvent(ev, zones, original);
  cal.addSubcomponent(master);

  const overrides = (ev.recurrenceOverrides ?? null) as Record<string, JsonObject> | null;
  const tz = typeof ev.timeZone === "string" && isValidTimeZone(ev.timeZone) ? ev.timeZone : null;
  if (overrides) {
    for (const [key, patch] of Object.entries(overrides)) {
      const local = parseLocal(key);
      if (!local) continue;
      if (patch && (patch as JsonObject).excluded === true) {
        const p = master.addPropertyWithValue("exdate", makeTime(local, tz, Boolean(ev.showWithoutTime)));
        if (tz && tz !== "Etc/UTC") p.setParameter("tzid", tz);
        continue;
      }
      if (!patch || Object.keys(patch).length === 0) {
        const p = master.addPropertyWithValue("rdate", makeTime(local, tz, Boolean(ev.showWithoutTime)));
        if (tz && tz !== "Etc/UTC") p.setParameter("tzid", tz);
        continue;
      }
      const merged: JsonObject = { ...ev, ...(patch as JsonObject), recurrenceOverrides: null, recurrenceRules: null, excludedRecurrenceRules: null };
      const oc = componentFromEvent(merged, zones, null);
      const rid = oc.addPropertyWithValue("recurrence-id", makeTime(local, tz, Boolean(ev.showWithoutTime)));
      if (tz && tz !== "Etc/UTC") rid.setParameter("tzid", tz);
      cal.addSubcomponent(oc);
    }
  }

  // VTIMEZONEs first, covering the event's years.
  const years = eventYears(ev);
  for (const z of zones) {
    if (z === "Etc/UTC" || z === "UTC") continue;
    const vtz = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${buildVTimezone(z, years[0], years[1])}\r\nEND:VCALENDAR`)).getFirstSubcomponent("vtimezone");
    if (vtz) cal.addSubcomponent(vtz);
  }
  // ical.js appends; move VTIMEZONEs ahead of VEVENTs for readability. Copy
  // the list first: getAllSubcomponents() hands out the live array.
  const comps = [...cal.getAllSubcomponents()];
  for (const c of comps) cal.removeSubcomponent(c);
  for (const c of comps.filter((c) => c.name === "vtimezone")) cal.addSubcomponent(c);
  for (const c of comps.filter((c) => c.name !== "vtimezone")) cal.addSubcomponent(c);

  return cal.toString().replace(/\r?\n/g, "\r\n");
}

function normaliseInput(input: JsonObject): JsonObject {
  const ev: JsonObject = { ...input };
  delete ev["@type"];
  if (ev.recurrenceRule !== undefined && ev.recurrenceRules === undefined) {
    ev.recurrenceRules = ev.recurrenceRule == null ? null : Array.isArray(ev.recurrenceRule) ? ev.recurrenceRule : [ev.recurrenceRule];
  }
  if (ev.excludedRecurrenceRule !== undefined && ev.excludedRecurrenceRules === undefined) {
    ev.excludedRecurrenceRules = ev.excludedRecurrenceRule == null ? null : Array.isArray(ev.excludedRecurrenceRule) ? ev.excludedRecurrenceRule : [ev.excludedRecurrenceRule];
  }
  delete ev.recurrenceRule;
  delete ev.excludedRecurrenceRule;
  return ev;
}

function eventYears(ev: JsonObject): [number, number] {
  const start = parseLocal(String(ev.start ?? ""));
  const y = start?.year ?? new Date().getUTCFullYear();
  let to = y + 1;
  const rules = ev.recurrenceRules as JsonObject[] | null | undefined;
  if (rules && rules.length) {
    const until = rules.map((r) => parseLocal(String(r.until ?? ""))?.year).filter((n): n is number => typeof n === "number");
    to = until.length ? Math.max(...until) : y + 5;
  }
  const overrides = ev.recurrenceOverrides as Record<string, unknown> | null | undefined;
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      const oy = parseLocal(k)?.year;
      if (oy && oy > to) to = oy;
    }
  }
  return [y - 1, Math.min(to, y + 30)];
}

function makeTime(l: LocalParts, tz: string | null, dateOnly: boolean): ICAL.Time {
  if (dateOnly) return ICAL.Time.fromDateString(formatLocal(l).slice(0, 10));
  if (tz === "Etc/UTC" || tz === "UTC") {
    const t = ICAL.Time.fromDateTimeString(formatLocal(l) + "Z");
    return t;
  }
  const t = ICAL.Time.fromDateTimeString(formatLocal(l));
  return t;
}

function componentFromEvent(ev: JsonObject, zones: Set<string>, original: ICAL.Component | null): ICAL.Component {
  const c = new ICAL.Component("vevent");
  const str = (k: string): string | null => (typeof ev[k] === "string" && (ev[k] as string) !== "" ? (ev[k] as string) : null);

  c.addPropertyWithValue("uid", str("uid") ?? `urn:uuid:${crypto.randomUUID()}`);
  const nowIcal = ICAL.Time.fromJSDate(new Date(), true);
  c.addPropertyWithValue("dtstamp", nowIcal);
  const created = str("created");
  if (created) c.addPropertyWithValue("created", ICAL.Time.fromJSDate(new Date(created), true));
  c.addPropertyWithValue("last-modified", nowIcal);
  const seq = Number(ev.sequence ?? 0);
  if (seq > 0) c.addPropertyWithValue("sequence", seq);

  const title = str("title");
  if (title) c.addPropertyWithValue("summary", title);
  const description = str("description");
  if (description) c.addPropertyWithValue("description", description);

  const showWithoutTime = ev.showWithoutTime === true;
  const tz = typeof ev.timeZone === "string" && isValidTimeZone(ev.timeZone) ? ev.timeZone : null;
  const start = parseLocal(String(ev.start ?? "")) ?? utcToLocal("UTC", Date.now());
  const dtstart = c.addPropertyWithValue("dtstart", makeTime(start, tz, showWithoutTime));
  if (!showWithoutTime && tz && tz !== "Etc/UTC") {
    dtstart.setParameter("tzid", tz);
    zones.add(tz);
  }
  const durIso = str("duration") ?? (showWithoutTime ? "P1D" : "PT0S");
  const secs = isoToSeconds(durIso);
  if (showWithoutTime) {
    const days = Math.max(1, Math.round(secs / 86_400));
    const end = new Date(Date.UTC(start.year, start.month - 1, start.day + days));
    c.addPropertyWithValue("dtend", ICAL.Time.fromDateString(end.toISOString().slice(0, 10)));
  } else if (secs > 0) {
    c.addPropertyWithValue("duration", ICAL.Duration.fromSeconds(secs));
  }

  const status = str("status");
  if (status) c.addPropertyWithValue("status", status.toUpperCase());
  if (ev.freeBusyStatus === "free") c.addPropertyWithValue("transp", "TRANSPARENT");
  const privacy = str("privacy");
  if (privacy === "private") c.addPropertyWithValue("class", "PRIVATE");
  else if (privacy === "secret") c.addPropertyWithValue("class", "CONFIDENTIAL");
  const color = str("color");
  if (color) c.addPropertyWithValue("color", color);
  const keywords = ev.keywords as Record<string, boolean> | null | undefined;
  if (keywords) {
    const list = Object.entries(keywords).filter(([, on]) => on).map(([k]) => k);
    if (list.length) {
      const p = new ICAL.Property("categories");
      p.setValues(list);
      c.addProperty(p);
    }
  }

  const locations = ev.locations as Record<string, JsonObject> | null | undefined;
  if (locations) {
    const first = Object.values(locations)[0];
    if (first) {
      const name = typeof first.name === "string" ? first.name : "";
      if (name) c.addPropertyWithValue("location", name);
      const coords = typeof first.coordinates === "string" ? /^geo:(-?[\d.]+),(-?[\d.]+)/.exec(first.coordinates) : null;
      if (coords) c.addPropertyWithValue("geo", [Number(coords[1]), Number(coords[2])]);
    }
  }
  const virtual = ev.virtualLocations as Record<string, JsonObject> | null | undefined;
  if (virtual) {
    for (const vl of Object.values(virtual)) {
      if (typeof vl.uri !== "string" || !vl.uri) continue;
      const p = c.addPropertyWithValue("conference", vl.uri);
      p.setParameter("value", "URI");
      if (typeof vl.name === "string" && vl.name) p.setParameter("label", vl.name);
      const features = vl.features as Record<string, boolean> | null | undefined;
      if (features) {
        const list = Object.entries(features).filter(([, on]) => on).map(([k]) => k.toUpperCase());
        if (list.length) p.setParameter("feature", list.join(","));
      }
    }
  }
  const links = ev.links as Record<string, JsonObject> | null | undefined;
  if (links) {
    for (const l of Object.values(links)) {
      if (typeof l.href !== "string" || !l.href) continue;
      if (l.rel === "describedby" && !c.hasProperty("url")) {
        c.addPropertyWithValue("url", l.href);
        continue;
      }
      const p = c.addPropertyWithValue("attach", l.href);
      if (typeof l.contentType === "string") p.setParameter("fmttype", l.contentType);
      if (typeof l.size === "number") p.setParameter("size", String(l.size));
      if (typeof l.title === "string") p.setParameter("filename", l.title);
    }
  }
  const related = ev.relatedTo as Record<string, JsonObject> | null | undefined;
  if (related) {
    for (const [uid, rel] of Object.entries(related)) {
      const p = c.addPropertyWithValue("related-to", uid);
      const kinds = (rel?.relation ?? {}) as Record<string, boolean>;
      const first = Object.keys(kinds).find((k) => kinds[k]);
      if (first && first !== "parent") p.setParameter("reltype", first.toUpperCase());
    }
  }

  // Recurrence
  const rules = ev.recurrenceRules as JsonObject[] | null | undefined;
  for (const r of rules ?? []) c.addPropertyWithValue("rrule", recurFromJs(r, tz));
  const exrules = ev.excludedRecurrenceRules as JsonObject[] | null | undefined;
  for (const r of exrules ?? []) c.addPropertyWithValue("exrule", recurFromJs(r, tz));

  // Participants
  const participants = ev.participants as Record<string, ParticipantJson> | null | undefined;
  const replyTo = ev.replyTo as Record<string, string> | null | undefined;
  let organizerUri: string | null = (replyTo?.imip ?? (typeof ev.organizerCalendarAddress === "string" ? ev.organizerCalendarAddress : null)) || null;
  if (participants) {
    for (const p of Object.values(participants)) {
      const uri = participantUri(p);
      if (!uri) continue;
      if (p.roles?.owner && !organizerUri) organizerUri = uri;
    }
    for (const p of Object.values(participants)) {
      const uri = participantUri(p);
      if (!uri) continue;
      const roles = p.roles ?? {};
      const isOrganizerOnly = roles.owner && !roles.attendee && !roles.optional && !roles.chair && !roles.informational;
      if (isOrganizerOnly && uri === organizerUri) continue;
      const prop = c.addPropertyWithValue("attendee", uri);
      if (p.name) prop.setParameter("cn", p.name);
      const kind = (p.kind ?? "individual").toLowerCase();
      if (kind !== "individual") prop.setParameter("cutype", kind === "location" ? "ROOM" : kind.toUpperCase());
      const role = roles.chair ? "CHAIR" : roles.informational && !roles.attendee ? "NON-PARTICIPANT" : roles.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT";
      if (role !== "REQ-PARTICIPANT") prop.setParameter("role", role);
      const ps = (p.participationStatus ?? "needs-action").toUpperCase();
      if (ps !== "NEEDS-ACTION") prop.setParameter("partstat", ps);
      if (p.expectReply) prop.setParameter("rsvp", "TRUE");
      if (p.scheduleAgent && p.scheduleAgent !== "server") prop.setParameter("schedule-agent", p.scheduleAgent.toUpperCase());
      if (p.language) prop.setParameter("language", p.language);
      const delTo = keysToUris(p.delegatedTo, participants);
      if (delTo) prop.setParameter("delegated-to", delTo);
      const delFrom = keysToUris(p.delegatedFrom, participants);
      if (delFrom) prop.setParameter("delegated-from", delFrom);
      const member = keysToUris(p.memberOf, participants);
      if (member) prop.setParameter("member", member);
    }
  }
  if (organizerUri) {
    const org = c.addPropertyWithValue("organizer", organizerUri);
    const owner = participants ? Object.values(participants).find((p) => participantUri(p) === organizerUri) : undefined;
    if (owner?.name) org.setParameter("cn", owner.name);
  }

  // Alerts
  const alerts = ev.alerts as Record<string, JsonObject> | null | undefined;
  if (alerts) {
    for (const [id, a] of Object.entries(alerts)) {
      const trig = a.trigger as JsonObject | undefined;
      if (!trig) continue;
      const va = new ICAL.Component("valarm");
      va.addPropertyWithValue("action", a.action === "email" ? "EMAIL" : "DISPLAY");
      va.addPropertyWithValue("description", title ?? "Reminder");
      va.addPropertyWithValue("uid", id);
      if (trig["@type"] === "AbsoluteTrigger" && typeof trig.when === "string") {
        const p = va.addPropertyWithValue("trigger", ICAL.Time.fromJSDate(new Date(trig.when), true));
        p.setParameter("value", "DATE-TIME");
      } else {
        const offset = typeof trig.offset === "string" ? trig.offset : "PT0S";
        const p = va.addPropertyWithValue("trigger", ICAL.Duration.fromString(offset));
        if (trig.relativeTo === "end") p.setParameter("related", "END");
      }
      if (typeof a.acknowledged === "string") va.addPropertyWithValue("acknowledged", ICAL.Time.fromJSDate(new Date(a.acknowledged), true));
      c.addSubcomponent(va);
    }
  }

  // Carry over what we do not model from the original master.
  if (original) {
    for (const p of original.getAllProperties()) {
      if (MODELED_PROPS.has(p.name)) continue;
      if (p.name === "last-modified" || p.name === "dtstamp") continue;
      c.addProperty(new ICAL.Property(structuredClone(p.toJSON())));
    }
  }

  return c;
}

function participantUri(p: ParticipantJson): string | null {
  if (typeof p.calendarAddress === "string" && p.calendarAddress) return p.calendarAddress;
  const imip = p.sendTo?.imip;
  if (imip) return imip;
  if (p.email) return `mailto:${p.email}`;
  return null;
}

function keysToUris(keys: Record<string, boolean> | undefined, all: Record<string, ParticipantJson>): string | null {
  if (!keys) return null;
  const uris = Object.entries(keys)
    .filter(([, on]) => on)
    .map(([k]) => (all[k] ? participantUri(all[k]!) : null))
    .filter((u): u is string => !!u);
  return uris.length ? uris.join(",") : null;
}

const DAY_REVERSE: Record<string, string> = { su: "SU", mo: "MO", tu: "TU", we: "WE", th: "TH", fr: "FR", sa: "SA" };

function recurFromJs(r: JsonObject, tz: string | null): ICAL.Recur {
  const parts: string[] = [`FREQ=${String(r.frequency ?? "daily").toUpperCase()}`];
  if (typeof r.interval === "number" && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (typeof r.count === "number") parts.push(`COUNT=${r.count}`);
  if (typeof r.until === "string") {
    const l = parseLocal(r.until);
    if (l) {
      if (tz && tz !== "Etc/UTC") parts.push(`UNTIL=${toIcalUtc(localToUtc(tz, l))}`);
      else if (tz === "Etc/UTC") parts.push(`UNTIL=${toIcalLocal(l)}Z`);
      else parts.push(`UNTIL=${toIcalLocal(l)}`);
    }
  }
  const byDay = r.byDay as Array<JsonObject | string> | null | undefined;
  if (byDay && byDay.length) {
    parts.push(
      "BYDAY=" +
        byDay
          .map((d) => {
            if (typeof d === "string") return DAY_REVERSE[d.toLowerCase()] ?? d.toUpperCase();
            const day = DAY_REVERSE[String(d.day ?? "").toLowerCase()] ?? String(d.day ?? "").toUpperCase();
            const nth = typeof d.nthOfPeriod === "number" && d.nthOfPeriod !== 0 ? String(d.nthOfPeriod) : "";
            return `${nth}${day}`;
          })
          .join(","),
    );
  }
  const list = (k: string, name: string) => {
    const v = r[k] as unknown[] | null | undefined;
    if (v && v.length) parts.push(`${name}=${v.map((x) => String(x)).join(",")}`);
  };
  list("byMonthDay", "BYMONTHDAY");
  list("byMonth", "BYMONTH");
  list("byYearDay", "BYYEARDAY");
  list("byWeekNo", "BYWEEKNO");
  list("byHour", "BYHOUR");
  list("byMinute", "BYMINUTE");
  list("bySecond", "BYSECOND");
  list("bySetPosition", "BYSETPOS");
  if (typeof r.firstDayOfWeek === "string" && r.firstDayOfWeek.toLowerCase() !== "mo") {
    parts.push(`WKST=${DAY_REVERSE[r.firstDayOfWeek.toLowerCase()] ?? "MO"}`);
  }
  return ICAL.Recur.fromString(parts.join(";"));
}

// -- derived fields -----------------------------------------------------------

/**
 * utcStart / utcEnd for an event: zoned events convert through their zone,
 * floating ones through `fallbackTz` (the request's timeZone, else UTC).
 */
export function utcBounds(ev: JsonObject, fallbackTz: string | null): { utcStart: string | null; utcEnd: string | null } {
  const start = parseLocal(String(ev.start ?? ""));
  if (!start) return { utcStart: null, utcEnd: null };
  const tz = typeof ev.timeZone === "string" && isValidTimeZone(ev.timeZone) ? ev.timeZone : fallbackTz && isValidTimeZone(fallbackTz) ? fallbackTz : "UTC";
  const startMs = localToUtc(tz, start);
  const secs = isoToSeconds(String(ev.duration ?? (ev.showWithoutTime ? "P1D" : "PT0S")));
  const endLocal = addSeconds(start, secs);
  const endMs = localToUtc(tz, endLocal);
  return { utcStart: formatUtc(startMs), utcEnd: formatUtc(endMs) };
}

function addSeconds(l: LocalParts, secs: number): LocalParts {
  const d = new Date(Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) + secs * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}
