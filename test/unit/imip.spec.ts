import { describe, expect, it } from "vitest";
import { planScheduling } from "../../src/caldav/imip.js";
import type { JsonObject } from "../../src/caldav/jscalendar.js";

const ME = "me@x.io";

function event(over: Partial<JsonObject> = {}): JsonObject {
  return {
    uid: "u1",
    title: "Sync",
    start: "2025-06-03T09:00:00",
    duration: "PT1H",
    timeZone: "Europe/Paris",
    replyTo: { imip: "mailto:me@x.io" },
    participants: {
      a: { "@type": "Participant", email: "me@x.io", roles: { owner: true, attendee: true }, participationStatus: "accepted" },
      b: { "@type": "Participant", email: "bob@x.io", roles: { attendee: true }, participationStatus: "needs-action" },
      c: { "@type": "Participant", email: "carol@x.io", roles: { optional: true }, participationStatus: "needs-action", scheduleAgent: "client" },
    },
    ...over,
  };
}

describe("planScheduling", () => {
  it("sends REQUEST to server-scheduled attendees on create", () => {
    const plan = planScheduling({ me: ME, before: null, after: event() });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ method: "REQUEST", to: ["bob@x.io"], subject: "Invitation: Sync" });
  });

  it("sends REQUEST to current attendees and CANCEL to dropped ones on update", () => {
    const before = event();
    const after = event({
      participants: {
        a: { "@type": "Participant", email: "me@x.io", roles: { owner: true, attendee: true } },
        d: { "@type": "Participant", email: "dave@x.io", roles: { attendee: true } },
      },
    });
    const plan = planScheduling({ me: ME, before, after });
    expect(plan.map((m) => [m.method, m.to])).toEqual([
      ["REQUEST", ["dave@x.io"]],
      ["CANCEL", ["bob@x.io"]],
    ]);
    expect(plan[1]!.event).toMatchObject({ status: "cancelled", sequence: 1 });
  });

  it("sends CANCEL to everyone on destroy", () => {
    const plan = planScheduling({ me: ME, before: event(), after: null });
    expect(plan).toEqual([expect.objectContaining({ method: "CANCEL", to: ["bob@x.io"] })]);
  });

  it("replies to the organizer when our own status changes", () => {
    const invite = event({
      replyTo: { imip: "mailto:alice@x.io" },
      participants: {
        o: { "@type": "Participant", email: "alice@x.io", roles: { owner: true } },
        m: { "@type": "Participant", email: "me@x.io", roles: { attendee: true }, participationStatus: "needs-action" },
        b: { "@type": "Participant", email: "bob@x.io", roles: { attendee: true }, participationStatus: "needs-action" },
      },
    });
    expect(planScheduling({ me: ME, before: null, after: invite })).toEqual([]);
    const accepted = structuredClone(invite);
    (accepted.participants as Record<string, JsonObject>).m!.participationStatus = "accepted";
    const plan = planScheduling({ me: ME, before: invite, after: accepted });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ method: "REPLY", to: ["alice@x.io"], subject: "Accepted: Sync" });
    // The reply carries only us and the organizer.
    expect(Object.keys(plan[0]!.event.participants as object)).toEqual(["o", "m"]);
  });

  it("does nothing without an organizer", () => {
    expect(planScheduling({ me: ME, before: null, after: { uid: "x", start: "2025-01-01T00:00:00" } })).toEqual([]);
  });
});
