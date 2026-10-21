// Contacts and calendars against a real Nextcloud, the nextcloud flavor end
// to end. Skipped unless NEXTCLOUD_HOST is set; the server needs the users
// alice and bob sharing the password in NEXTCLOUD_PASSWORD:
//
//   NEXTCLOUD_HOST=localhost NEXTCLOUD_PORT=8089 NEXTCLOUD_SECURE=0 NEXTCLOUD_PASSWORD=... \
//     npm run test:integration -- nextcloud.spec
//
// Every object a test creates carries RUN in its name or uid and is removed
// at the end, so the suite can run again on the same instance.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { addressBookGet, addressBookSet, contactCardGet, contactCardQuery, contactCardSet } from "../../src/jmap/methods/contacts.js";
import { calendarEventGet, calendarEventQuery, calendarEventSet, calendarGet, calendarSet } from "../../src/jmap/methods/calendar.js";
import { resetCalDavCaches } from "../../src/caldav/client.js";
import { resetCardDavCaches } from "../../src/carddav/client.js";
import type { AccountRow, Store } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

const HOST = process.env.NEXTCLOUD_HOST;
const PASSWORD = process.env.NEXTCLOUD_PASSWORD ?? "";
const RUN = `it${Date.now().toString(36)}`;

const dav = {
  host: HOST ?? "",
  port: Number(process.env.NEXTCLOUD_PORT ?? 443),
  secure: process.env.NEXTCLOUD_SECURE !== "0",
  basePath: "/remote.php/dav/",
  flavor: "nextcloud" as const,
};
const provider: ProviderConfig = {
  imap: { host: "imap.invalid", port: 993 },
  smtp: { host: "smtp.invalid", port: 465 },
  sieve: null,
  carddav: dav,
  caldav: dav,
  auth: { mech: ["PLAIN"] },
};

function store(): Store {
  const prefs = new Map<string, unknown>();
  return {
    getPref: (_a: number, k: string) => prefs.get(k) ?? null,
    setPref: (_a: number, k: string, v: unknown) => prefs.set(k, v),
    deletePref: (_a: number, k: string) => prefs.delete(k),
    getUpload: () => null,
    getCachedBlob: () => null,
    getIdentitySettings: () => ({ displayName: "Alice", replyTo: null, textSignature: null, htmlSignature: null }),
    getState: () => 0,
    bumpState: () => 1,
  } as unknown as Store;
}

function ctxFor(id: number, user: string) {
  return {
    account: { id, username: user, host: "nc", kind: "nextcloud" } as AccountRow,
    provider,
    creds: { mech: "PLAIN" as const, username: user, password: PASSWORD },
    store: store(),
  };
}

const alice = ctxFor(1, "alice");
const bob = ctxFor(2, "bob");

/** Raw DAV request as a user, for what Nextcloud's own UI would do. */
async function davAs(user: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  return fetch(`http${dav.secure ? "s" : ""}://${dav.host}:${dav.port}${path}`, {
    method,
    headers: { Authorization: "Basic " + Buffer.from(`${user}:${PASSWORD}`).toString("base64"), ...headers },
    ...(body ? { body } : {}),
  });
}

