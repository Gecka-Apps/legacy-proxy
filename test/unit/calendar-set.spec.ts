// Calendar/* and CalendarEvent/* against an in-memory fake CalDAV server
// bolted onto globalThis.fetch, mirroring contacts-set.spec.ts. The fake
// answers PROPFIND / REPORT (multiget + time-range query) / PUT / DELETE /
// MKCALENDAR / PROPPATCH the way Radicale does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calendarGet,
  calendarSet,
  calendarEventGet,
  calendarEventQuery,
  calendarEventSet,
  calendarEventParse,
  participantIdentityGet,
  calendarId,
  eventId,
  type CalendarCtx,
} from "../../src/jmap/methods/calendar.js";
import type { AccountRow, Store } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";
import { resetCalDavCaches } from "../../src/caldav/client.js";

// SMTP submission is mocked: the iMIP tests only need to see what would go out.
const sent: Array<{ envelopeFrom: string; rcptTo: string[]; raw: Buffer }> = [];
vi.mock("../../src/smtp/submit.js", () => ({
  submit: vi.fn(async (o: { envelopeFrom: string; rcptTo: string[]; raw: Buffer }) => {
    sent.push(o);
    return { messageId: "<m>", envelope: { from: o.envelopeFrom, to: o.rcptTo }, accepted: o.rcptTo, rejected: [], response: "250 ok" };
  }),
}));

interface Resource {
  data: string;
  etag: string;
}
interface Cal {
  displayName: string;
  description: string | null;
  color: string | null;
  components: string[];
  resources: Map<string, Resource>;
}

const HOME = "/cals/u/";
const PRINCIPAL = "/principals/u/";

class FakeDav {
  cals = new Map<string, Cal>();
  calls: Array<{ method: string; path: string; body: string }> = [];
  private etagSeq = 0;

  addCalendar(slug: string, displayName: string, items: Array<[string, string]> = [], components = ["VEVENT"]): string {
    const href = `${HOME}${slug}/`;
    const cal: Cal = { displayName, description: null, color: null, components, resources: new Map() };
    for (const [file, data] of items) cal.resources.set(href + file, { data, etag: this.nextEtag() });
    this.cals.set(href, cal);
    return href;
  }

  nextEtag(): string {
    return `"e${++this.etagSeq}"`;
  }

  handle(method: string, url: string, headers: Record<string, string>, body: string): Response {
    const path = decodeURIComponent(new URL(url).pathname);
    this.calls.push({ method, path, body });
    if (headers["authorization"] !== "Basic " + Buffer.from("u:p").toString("base64")) return new Response("nope", { status: 401 });
    switch (method) {
      case "PROPFIND":
        return this.propfind(path, headers["depth"] ?? "0");
      case "REPORT":
        return this.report(path, body);
      case "PUT":
        return this.put(path, headers, body);
      case "DELETE":
        return this.delete(path);
      case "MKCALENDAR":
        return this.mkcalendar(path, body);
      case "PROPPATCH":
        return this.proppatch(path, body);
    }
    return new Response("method", { status: 405 });
  }

  private ms(responses: string): Response {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">${responses}</D:multistatus>`;
    return new Response(xml, { status: 207, headers: { "content-type": "application/xml" } });
  }

  private calResponse(href: string, c: Cal): string {
    const ctag = Array.from(c.resources.values()).map((r) => r.etag).join("");
    return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <D:displayname>${esc(c.displayName)}</D:displayname>
      ${c.description ? `<C:calendar-description>${esc(c.description)}</C:calendar-description>` : ""}
      ${c.color ? `<A:calendar-color>${esc(c.color)}</A:calendar-color>` : ""}
      <C:supported-calendar-component-set>${c.components.map((x) => `<C:comp name="${x}"/>`).join("")}</C:supported-calendar-component-set>
      <CS:getctag>"${esc(ctag)}"</CS:getctag>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }

