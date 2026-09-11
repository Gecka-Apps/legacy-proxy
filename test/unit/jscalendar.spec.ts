import { describe, expect, it } from "vitest";
import { isoToSeconds, parseICalendar, secondsToIso, serializeEvent, utcBounds } from "../../src/caldav/jscalendar.js";
import { buildVTimezone, localToUtc, offsetMinutes } from "../../src/caldav/tz.js";

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//x//y//EN
BEGIN:VEVENT
UID:abc
DTSTAMP:20250101T000000Z
CREATED:20240101T000000Z
DTSTART;TZID=Europe/Paris:20250601T100000
DTEND;TZID=Europe/Paris:20250601T113000
SUMMARY:Réunion
DESCRIPTION:Ordre du jour\\nPoint 1
LOCATION:Salle A
CATEGORIES:Work,Team
CLASS:PRIVATE
TRANSP:TRANSPARENT
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20250701T080000Z
EXDATE;TZID=Europe/Paris:20250609T100000
ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:bob@x.io
ATTENDEE;CN=Room;CUTYPE=ROOM;PARTSTAT=NEEDS-ACTION:mailto:room@x.io
ORGANIZER;CN=Me:mailto:me@x.io
X-FOO:bar
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:reminder
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:abc
RECURRENCE-ID;TZID=Europe/Paris:20250611T100000
DTSTART;TZID=Europe/Paris:20250611T140000
DTEND;TZID=Europe/Paris:20250611T150000
SUMMARY:Réunion décalée
LOCATION:Salle A
ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:bob@x.io
ATTENDEE;CN=Room;CUTYPE=ROOM;PARTSTAT=NEEDS-ACTION:mailto:room@x.io
ORGANIZER;CN=Me:mailto:me@x.io
END:VEVENT
END:VCALENDAR`;

describe("iCalendar → JSCalendar", () => {
  const ev = parseICalendar(ICS).events[0]!;

  it("maps the scalar properties", () => {
    expect(ev).toMatchObject({
      uid: "abc",
      title: "Réunion",
      description: "Ordre du jour\nPoint 1",
      start: "2025-06-01T10:00:00",
      duration: "PT1H30M",
      timeZone: "Europe/Paris",
      showWithoutTime: false,
      privacy: "private",
      freeBusyStatus: "free",
      created: "2024-01-01T00:00:00Z",
      keywords: { Work: true, Team: true },
      locations: { "1": { "@type": "Location", name: "Salle A" } },
    });
  });

  it("converts a UTC UNTIL into the event's zone", () => {
    expect(ev.recurrenceRules).toEqual([
      { "@type": "RecurrenceRule", frequency: "weekly", until: "2025-07-01T10:00:00", byDay: [{ "@type": "NDay", day: "mo" }, { "@type": "NDay", day: "we" }] },
    ]);
  });

  it("folds EXDATE and RECURRENCE-ID overrides into recurrenceOverrides", () => {
    expect(ev.recurrenceOverrides?.["2025-06-09T10:00:00"]).toEqual({ excluded: true });
    expect(ev.recurrenceOverrides?.["2025-06-11T10:00:00"]).toMatchObject({ title: "Réunion décalée", start: "2025-06-11T14:00:00", duration: "PT1H" });
    // Unchanged properties are not repeated in the patch.
    expect(ev.recurrenceOverrides?.["2025-06-11T10:00:00"]).not.toHaveProperty("locations");
  });

  it("maps organizer and attendees to participants", () => {
    const parts = Object.values(ev.participants!);
    expect(parts).toHaveLength(3);
    expect(parts.find((p) => p.email === "me@x.io")).toMatchObject({ roles: { owner: true }, name: "Me" });
    expect(parts.find((p) => p.email === "bob@x.io")).toMatchObject({ roles: { attendee: true }, participationStatus: "accepted", expectReply: true });
    expect(parts.find((p) => p.email === "room@x.io")).toMatchObject({ kind: "location", participationStatus: "needs-action" });
    expect(ev.replyTo).toEqual({ imip: "mailto:me@x.io" });
  });

  it("maps VALARM to an offset alert", () => {
    expect(ev.alerts).toEqual({ "1": { "@type": "Alert", trigger: { "@type": "OffsetTrigger", offset: "-PT15M", relativeTo: "start" }, action: "display" } });
  });

  it("computes utcStart/utcEnd through the zone", () => {
    expect(utcBounds(ev, null)).toEqual({ utcStart: "2025-06-01T08:00:00Z", utcEnd: "2025-06-01T09:30:00Z" });
  });

  it("reads an all-day event", () => {
    const ad = parseICalendar("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:d\nDTSTART;VALUE=DATE:20250714\nDTEND;VALUE=DATE:20250716\nSUMMARY:Fête\nEND:VEVENT\nEND:VCALENDAR").events[0]!;
    expect(ad).toMatchObject({ start: "2025-07-14T00:00:00", duration: "P2D", showWithoutTime: true, timeZone: null });
    expect(utcBounds(ad, "Pacific/Noumea")).toEqual({ utcStart: "2025-07-13T13:00:00Z", utcEnd: "2025-07-15T13:00:00Z" });
  });

  it("treats a Z time as Etc/UTC and skips VTODOs", () => {
    const r = parseICalendar("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VTODO\nUID:t\nSUMMARY:x\nEND:VTODO\nBEGIN:VEVENT\nUID:u\nDTSTART:20250101T120000Z\nDURATION:PT1H\nEND:VEVENT\nEND:VCALENDAR");
    expect(r.skipped).toBe(1);
    expect(r.events[0]).toMatchObject({ uid: "u", timeZone: "Etc/UTC", start: "2025-01-01T12:00:00" });
  });

  it("maps Outlook's Windows TZIDs to IANA zones", () => {
    const r = parseICalendar("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:w\nDTSTART;TZID=Romance Standard Time:20250601T100000\nDURATION:PT1H\nEND:VEVENT\nEND:VCALENDAR");
    expect(r.events[0]).toMatchObject({ timeZone: "Europe/Paris", start: "2025-06-01T10:00:00" });
    const u = parseICalendar("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:w\nDTSTART;TZID=\"(UTC+11:00) Noumea Standard Time\":20250601T100000\nDURATION:PT1H\nEND:VEVENT\nEND:VCALENDAR");
    expect(u.events[0]!.timeZone).toBeNull();
  });

  it("exposes a lone override as an event with recurrenceId", () => {
    const r = parseICalendar("BEGIN:VCALENDAR\nVERSION:2.0\nMETHOD:REQUEST\nBEGIN:VEVENT\nUID:u\nRECURRENCE-ID:20250105T120000Z\nDTSTART:20250105T130000Z\nDURATION:PT1H\nEND:VEVENT\nEND:VCALENDAR");
    expect(r.events[0]).toMatchObject({ recurrenceId: "2025-01-05T12:00:00", recurrenceIdTimeZone: "Etc/UTC", method: "REQUEST" });
  });
});

describe("JSCalendar → iCalendar", () => {
  it("round-trips the sample, preserving unmodeled properties", () => {
    const ev = parseICalendar(ICS).events[0]!;
    const out = serializeEvent(ev, { preserveFrom: ICS });
    expect(out).toContain("X-FOO:bar");
    expect(out).toContain("BEGIN:VTIMEZONE");
    expect(out).toContain("DTSTART;TZID=Europe/Paris:20250601T100000");
    expect(out).toContain("UNTIL=20250701T080000Z");
    expect(out).toContain("EXDATE;TZID=Europe/Paris:20250609T100000");
    expect(out).toContain("RECURRENCE-ID;TZID=Europe/Paris:20250611T100000");
    expect(out).toContain("CLASS:PRIVATE");
    expect(out).toContain("TRANSP:TRANSPARENT");
    const again = parseICalendar(out).events[0]!;
    const strip = (e: Record<string, unknown>) => {
      const c = { ...e };
      delete c.updated;
      return c;
    };
    expect(strip(again)).toEqual(strip(ev));
  });

  it("accepts Stalwart's singular recurrenceRule and writes all-day events as DATE", () => {
    const out = serializeEvent({
      uid: "d1",
      title: "Fête",
      start: "2025-07-14T00:00:00",
      duration: "P2D",
      showWithoutTime: true,
      timeZone: null,
      recurrenceRule: { frequency: "yearly", byMonth: ["7"], byMonthDay: [14] },
    });
    expect(out).toContain("DTSTART;VALUE=DATE:20250714");
    expect(out).toContain("DTEND;VALUE=DATE:20250716");
    expect(out).toContain("RRULE:FREQ=YEARLY;BYMONTHDAY=14;BYMONTH=7");
    expect(out).not.toContain("VTIMEZONE");
  });

  it("defaults an override's DTSTART to its recurrence id and omits a redundant start on read", () => {
    const out = serializeEvent({
      uid: "r",
      title: "Weekly",
      start: "2025-06-02T09:00:00",
      duration: "PT1H",
      timeZone: "Europe/Paris",
      recurrenceRules: [{ frequency: "weekly" }],
      recurrenceOverrides: { "2025-06-09T09:00:00": { title: "Renamed only" } },
    });
    const override = out.slice(out.lastIndexOf("BEGIN:VEVENT"));
    expect(override).toContain("DTSTART;TZID=Europe/Paris:20250609T090000");
    expect(override).toContain("RECURRENCE-ID;TZID=Europe/Paris:20250609T090000");
    expect(parseICalendar(out).events[0]!.recurrenceOverrides).toEqual({ "2025-06-09T09:00:00": { title: "Renamed only" } });
  });

  it("writes UNTIL as a DATE for all-day series and lets a singular recurrenceRule win over a stale plural", () => {
    const allDay = serializeEvent({ uid: "a", start: "2025-06-02T00:00:00", duration: "P1D", showWithoutTime: true, timeZone: null, recurrenceRules: [{ frequency: "daily", until: "2025-06-10T23:59:59" }] });
    expect(allDay).toContain("RRULE:FREQ=DAILY;UNTIL=20250610\r\n");
    const patched = serializeEvent({ uid: "s", start: "2025-06-02T09:00:00", duration: "PT1H", timeZone: null, recurrenceRules: [{ frequency: "weekly" }], recurrenceRule: { frequency: "daily" } });
    expect(patched).toContain("RRULE:FREQ=DAILY\r\n");
    const cleared = serializeEvent({ uid: "s", start: "2025-06-02T09:00:00", duration: "PT1H", timeZone: null, recurrenceRules: [{ frequency: "weekly" }], recurrenceRule: null });
    expect(cleared).not.toContain("RRULE");
  });

  it("writes a floating event without TZID and a UTC one with Z", () => {
    const floating = serializeEvent({ uid: "f", start: "2025-01-01T09:00:00", duration: "PT1H", timeZone: null });
    expect(floating).toContain("DTSTART:20250101T090000\r\n");
    const utc = serializeEvent({ uid: "z", start: "2025-01-01T09:00:00", duration: "PT1H", timeZone: "Etc/UTC" });
    expect(utc).toContain("DTSTART:20250101T090000Z");
  });

  it("emits ORGANIZER + ATTENDEE from participants and alerts as VALARM", () => {
    const out = serializeEvent({
      uid: "p",
      start: "2025-01-01T09:00:00",
      duration: "PT1H",
      timeZone: "Europe/Paris",
      replyTo: { imip: "mailto:me@x.io" },
      participants: {
        a: { "@type": "Participant", name: "Me", email: "me@x.io", roles: { owner: true, attendee: true }, participationStatus: "accepted" },
        b: { "@type": "Participant", name: "Bob", email: "bob@x.io", roles: { attendee: true, optional: true }, expectReply: true },
      },
      alerts: { x: { "@type": "Alert", action: "email", trigger: { "@type": "OffsetTrigger", offset: "-P1D", relativeTo: "end" } } },
    });
    expect(out).toContain("ORGANIZER;CN=Me:mailto:me@x.io");
    expect(out).toContain("ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@x.io");
    expect(out).toContain("ATTENDEE;CN=Bob;ROLE=OPT-PARTICIPANT;RSVP=TRUE:mailto:bob@x.io");
    expect(out).toContain("ACTION:EMAIL");
    expect(out).toContain("TRIGGER;RELATED=END:-P1D");
  });
});

describe("durations and zones", () => {
  it("converts ISO durations both ways", () => {
    expect(isoToSeconds("PT1H30M")).toBe(5400);
    expect(isoToSeconds("P1DT2H")).toBe(93600);
    expect(isoToSeconds("-PT15M")).toBe(-900);
    expect(secondsToIso(5400)).toBe("PT1H30M");
    expect(secondsToIso(86400 * 7, true)).toBe("P1W");
    expect(secondsToIso(0)).toBe("PT0S");
  });

  it("computes offsets and synthesises a VTIMEZONE", () => {
    expect(offsetMinutes("Europe/Paris", Date.UTC(2025, 6, 1))).toBe(120);
    expect(offsetMinutes("Europe/Paris", Date.UTC(2025, 0, 1))).toBe(60);
    expect(new Date(localToUtc("America/New_York", { year: 2025, month: 3, day: 9, hour: 12, minute: 30, second: 0 })).toISOString()).toBe("2025-03-09T16:30:00.000Z");
    const vtz = buildVTimezone("Europe/Paris", 2025, 2025);
    expect(vtz).toContain("TZID:Europe/Paris");
    expect(vtz).toContain("BEGIN:DAYLIGHT\r\nDTSTART:20250330T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200");
    expect(vtz).toContain("BEGIN:STANDARD\r\nDTSTART:20251026T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100");
    expect(buildVTimezone("Pacific/Noumea", 2025, 2025)).toContain("TZOFFSETTO:+1100");
  });
});