function hrefOf(id: string): string {
  return Buffer.from(id, "base64url").toString("utf8");
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(HOST ? describe : describe.skip)("main against a real Nextcloud", () => {
  beforeEach(() => {
    resetCalDavCaches();
    resetCardDavCaches();
  });

  describe("address books", () => {
    it("lists the user's books, Contacts as default and the server's Accounts read-only", async () => {
      const books = (await addressBookGet({ accountId: "1", ids: null }, alice)).list;
      const contacts = books.find((b) => b.name === "Contacts");
      const accounts = books.find((b) => b.name === "Accounts");
      expect(contacts).toMatchObject({ isDefault: true, myRights: { mayRead: true, mayWrite: true, mayShare: false } });
      expect(accounts).toMatchObject({ isDefault: false, myRights: { mayRead: true, mayWrite: false, mayDelete: false } });
    });

    it("reads every account of the server from Accounts, with its address", async () => {
      const books = (await addressBookGet({ accountId: "1", ids: null }, alice)).list;
      const accounts = books.find((b) => b.name === "Accounts")!;
      const q = await contactCardQuery({ accountId: "1", filter: { inAddressBook: accounts.id } }, alice);
      const cards = (await contactCardGet({ accountId: "1", ids: q.ids }, alice)).list as Array<Record<string, any>>;
      const addresses = cards.flatMap((c) => Object.values(c.emails ?? {}).map((e: any) => e.address));
      expect(addresses).toEqual(expect.arrayContaining(["bob@example.test", "carol@example.test"]));
    });

    it("refuses a card written into Accounts", async () => {
      const books = (await addressBookGet({ accountId: "1", ids: null }, alice)).list;
      const accounts = books.find((b) => b.name === "Accounts")!;
      const res = await contactCardSet(
        { accountId: "1", create: { c: { "@type": "Card", uid: `urn:uuid:${RUN}-ro`, addressBookIds: { [accounts.id]: true }, name: { full: "Nope" } } } },
        alice,
      );
      expect(res.notCreated?.c).toBeDefined();
    });

    it("creates, renames, defaults and destroys a book; never defaults to a read-only one", async () => {
      const made = await addressBookSet({ accountId: "1", create: { b: { name: `Book ${RUN}` } } }, alice);
      const id = made.created!.b!.id;
      try {
        await addressBookSet({ accountId: "1", update: { [id]: { name: `Renamed ${RUN}` } }, onSuccessSetIsDefault: id }, alice);
        let books = (await addressBookGet({ accountId: "1", ids: null }, alice)).list;
        expect(books.find((b) => b.id === id)).toMatchObject({ name: `Renamed ${RUN}`, isDefault: true });
        const accounts = books.find((b) => b.name === "Accounts")!;
        await addressBookSet({ accountId: "1", onSuccessSetIsDefault: accounts.id }, alice);
        books = (await addressBookGet({ accountId: "1", ids: null }, alice)).list;
        expect(books.find((b) => b.isDefault)?.id).toBe(id);
      } finally {
        const gone = await addressBookSet({ accountId: "1", destroy: [id], onDestroyRemoveContents: true }, alice);
        expect(gone.destroyed).toEqual([id]);
      }
    });
  });

  describe("contact cards", () => {
    it("round-trips a full card, updates it and destroys it", async () => {
      const contacts = (await addressBookGet({ accountId: "1", ids: null }, alice)).list.find((b) => b.name === "Contacts")!;
      const card = {
        "@type": "Card",
        uid: `urn:uuid:${RUN}-card`,
        addressBookIds: { [contacts.id]: true },
        name: { components: [{ kind: "given", value: "Ève" }, { kind: "surname", value: `Dupré ${RUN}` }] },
        nicknames: { n1: { name: "Évi" } },
        emails: { e1: { address: "eve@example.test", contexts: { work: true } }, e2: { address: "eve.home@example.test", contexts: { private: true } } },
        phones: { p1: { number: "+687 12 34 56", features: { mobile: true } } },
        addresses: { a1: { components: [{ kind: "name", value: "1 rue de la Paix" }, { kind: "locality", value: "Nouméa" }, { kind: "postcode", value: "98800" }, { kind: "country", value: "Nouvelle-Calédonie" }] } },
        organizations: { o1: { name: "Gecka, Ltd" } },
        titles: { t1: { name: "Comptable" } },
        notes: { n1: { note: "ligne 1\nligne 2, avec virgule; et point-virgule" } },
        anniversaries: { b1: { kind: "birth", date: { "@type": "PartialDate", year: 1990, month: 4, day: 12 } } },
        media: { m1: { kind: "photo", uri: PNG } },
      };
      const res = await contactCardSet({ accountId: "1", create: { c: card } }, alice);
      expect(res.notCreated).toBeNull();
      const id = res.created!.c!.id as string;
      try {
        resetCardDavCaches();
        const got = (await contactCardGet({ accountId: "1", ids: [id] }, alice)).list[0] as Record<string, any>;
        expect(got.uid).toBe(card.uid);
        expect(got.name.components).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "given", value: "Ève" })]));
        expect(Object.values(got.emails).map((e: any) => e.address).sort()).toEqual(["eve.home@example.test", "eve@example.test"]);
        expect(Object.values(got.phones)[0]).toMatchObject({ number: "+687 12 34 56" });
        expect(JSON.stringify(got.addresses)).toContain("Nouméa");
        expect(Object.values(got.organizations)[0]).toMatchObject({ name: "Gecka, Ltd" });
        expect(Object.values(got.notes)[0]).toMatchObject({ note: card.notes.n1.note });
        expect(Object.values(got.anniversaries)[0]).toMatchObject({ date: { year: 1990, month: 4, day: 12 } });
        expect(Object.values(got.media)[0]).toMatchObject({ kind: "photo" });
        expect(String((Object.values(got.media)[0] as any).uri)).toMatch(/^data:image\/png;base64,/);

        const upd = await contactCardSet({ accountId: "1", update: { [id]: { "titles/t1/name": "Directrice" } } }, alice);
        expect(upd.notUpdated).toBeNull();
        resetCardDavCaches();
        const after = (await contactCardGet({ accountId: "1", ids: [id] }, alice)).list[0] as Record<string, any>;
        expect(Object.values(after.titles)[0]).toMatchObject({ name: "Directrice" });
        expect(Object.values(after.emails)).toHaveLength(2);
      } finally {
        const gone = await contactCardSet({ accountId: "1", destroy: [id] }, alice);
        expect(gone.destroyed).toEqual([id]);
      }
      resetCardDavCaches();
      expect((await contactCardGet({ accountId: "1", ids: [id] }, alice)).notFound).toEqual([id]);
    });
  });

  describe("calendars", () => {
    it("lists Personal as the writable default", async () => {
      const cals = (await calendarGet({ accountId: "1", ids: null }, alice)).list;
      expect(cals.find((c) => c.isDefault)).toMatchObject({ name: "Personal", myRights: { mayWriteAll: true, mayShare: false } });
    });

    it("creates, renames, recolours and destroys a calendar", async () => {
      const made = await calendarSet({ accountId: "1", create: { c: { name: `Cal ${RUN}`, color: "#3366ff" } } }, alice);
      expect(made.notCreated).toBeNull();
      const id = made.created!.c!.id as string;
      try {
        await calendarSet({ accountId: "1", update: { [id]: { name: `Cal2 ${RUN}`, color: "#ff6633" } } }, alice);
        const got = (await calendarGet({ accountId: "1", ids: [id] }, alice)).list[0]!;
        expect(got).toMatchObject({ name: `Cal2 ${RUN}` });
        expect(String(got.color).toLowerCase()).toContain("ff6633");
      } finally {
        const gone = await calendarSet({ accountId: "1", destroy: [id], onDestroyRemoveEvents: true }, alice);
        expect(gone.destroyed).toEqual([id]);
      }
    });
  });

  describe("events", () => {
    let calId: string;

    beforeEach(async () => {
      calId = (await calendarGet({ accountId: "1", ids: null }, alice)).list.find((c) => c.isDefault)!.id as string;
    });

    it("round-trips a timed event with alerts and a location, finds it by range, updates and destroys it", async () => {
      const event = {
        calendarIds: { [calId]: true },
        uid: `${RUN}-timed@test`,
        title: `Réunion ${RUN}`,
        description: "ordre du jour",
        start: "2031-03-04T09:30:00",
        duration: "PT1H30M",
        timeZone: "Pacific/Noumea",
        locations: { l1: { "@type": "Location", name: "Salle Kagu" } },
        alerts: { a1: { "@type": "Alert", trigger: { "@type": "OffsetTrigger", offset: "-PT15M" }, action: "display" } },
      };
      const res = await calendarEventSet({ accountId: "1", create: { e: event } }, alice);
      expect(res.notCreated).toBeNull();
      const id = res.created!.e!.id as string;
      try {
        resetCalDavCaches();
        const got = (await calendarEventGet({ accountId: "1", ids: [id] }, alice)).list[0] as Record<string, any>;
        expect(got).toMatchObject({ uid: event.uid, title: event.title, start: event.start, duration: event.duration, timeZone: "Pacific/Noumea" });
        expect(Object.values(got.locations)[0]).toMatchObject({ name: "Salle Kagu" });
        expect(Object.values(got.alerts)[0]).toMatchObject({ trigger: { offset: "-PT15M" } });

        const inRange = await calendarEventQuery(
          { accountId: "1", filter: { inCalendar: calId, after: "2031-03-04T00:00:00", before: "2031-03-05T00:00:00" }, timeZone: "Pacific/Noumea" },
          alice,
        );
        expect(inRange.ids).toContain(id);
        const outOfRange = await calendarEventQuery(
          { accountId: "1", filter: { inCalendar: calId, after: "2031-04-01T00:00:00", before: "2031-04-02T00:00:00" }, timeZone: "Pacific/Noumea" },
          alice,
        );
        expect(outOfRange.ids).not.toContain(id);

        await calendarEventSet({ accountId: "1", update: { [id]: { title: `Déplacée ${RUN}`, start: "2031-03-04T14:00:00" } } }, alice);
        resetCalDavCaches();
        const moved = (await calendarEventGet({ accountId: "1", ids: [id] }, alice)).list[0] as Record<string, any>;
        expect(moved).toMatchObject({ title: `Déplacée ${RUN}`, start: "2031-03-04T14:00:00", duration: "PT1H30M" });
      } finally {
        const gone = await calendarEventSet({ accountId: "1", destroy: [id] }, alice);
        expect(gone.destroyed).toEqual([id]);
      }
    });

    it("round-trips an all-day event and a weekly series with one excluded occurrence", async () => {
      const allDay = { calendarIds: { [calId]: true }, uid: `${RUN}-day@test`, title: `Férié ${RUN}`, start: "2031-09-24T00:00:00", duration: "P1D", showWithoutTime: true };
      const weekly = {
        calendarIds: { [calId]: true },
        uid: `${RUN}-weekly@test`,
        title: `Hebdo ${RUN}`,
        start: "2031-01-06T08:00:00",
        duration: "PT30M",
        timeZone: "Pacific/Noumea",
        recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "weekly", count: 5 }],
        recurrenceOverrides: { "2031-01-13T08:00:00": { excluded: true } },
      };
      const res = await calendarEventSet({ accountId: "1", create: { d: allDay, w: weekly } }, alice);
      expect(res.notCreated).toBeNull();
      const ids = [res.created!.d!.id as string, res.created!.w!.id as string];
      try {
        resetCalDavCaches();
        const got = (await calendarEventGet({ accountId: "1", ids }, alice)).list as Array<Record<string, any>>;
        expect(got.find((e) => e.uid === allDay.uid)).toMatchObject({ showWithoutTime: true, start: "2031-09-24T00:00:00", duration: "P1D" });
        const series = got.find((e) => e.uid === weekly.uid)!;
        expect(series.recurrenceRules[0]).toMatchObject({ frequency: "weekly", count: 5 });
        expect(series.recurrenceOverrides).toMatchObject({ "2031-01-13T08:00:00": { excluded: true } });
      } finally {
        await calendarEventSet({ accountId: "1", destroy: ids }, alice);
      }
    });
  });

  describe("a calendar shared from Nextcloud", () => {
    const shareWithBob = (readWrite: boolean) =>
      davAs(
        "alice",
        "POST",
        "/remote.php/dav/calendars/alice/personal/",
        `<O:share xmlns:D="DAV:" xmlns:O="http://owncloud.org/ns"><O:set><D:href>principal:principals/users/bob</D:href>${readWrite ? "<O:read-write/>" : ""}</O:set></O:share>`,
        { "Content-Type": "application/xml" },
      );

    afterAll(async () => {
      await davAs(
        "alice",
        "POST",
        "/remote.php/dav/calendars/alice/personal/",
        `<O:share xmlns:D="DAV:" xmlns:O="http://owncloud.org/ns"><O:remove><D:href>principal:principals/users/bob</D:href></O:remove></O:share>`,
        { "Content-Type": "application/xml" },
      );
    });

    it("is read-only for the sharee, refuses an event and never becomes the default", async () => {
      expect((await shareWithBob(false)).status).toBe(200);
      resetCalDavCaches();
      const cals = (await calendarGet({ accountId: "2", ids: null }, bob)).list;
      const shared = cals.find((c) => String(c.name).includes("Alice"))!;
      expect(shared).toMatchObject({ isDefault: false, myRights: { mayReadItems: true, mayWriteAll: false, mayShare: false, mayDelete: false } });

      const res = await calendarEventSet(
        { accountId: "2", create: { e: { calendarIds: { [shared.id as string]: true }, uid: `${RUN}-ro@test`, title: "x", start: "2031-05-01T10:00:00", duration: "PT1H", timeZone: "Pacific/Noumea" } } },
        bob,
      );
      expect(res.notCreated?.e).toBeDefined();

      await calendarSet({ accountId: "2", onSuccessSetIsDefault: shared.id as string }, bob);
      resetCalDavCaches();
      const again = (await calendarGet({ accountId: "2", ids: null }, bob)).list;
      expect(again.find((c) => c.isDefault)?.id).not.toBe(shared.id);
    });

    it("takes the sharee's events once read-write, and the owner sees them", async () => {
      expect((await shareWithBob(true)).status).toBe(200);
      resetCalDavCaches();
      const shared = (await calendarGet({ accountId: "2", ids: null }, bob)).list.find((c) => String(c.name).includes("Alice"))!;
      expect(shared.myRights).toMatchObject({ mayWriteAll: true, mayShare: false });
      const res = await calendarEventSet(
        { accountId: "2", create: { e: { calendarIds: { [shared.id as string]: true }, uid: `${RUN}-rw@test`, title: `De Bob ${RUN}`, start: "2031-05-02T10:00:00", duration: "PT1H", timeZone: "Pacific/Noumea" } } },
        bob,
      );
      expect(res.notCreated).toBeNull();
      try {
        resetCalDavCaches();
        const own = (await calendarGet({ accountId: "1", ids: null }, alice)).list.find((c) => c.isDefault)!;
        const found = await calendarEventQuery(
          { accountId: "1", filter: { inCalendar: own.id as string, after: "2031-05-02T00:00:00", before: "2031-05-03T00:00:00" }, timeZone: "Pacific/Noumea" },
          alice,
        );
        const events = (await calendarEventGet({ accountId: "1", ids: found.ids }, alice)).list;
        expect(events.map((e) => e.title)).toContain(`De Bob ${RUN}`);
      } finally {
        await calendarEventSet({ accountId: "2", destroy: [res.created!.e!.id as string] }, bob);
      }
      expect(hrefOf(shared.id as string)).toContain("_shared_by_alice");
    });
  });
});