  private propfind(path: string, depth: string): Response {
    if (path === "/") {
      return this.ms(`<D:response><D:href>/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype>
        <D:current-user-principal><D:href>${PRINCIPAL}</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    if (path === PRINCIPAL) {
      return this.ms(`<D:response><D:href>${PRINCIPAL}</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>${HOME}</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    if (path === HOME) {
      const self = `<D:response><D:href>${HOME}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      if (depth === "0") return this.ms(self);
      return this.ms(self + Array.from(this.cals.entries()).map(([h, c]) => this.calResponse(h, c)).join(""));
    }
    const cal = this.cals.get(path);
    if (cal) {
      let out = this.calResponse(path, cal);
      if (depth === "1") {
        for (const [h, r] of cal.resources) {
          out += `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:resourcetype/><D:getetag>${esc(r.etag)}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
        }
      }
      return this.ms(out);
    }
    return new Response("not found", { status: 404 });
  }

  private report(path: string, body: string): Response {
    const cal = this.cals.get(path);
    if (!cal) return new Response("not found", { status: 404 });
    let out = "";
    if (/calendar-query/.test(body)) {
      // Time-range filter: a crude overlap test on DTSTART only, enough for
      // the handler tests (real servers expand recurrences here).
      const m = /time-range start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"/.exec(body);
      for (const [h, r] of cal.resources) {
        if (!/BEGIN:VEVENT/.test(r.data)) continue;
        const ds = /DTSTART[^:]*:(\d{8}T\d{6})/.exec(r.data)?.[1];
        if (m && ds && (ds + "Z" < m[1]! || ds + "Z" >= m[2]!) && !/RRULE/.test(r.data)) continue;
        out += `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>${esc(r.etag)}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      }
      return this.ms(out);
    }
    const hrefs = Array.from(body.matchAll(/<D:href>([^<]+)<\/D:href>/g)).map((x) => x[1]!);
    for (const h of hrefs) {
      const r = cal.resources.get(h);
      if (!r) {
        out += `<D:response><D:href>${h}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
        continue;
      }
      out += `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>${esc(r.etag)}</D:getetag><C:calendar-data>${esc(r.data)}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    }
    return this.ms(out);
  }

  private calFor(resourcePath: string): Cal | null {
    for (const [h, c] of this.cals) if (resourcePath.startsWith(h)) return c;
    return null;
  }

  private put(path: string, headers: Record<string, string>, body: string): Response {
    const cal = this.calFor(path);
    if (!cal) return new Response("no such collection", { status: 409 });
    const existing = cal.resources.get(path);
    if (headers["if-none-match"] === "*" && existing) return new Response("exists", { status: 412 });
    if (headers["if-match"] && (!existing || existing.etag !== headers["if-match"])) return new Response("etag mismatch", { status: 412 });
    if (!/^text\/calendar/.test(headers["content-type"] ?? "")) return new Response("type", { status: 415 });
    if (!/BEGIN:VCALENDAR/.test(body) || !/\r\nUID:/.test(body)) return new Response("bad ics", { status: 400 });
    const etag = this.nextEtag();
    cal.resources.set(path, { data: body, etag });
    return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
  }

  private delete(path: string): Response {
    if (this.cals.has(path)) {
      this.cals.delete(path);
      return new Response(null, { status: 204 });
    }
    const cal = this.calFor(path);
    if (!cal || !cal.resources.has(path)) return new Response("not found", { status: 404 });
    cal.resources.delete(path);
    return new Response(null, { status: 204 });
  }

  private mkcalendar(path: string, body: string): Response {
    if (this.cals.has(path)) return new Response("exists", { status: 405 });
    if (!path.startsWith(HOME)) return new Response("conflict", { status: 409 });
    const name = /<D:displayname>([^<]*)<\/D:displayname>/.exec(body)?.[1] ?? "";
    const color = /<A:calendar-color>([^<]*)<\/A:calendar-color>/.exec(body)?.[1] ?? null;
    const comps = Array.from(body.matchAll(/<C:comp name="([A-Z]+)"\/>/g)).map((m) => m[1]!);
    this.cals.set(path, { displayName: unesc(name), description: null, color, components: comps, resources: new Map() });
    return new Response(null, { status: 201 });
  }

  private proppatch(path: string, body: string): Response {
    const cal = this.cals.get(path);
    if (!cal) return new Response("not found", { status: 404 });
    const name = /<D:displayname>([^<]*)<\/D:displayname>/.exec(body)?.[1];
    if (name !== undefined) cal.displayName = unesc(name);
    const color = /<A:calendar-color>([^<]*)<\/A:calendar-color>/.exec(body)?.[1];
    if (color !== undefined) cal.color = unesc(color);
    if (/<D:remove>[\s\S]*calendar-color/.test(body)) cal.color = null;
    return this.ms(`<D:response><D:href>${path}</D:href><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unesc(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// -- fixtures -----------------------------------------------------------------

const provider: ProviderConfig = {
  imap: { host: "imap.test", port: 993 },
  smtp: { host: "smtp.test", port: 465 },
  sieve: null,
  carddav: null,
  caldav: { host: "dav.test", port: 443, secure: true, basePath: "/" },
  auth: { mech: ["PLAIN"] },
};

function fakeStore() {
  const prefs = new Map<string, unknown>();
  const uploads = new Map<string, Buffer>();
  return {
    uploads,
    getPref: (_a: number, k: string) => prefs.get(k) ?? null,
    setPref: (_a: number, k: string, v: unknown) => prefs.set(k, v),
    deletePref: (_a: number, k: string) => prefs.delete(k),
    getUpload: (id: string) => (uploads.has(id) ? { ctype: "text/calendar", body: uploads.get(id)! } : null),
    getCachedBlob: () => null,
    getIdentitySettings: () => ({ displayName: "Me", replyTo: null, textSignature: null, htmlSignature: null }),
    getState: () => 0,
    bumpState: () => 1,
  } as unknown as Store & { uploads: Map<string, Buffer> };
}

const MEETING = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:meeting-1",
  "DTSTAMP:20250101T000000Z",
  "DTSTART;TZID=Europe/Paris:20250603T090000",
  "DTEND;TZID=Europe/Paris:20250603T100000",
  "SUMMARY:Standup",
  "X-KEEP-ME:yes",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const WEEKLY = MEETING.replace("UID:meeting-1", "UID:weekly-1").replace("SUMMARY:Standup", "SUMMARY:Weekly\r\nRRULE:FREQ=WEEKLY").replace("20250603", "20250101");

let dav: FakeDav;
let store: ReturnType<typeof fakeStore>;
let ctx: CalendarCtx;

beforeEach(() => {
  resetCalDavCaches();
  sent.length = 0;
  dav = new FakeDav();
  store = fakeStore();
  ctx = { account: { id: 7, username: "u@x.io", host: "x.io", kind: "generic" } as AccountRow, provider, creds: { mech: "PLAIN", username: "u", password: "p" }, store };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const body = typeof init?.body === "string" ? init.body : Buffer.isBuffer(init?.body) ? init!.body.toString("utf8") : "";
      return dav.handle(init?.method ?? "GET", url, headers, body);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("Calendar/get + set", () => {
  it("lists calendars with DAV props and proxy-held prefs", async () => {
    const href = dav.addCalendar("work", "Work");
    dav.cals.get(href)!.color = "#ff0000ff";
    const r = await calendarGet({ accountId: "7", ids: null }, ctx);
    expect(r.list).toHaveLength(1);
    expect(r.list[0]).toMatchObject({ id: calendarId(href), name: "Work", color: "#ff0000", isDefault: true, isVisible: true, myRights: { mayWriteAll: true } });

    const u = await calendarSet({ accountId: "7", update: { [calendarId(href)]: { name: "Boulot", color: "#00ff00", isVisible: false, sortOrder: 3 } } }, ctx);
    expect(u.notUpdated).toBeNull();
    expect(dav.cals.get(href)).toMatchObject({ displayName: "Boulot", color: "#00ff00" });
    const again = await calendarGet({ accountId: "7", ids: null }, ctx);
    expect(again.list[0]).toMatchObject({ name: "Boulot", isVisible: false, sortOrder: 3 });
  });

  it("creates with MKCALENDAR, refuses to destroy a non-empty calendar, hides VTODO-only ones", async () => {
    dav.addCalendar("tasks", "Tasks", [], ["VTODO"]);
    const c = await calendarSet({ accountId: "7", create: { n: { name: "Perso", color: "#123456" } } }, ctx);
    expect(c.notCreated).toBeNull();
    const id = c.created!.n.id as string;
    expect(dav.cals.get(`${HOME}perso/`)).toMatchObject({ displayName: "Perso", components: ["VEVENT"] });
    const list = await calendarGet({ accountId: "7", ids: null }, ctx);
    expect(list.list.map((x) => x.name)).toEqual(["Perso"]);

    await calendarEventSet({ accountId: "7", create: { e: { calendarIds: { [id]: true }, title: "x", start: "2025-01-01T10:00:00", duration: "PT1H", timeZone: "Europe/Paris" } } }, ctx);
    const d = await calendarSet({ accountId: "7", destroy: [id] }, ctx);
    expect(d.notDestroyed?.[id]).toMatchObject({ type: "calendarHasEvents" });
    const d2 = await calendarSet({ accountId: "7", destroy: [id], onDestroyRemoveEvents: true }, ctx);
    expect(d2.destroyed).toEqual([id]);
  });
});

describe("default calendar", () => {
  const EVENT = { title: "x", start: "2025-01-01T10:00:00", duration: "PT1H", timeZone: "Europe/Paris" };

  it("is the `calendar` collection whatever order the server lists them in", async () => {
    dav.addCalendar("work", "Work");
    dav.addCalendar("calendar", "Personnel");
    const r = await calendarGet({ accountId: "7", ids: null }, ctx);
    expect(r.list.map((c) => [c.name, c.isDefault])).toEqual([
      ["Work", false],
      ["Personnel", true],
    ]);
  });

  it("is `personal` on nextcloud and `default` on stalwart", async () => {
    dav.addCalendar("calendar", "Calendar");
    dav.addCalendar("personal", "Personal");
    dav.addCalendar("default", "Stalwart Calendar");
    const on = (flavor: "nextcloud" | "stalwart") => ({ ...ctx, provider: { ...provider, caldav: { ...provider.caldav!, flavor } } });
    expect((await calendarGet({ accountId: "7", ids: null }, ctx)).list.find((c) => c.isDefault)?.name).toBe("Calendar");
    expect((await calendarGet({ accountId: "7", ids: null }, on("nextcloud"))).list.find((c) => c.isDefault)?.name).toBe("Personal");
    expect((await calendarGet({ accountId: "7", ids: null }, on("stalwart"))).list.find((c) => c.isDefault)?.name).toBe("Stalwart Calendar");
  });

  it("falls back to the first href in sorted order, never a VTODO-only collection", async () => {
    dav.addCalendar("zeta", "Zeta");
    dav.addCalendar("alpha", "Alpha");
    dav.addCalendar("aaa-tasks", "Tasks", [], ["VTODO"]);
    const r = await calendarGet({ accountId: "7", ids: null }, ctx);
    expect(r.list.find((c) => c.isDefault)?.name).toBe("Alpha");
  });

  it("follows onSuccessSetIsDefault across requests and is where events without calendarIds land", async () => {
    const personal = dav.addCalendar("calendar", "Personnel");
    const work = dav.addCalendar("work", "Work");
    const r = await calendarSet({ accountId: "7", onSuccessSetIsDefault: calendarId(work) }, ctx);
    expect(r.updated).toEqual({ [calendarId(work)]: { isDefault: true }, [calendarId(personal)]: { isDefault: false } });

    const list = await calendarGet({ accountId: "7", ids: null }, ctx);
    expect(list.list.find((c) => c.isDefault)?.name).toBe("Work");

    const e = await calendarEventSet({ accountId: "7", create: { e: EVENT } }, ctx);
    expect(e.notCreated).toBeNull();
    expect(dav.cals.get(work)!.resources.size).toBe(1);
    expect(dav.cals.get(personal)!.resources.size).toBe(0);
  });

  it("resolves a creation reference and flags the new calendar in `created`", async () => {
    const personal = dav.addCalendar("calendar", "Personnel");
    const r = await calendarSet({ accountId: "7", create: { n: { name: "Family" } }, onSuccessSetIsDefault: "#n" }, ctx);
    expect(r.created?.["n"]?.isDefault).toBe(true);
    expect(r.updated).toEqual({ [calendarId(personal)]: { isDefault: false } });
    const list = await calendarGet({ accountId: "7", ids: null }, ctx);
    expect(list.list.find((c) => c.isDefault)?.name).toBe("Family");
  });

  it("ignores an unknown id, skips the change when a write failed, drops back once the chosen calendar is gone", async () => {
    dav.addCalendar("calendar", "Personnel");
    const work = dav.addCalendar("work", "Work");

    const unknown = await calendarSet({ accountId: "7", onSuccessSetIsDefault: calendarId(`${HOME}nope/`) }, ctx);
    expect(unknown.updated).toBeNull();

    const failed = await calendarSet({ accountId: "7", create: { x: { name: " " } }, onSuccessSetIsDefault: calendarId(work) }, ctx);
    expect(failed.notCreated?.["x"]).toBeDefined();
    expect(failed.updated).toBeNull();
    expect((await calendarGet({ accountId: "7", ids: null }, ctx)).list.find((c) => c.isDefault)?.name).toBe("Personnel");

    await calendarSet({ accountId: "7", onSuccessSetIsDefault: calendarId(work) }, ctx);
    await calendarSet({ accountId: "7", destroy: [calendarId(work)] }, ctx);
    expect((await calendarGet({ accountId: "7", ids: null }, ctx)).list.map((c) => [c.name, c.isDefault])).toEqual([["Personnel", true]]);
  });
});

describe("CalendarEvent/get + query", () => {
  it("returns parsed events with ids, calendarIds and UTC bounds", async () => {
    const href = dav.addCalendar("work", "Work", [["m.ics", MEETING]]);
    const r = await calendarEventGet({ accountId: "7", ids: null, timeZone: "Europe/Paris" }, ctx);
    expect(r.list).toHaveLength(1);
    expect(r.list[0]).toMatchObject({
      id: eventId(href, `${href}m.ics`),
      calendarIds: { [calendarId(href)]: true },
      title: "Standup",
      start: "2025-06-03T09:00:00",
      timeZone: "Europe/Paris",
      utcStart: "2025-06-03T07:00:00Z",
      utcEnd: "2025-06-03T08:00:00Z",
      isOrigin: true,
    });
    const projected = await calendarEventGet({ accountId: "7", ids: [r.list[0]!.id as string], properties: ["title"] }, ctx);
    expect(projected.list[0]).toEqual({ id: r.list[0]!.id, title: "Standup" });
    expect((await calendarEventGet({ accountId: "7", ids: ["nope"] }, ctx)).notFound).toEqual(["nope"]);
  });

  it("uses a time-range REPORT when the filter has bounds and keeps recurring masters", async () => {
    const href = dav.addCalendar("work", "Work", [["m.ics", MEETING], ["w.ics", WEEKLY]]);
    const inRange = await calendarEventQuery({ accountId: "7", filter: { inCalendar: calendarId(href), after: "2025-06-01T00:00:00", before: "2025-06-30T00:00:00" }, timeZone: "Europe/Paris" }, ctx);
    expect(inRange.ids.sort()).toEqual([eventId(href, `${href}m.ics`), eventId(href, `${href}w.ics`)].sort());
    expect(dav.calls.some((c) => c.method === "REPORT" && /time-range start="20250531T220000Z"/.test(c.body))).toBe(true);

    const outOfRange = await calendarEventQuery({ accountId: "7", filter: { operator: "OR", conditions: [{ inCalendar: calendarId(href) }], after: "2025-09-01T00:00:00", before: "2025-09-30T00:00:00" } }, ctx);
    expect(outOfRange.ids).toEqual([eventId(href, `${href}w.ics`)]);

    const byUid = await calendarEventQuery({ accountId: "7", filter: { uid: "weekly-1" } }, ctx);
    expect(byUid.ids).toEqual([eventId(href, `${href}w.ics`)]);
    const sorted = await calendarEventQuery({ accountId: "7", sort: [{ property: "start", isAscending: false }] }, ctx);
    expect(sorted.ids).toEqual([eventId(href, `${href}m.ics`), eventId(href, `${href}w.ics`)]);
  });
});

describe("CalendarEvent/set", () => {
  it("creates in the default calendar (creating one on an empty account)", async () => {
    const r = await calendarEventSet({ accountId: "7", create: { n: { "@type": "Event", title: "Lunch", start: "2025-06-03T12:00:00", duration: "PT1H", timeZone: "Pacific/Noumea", showWithoutTime: false } } }, ctx);
    expect(r.notCreated).toBeNull();
    expect(dav.cals.get(`${HOME}calendar/`)?.displayName).toBe("Calendar");
    const stored = [...dav.cals.get(`${HOME}calendar/`)!.resources.values()][0]!.data;
    expect(stored).toContain("SUMMARY:Lunch");
    expect(stored).toContain("DTSTART;TZID=Pacific/Noumea:20250603T120000");
    expect(stored).toContain("TZID:Pacific/Noumea");
    expect(r.created!.n).toMatchObject({ utcStart: "2025-06-03T01:00:00Z", utcEnd: "2025-06-03T02:00:00Z" });
    const got = await calendarEventGet({ accountId: "7", ids: [r.created!.n.id as string] }, ctx);
    expect(got.list[0]).toMatchObject({ title: "Lunch", uid: r.created!.n.uid });
  });

  it("updates with If-Match, bumps SEQUENCE and preserves unmodeled properties", async () => {
    const href = dav.addCalendar("work", "Work", [["m.ics", MEETING]]);
    const id = eventId(href, `${href}m.ics`);
    const r = await calendarEventSet({ accountId: "7", update: { [id]: { title: "Standup (moved)", start: "2025-06-03T10:00:00", duration: "PT30M", timeZone: "Europe/Paris", calendarIds: { [calendarId(href)]: true }, uid: "meeting-1" } } }, ctx);
    expect(r.notUpdated).toBeNull();
    expect(r.updated).toEqual({ [id]: null });
    const put = dav.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toContain("SUMMARY:Standup (moved)");
    expect(put.body).toContain("DTSTART;TZID=Europe/Paris:20250603T100000");
    expect(put.body).toContain("DURATION:PT30M");
    expect(put.body).toContain("SEQUENCE:1");
    expect(put.body).toContain("X-KEEP-ME:yes");
    expect(put.body).toContain("UID:meeting-1");
  });

  it("rejects moves between calendars and answers the synthetic-id probe with invalidProperties", async () => {
    const a = dav.addCalendar("a", "A", [["m.ics", MEETING]]);
    const b = dav.addCalendar("b", "B");
    const id = eventId(a, `${a}m.ics`);
    const r = await calendarEventSet({ accountId: "7", update: { [id]: { calendarIds: { [calendarId(b)]: true } }, h333333: {} } }, ctx);
    expect(r.notUpdated?.[id]).toMatchObject({ type: "invalidProperties", properties: ["calendarIds"] });
    expect(r.notUpdated?.h333333).toMatchObject({ type: "invalidProperties" });
  });

  it("destroys resources", async () => {
    const href = dav.addCalendar("work", "Work", [["m.ics", MEETING]]);
    const id = eventId(href, `${href}m.ics`);
    const r = await calendarEventSet({ accountId: "7", destroy: [id, "bogus"] }, ctx);
    expect(r.destroyed).toEqual([id]);
    expect(r.notDestroyed?.bogus).toMatchObject({ type: "notFound" });
    expect(dav.cals.get(href)!.resources.size).toBe(0);
  });
});

describe("CalendarEvent/set scheduling", () => {
  const withBob = {
    "@type": "Event",
    title: "Kickoff",
    start: "2025-06-03T14:00:00",
    duration: "PT1H",
    timeZone: "Europe/Paris",
    replyTo: { imip: "mailto:u@x.io" },
    participants: {
      me: { "@type": "Participant", email: "u@x.io", roles: { owner: true, attendee: true }, participationStatus: "accepted" },
      bob: { "@type": "Participant", email: "bob@x.io", roles: { attendee: true }, participationStatus: "needs-action", expectReply: true },
    },
  };

  it("mails a REQUEST on create and a CANCEL on destroy when asked to", async () => {
    dav.addCalendar("work", "Work");
    const r = await calendarEventSet({ accountId: "7", create: { n: withBob }, sendSchedulingMessages: true }, ctx);
    expect(r.notCreated).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ envelopeFrom: "u@x.io", rcptTo: ["bob@x.io"] });
    const raw = sent[0]!.raw.toString("utf8");
    expect(raw).toContain("Subject: Invitation: Kickoff");
    expect(raw).toContain("From: Me <u@x.io>");
    expect(raw).toContain("method=REQUEST");
    expect(raw).toContain("METHOD:REQUEST");
    expect(raw).toContain("ATTENDEE;PARTSTAT=ACCEPTED:mailto:u@x.io");
    expect(raw).toContain("ATTENDEE;RSVP=TRUE:mailto:bob@x.io");

    sent.length = 0;
    const d = await calendarEventSet({ accountId: "7", destroy: [r.created!.n.id as string], sendSchedulingMessages: true }, ctx);
    expect(d.destroyed).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.raw.toString("utf8")).toContain("METHOD:CANCEL");
    expect(sent[0]!.raw.toString("utf8")).toContain("STATUS:CANCELLED");
  });

  it("stays silent without sendSchedulingMessages", async () => {
    dav.addCalendar("work", "Work");
    await calendarEventSet({ accountId: "7", create: { n: withBob } }, ctx);
    expect(sent).toHaveLength(0);
  });
});

describe("CalendarEvent/parse + ParticipantIdentity", () => {
  it("parses an uploaded invitation", async () => {
    store.uploads.set("U1", Buffer.from(MEETING.replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:REQUEST")));
    const r = await calendarEventParse({ accountId: "7", blobIds: ["U1", "U2"], timeZone: "Europe/Paris" }, ctx);
    expect(r.notFound).toEqual(["U2"]);
    expect(r.parsed.U1?.[0]).toMatchObject({ uid: "meeting-1", title: "Standup", method: "REQUEST", utcStart: "2025-06-03T07:00:00Z" });
  });

  it("derives the single identity from the login", async () => {
    const r = await participantIdentityGet({ accountId: "7" }, ctx);
    expect(r.list).toEqual([{ id: "primary", name: "", calendarAddress: "mailto:u@x.io", isDefault: true }]);
  });
});
