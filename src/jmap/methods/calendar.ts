// JMAP for Calendars (draft-ietf-jmap-calendars) handlers backed by CalDAV
// (RFC 4791). Same shape as ./contacts.ts: reads are live PROPFIND / REPORT
// against the server, writes are PUT / DELETE on .ics resources and
// MKCALENDAR / PROPPATCH / DELETE on collections. iCalendar ⇄ JSCalendar
// translation lives in ../../caldav/jscalendar.ts.
//
// IDs are derived from resource paths:
//   - calendarId       = base64url(href)
//   - calendarEventId  = base64url(calHref + "\n" + resourceHref)
//
// Recurrence: the server answers time-range queries with the master
// resources whose occurrences overlap, and the client (Bulwark) expands them
// itself. `expandRecurrences` is not implemented; the synthetic-id probe the
// client sends before relying on it gets `invalidProperties` (see set()).
//
// Calendar properties CalDAV cannot hold (isVisible, sortOrder, default
// alerts…) are kept in the proxy's pref table so they survive across
// sessions instead of being silently dropped.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { mapWithConcurrency } from "../../util/concurrency.js";
import { CalDavClient, CalDavConflict, type CalendarInfo } from "../../caldav/client.js";
import { parseICalendar, serializeEvent, utcBounds, type JsEvent, type JsonObject } from "../../caldav/jscalendar.js";
import { isValidTimeZone, localToUtc, parseLocal, toIcalUtc } from "../../caldav/tz.js";
import type { Credentials } from "../../auth/credentials.js";
import type { ProviderConfig } from "../../util/config.js";
import type { AccountRow, Store } from "../../state/store.js";
import type { ImapPool } from "../../imap/pool.js";
import { accountNotFound, JmapError } from "../errors.js";
import { applyPatch } from "./contacts.js";
import { readBlob } from "../blobs.js";
import { planScheduling, sendScheduling, type ImipMessage } from "../../caldav/imip.js";
import { log } from "../../util/log.js";

export interface CalendarCtx {
  account: AccountRow;
  provider: ProviderConfig;
  creds: Credentials;
  store: Store;
  pool?: ImapPool;
}

const MULTIGET_CONCURRENCY = 4;
const CHUNK = 50;

// -- ids --------------------------------------------------------------------

function encodeId(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function decodeId(id: string): string {
  return Buffer.from(id, "base64url").toString("utf8");
}
export function calendarId(href: string): string {
  return encodeId(href);
}
export function eventId(calHref: string, resourceHref: string): string {
  return encodeId(calHref + "\n" + resourceHref);
}
export function splitEventId(id: string): { calHref: string; resourceHref: string } | null {
  try {
    const decoded = decodeId(id);
    if (encodeId(decoded) !== id) return null;
    const idx = decoded.indexOf("\n");
    if (idx < 0) return null;
    const calHref = decoded.slice(0, idx);
    const resourceHref = decoded.slice(idx + 1);
    if (!calHref.startsWith("/") || !resourceHref.startsWith(calHref)) return null;
    return { calHref, resourceHref };
  } catch {
    return null;
  }
}

// -- helpers -----------------------------------------------------------------

function ensureCalDav(provider: ProviderConfig): NonNullable<ProviderConfig["caldav"]> {
  if (!provider.caldav) throw new JmapError("forbidden", "Calendars are not configured for this provider");
  return provider.caldav;
}

function makeClient(ctx: CalendarCtx): CalDavClient {
  return new CalDavClient({ ...ensureCalDav(ctx.provider), creds: ctx.creds });
}

function combinedState(cals: CalendarInfo[]): string {
  const h = crypto.createHash("sha1");
  for (const c of cals) h.update(c.href + " " + (c.ctag ?? "") + " ");
  return h.digest("base64url").slice(0, 16);
}

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}
function setError(type: string, description?: string, properties?: string[]): SetError {
  return { type, ...(description ? { description } : {}), ...(properties ? { properties } : {}) };
}
function errorFor(e: unknown, fallback = "serverFail"): SetError {
  if (e instanceof CalDavConflict) return setError("stateMismatch", "the resource changed on the CalDAV server; refetch and retry");
  if (e instanceof JmapError) return setError(e.type, e.message);
  return setError(fallback, (e as Error)?.message);
}

interface SetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
}
interface SetResponse<Created> {
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, Created> | null;
  /** Server-set properties that changed as a side effect, or null when none. */
  updated: Record<string, Record<string, unknown> | null> | null;
  destroyed: string[] | null;
  notCreated: Record<string, SetError> | null;
  notUpdated: Record<string, SetError> | null;
  notDestroyed: Record<string, SetError> | null;
}
function emptySet<T>(accountId: string, state: string): SetResponse<T> {
  return { accountId, oldState: state, newState: state, created: null, updated: null, destroyed: null, notCreated: null, notUpdated: null, notDestroyed: null };
}

/** RFC 8620 §5.1: keep only the requested properties (id always included). */
function project<T extends JsonObject>(obj: T, properties: string[] | null | undefined): JsonObject {
  if (!properties) return obj;
  const out: JsonObject = { id: obj.id };
  for (const p of properties) if (p in obj) out[p] = obj[p];
  return out;
}

// -- Calendar ----------------------------------------------------------------

interface CalendarPrefs {
  sortOrder?: number;
  isSubscribed?: boolean;
  isVisible?: boolean;
  includeInAvailability?: "all" | "attending" | "none";
  defaultAlertsWithTime?: JsonObject | null;
  defaultAlertsWithoutTime?: JsonObject | null;
  timeZone?: string | null;
}

const PREF_CALENDAR = (id: string) => `calendar:${id}`;
const PREF_DEFAULT_CALENDAR = "calendar:default";
const PREF_DEFAULT_IDENTITY = "participant-identity:default";

const RIGHTS = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: true,
  mayWriteOwn: true,
  mayUpdatePrivate: true,
  mayRSVP: true,
  mayShare: false,
  mayDelete: true,
};

function projectCalendar(ctx: CalendarCtx, c: CalendarInfo, isDefault: boolean): JsonObject {
  const id = calendarId(c.href);
  const prefs = ctx.store.getPref<CalendarPrefs>(ctx.account.id, PREF_CALENDAR(id)) ?? {};
  return {
    id,
    name: c.displayName,
    description: c.description,
    color: c.color,
    sortOrder: prefs.sortOrder ?? 0,
    isSubscribed: prefs.isSubscribed ?? true,
    isVisible: prefs.isVisible ?? true,
    isDefault,
    includeInAvailability: prefs.includeInAvailability ?? "all",
    defaultAlertsWithTime: prefs.defaultAlertsWithTime ?? null,
    defaultAlertsWithoutTime: prefs.defaultAlertsWithoutTime ?? null,
    timeZone: prefs.timeZone ?? null,
    shareWith: null,
    myRights: RIGHTS,
  };
}

/** Calendars that can hold events (a VTODO-only collection is not a JMAP Calendar). */
function eventCalendars(cals: CalendarInfo[]): CalendarInfo[] {
  return cals.filter((c) => c.components.length === 0 || c.components.includes("VEVENT"));
}

/**
 * The calendar flagged isDefault and used when an event is created without a
 * calendarIds. The account's stored choice wins as long as that calendar still
 * exists; otherwise the `calendar` collection (the one a fresh account gets),
 * otherwise the first by href. The server lists collections in directory
 * order, so nothing here relies on the order of the PROPFIND response.
 */
function defaultCalendar(ctx: CalendarCtx, cals: CalendarInfo[]): CalendarInfo | undefined {
  if (cals.length === 0) return undefined;
  const pref = ctx.store.getPref<string>(ctx.account.id, PREF_DEFAULT_CALENDAR);
  const chosen = pref ? cals.find((c) => calendarId(c.href) === pref) : undefined;
  if (chosen) return chosen;
  return cals.find((c) => leaf(c.href) === DEFAULT_CALENDAR_SLUG) ?? [...cals].sort((a, b) => a.href.localeCompare(b.href))[0];
}

export async function calendarGet(
  args: { accountId: string; ids?: string[] | null; properties?: string[] | null },
  ctx: CalendarCtx,
): Promise<{ accountId: string; state: string; list: JsonObject[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  const cals = eventCalendars(await client.listCalendars());
  const def = defaultCalendar(ctx, cals);
  const all = cals.map((c) => projectCalendar(ctx, c, c === def));
  const list = (args.ids ? all.filter((c) => args.ids!.includes(c.id as string)) : all).map((c) => project(c, args.properties));
  const notFound = args.ids ? args.ids.filter((id) => !all.some((c) => c.id === id)) : [];
  return { accountId: args.accountId, state: combinedState(cals), list, notFound };
}

const CALENDAR_DAV_PROPS = new Set(["name", "description", "color"]);
const CALENDAR_PREF_PROPS = new Set(["sortOrder", "isSubscribed", "isVisible", "includeInAvailability", "defaultAlertsWithTime", "defaultAlertsWithoutTime", "timeZone"]);
const CALENDAR_IGNORED = new Set(["isDefault", "shareWith", "myRights", "id"]);

export async function calendarSet(
  args: SetArgs & { onDestroyRemoveEvents?: boolean; onSuccessSetIsDefault?: string | null },
  ctx: CalendarCtx,
): Promise<SetResponse<JsonObject>> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  let cals = await client.listCalendars();
  const oldState = combinedState(cals);
  if (args.ifInState != null && args.ifInState !== oldState) throw new JmapError("stateMismatch");
  const out = emptySet<JsonObject>(args.accountId, oldState);
  const previousDefault = defaultCalendar(ctx, eventCalendars(cals));

  for (const [tempId, raw] of Object.entries(args.create ?? {})) {
    try {
      if (!raw || typeof raw !== "object") throw new JmapError("invalidProperties", "create entry must be an object");
      const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
      if (!name) {
        (out.notCreated ??= {})[tempId] = setError("invalidProperties", "name is required", ["name"]);
        continue;
      }
      const unknown = Object.keys(raw).filter((k) => !CALENDAR_DAV_PROPS.has(k) && !CALENDAR_PREF_PROPS.has(k) && !CALENDAR_IGNORED.has(k));
      if (unknown.length > 0) {
        (out.notCreated ??= {})[tempId] = setError("invalidProperties", `unsupported: ${unknown.join(", ")}`, unknown);
        continue;
      }
      const home = await client.calendarHome();
      const href = `${home}${collectionSlug(name, cals)}/`;
      await client.makeCalendar(href, {
        displayName: name,
        description: typeof raw["description"] === "string" ? raw["description"] : null,
        color: typeof raw["color"] === "string" ? raw["color"] : null,
      });
      const id = calendarId(href);
      savePrefs(ctx, id, raw);
      const info: CalendarInfo = { href, displayName: name, description: null, color: null, components: ["VEVENT"], ctag: null };
      cals = [...cals, info];
      const projected = projectCalendar(ctx, info, defaultCalendar(ctx, eventCalendars(cals)) === info);
      const { name: _n, ...serverSet } = projected;
      (out.created ??= {})[tempId] = serverSet;
    } catch (e) {
      log.warn({ err: (e as Error).message, tempId }, "Calendar/set create failed");
      (out.notCreated ??= {})[tempId] = errorFor(e, "invalidProperties");
    }
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      const cal = cals.find((c) => calendarId(c.href) === id);
      if (!cal) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      if (!patch || typeof patch !== "object") throw new JmapError("invalidPatch", "update entry must be an object");
      const flat: Record<string, unknown> = {};
      const unknown: string[] = [];
      for (const [k, v] of Object.entries(patch)) {
        const top = k.split("/")[0]!;
        if (CALENDAR_DAV_PROPS.has(top) || CALENDAR_PREF_PROPS.has(top)) flat[k] = v;
        else if (!CALENDAR_IGNORED.has(top)) unknown.push(top);
      }
      if (unknown.length > 0) {
        (out.notUpdated ??= {})[id] = setError("invalidProperties", `unsupported: ${unknown.join(", ")}`, unknown);
        continue;
      }
      const props: { displayName?: string; description?: string | null; color?: string | null } = {};
      if ("name" in flat) {
        const name = typeof flat["name"] === "string" ? flat["name"].trim() : "";
        if (!name) {
          (out.notUpdated ??= {})[id] = setError("invalidProperties", "name must be a non-empty string", ["name"]);
          continue;
        }
        props.displayName = name;
      }
      if ("description" in flat) props.description = typeof flat["description"] === "string" && flat["description"] ? flat["description"] : null;
      if ("color" in flat) props.color = typeof flat["color"] === "string" && flat["color"] ? flat["color"] : null;
      await client.updateCalendarProps(cal.href, props);
      savePrefs(ctx, id, flat);
      (out.updated ??= {})[id] = null;
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "Calendar/set update failed");
      (out.notUpdated ??= {})[id] = errorFor(e, "invalidProperties");
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      const cal = cals.find((c) => calendarId(c.href) === id);
      if (!cal) {
        (out.notDestroyed ??= {})[id] = setError("notFound");
        continue;
      }
      if (!args.onDestroyRemoveEvents) {
        const contents = await client.listResources(cal.href);
        if (contents.length > 0) {
          (out.notDestroyed ??= {})[id] = setError("calendarHasEvents");
          continue;
        }
      }
      await client.deleteResource(cal.href);
      ctx.store.deletePref(ctx.account.id, PREF_CALENDAR(id));
      (out.destroyed ??= []).push(id);
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "Calendar/set destroy failed");
      (out.notDestroyed ??= {})[id] = errorFor(e);
    }
  }

  if (out.created || out.updated || out.destroyed) {
    cals = await client.listCalendars();
    out.newState = combinedState(cals);
    ctx.store.bumpState(ctx.account.id, "calendar");
  }

  // draft-ietf-jmap-calendars §4.3: applied only when every create, update
  // and destroy went through; an id that matches nothing is ignored, not an
  // error. A `#tempId` names a calendar created above. The calendars whose
  // isDefault flips are reported back with the server-set value.
  if (args.onSuccessSetIsDefault != null && !out.notCreated && !out.notUpdated && !out.notDestroyed) {
    let wanted = args.onSuccessSetIsDefault;
    let createdAs: string | null = null;
    if (wanted.startsWith("#")) {
      createdAs = wanted.slice(1);
      wanted = (out.created?.[createdAs]?.id as string | undefined) ?? "";
    }
    const target = eventCalendars(cals).find((c) => calendarId(c.href) === wanted);
    if (target) {
      ctx.store.setPref(ctx.account.id, PREF_DEFAULT_CALENDAR, wanted);
      const created = createdAs ? out.created?.[createdAs] : undefined;
      if (created) {
        created.isDefault = true;
      } else if (previousDefault?.href !== target.href) {
        (out.updated ??= {})[wanted] = { isDefault: true };
      }
      if (previousDefault && previousDefault.href !== target.href && cals.some((c) => c.href === previousDefault.href)) {
        (out.updated ??= {})[calendarId(previousDefault.href)] = { isDefault: false };
      }
    }
  }
  return out;
}

/** Persist the preference-only properties present in a create / update body. */
function savePrefs(ctx: CalendarCtx, id: string, body: Record<string, unknown>): void {
  const current = ctx.store.getPref<CalendarPrefs>(ctx.account.id, PREF_CALENDAR(id)) ?? {};
  let touched = false;
  const draft = current as Record<string, unknown>;
  for (const [k, v] of Object.entries(body)) {
    const top = k.split("/")[0]!;
    if (!CALENDAR_PREF_PROPS.has(top)) continue;
    if (k === top) draft[k] = v;
    else applyPatch(draft, { [k]: v });
    touched = true;
  }
  if (touched) ctx.store.setPref(ctx.account.id, PREF_CALENDAR(id), draft);
}

function collectionSlug(name: string, existing: CalendarInfo[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const taken = new Set(existing.map((c) => leaf(c.href)));
  if (slug && !taken.has(slug)) return slug;
  return crypto.randomUUID();
}
function leaf(href: string): string {
  const t = href.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}

export async function calendarChanges(args: { accountId: string; sinceState: string }, ctx: CalendarCtx) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const cals = await makeClient(ctx).listCalendars();
  const cur = combinedState(cals);
  if (args.sinceState !== cur) throw new JmapError("cannotCalculateChanges");
  return { accountId: args.accountId, oldState: cur, newState: cur, hasMoreChanges: false, created: [] as string[], updated: [] as string[], destroyed: [] as string[] };
}

// -- CalendarEvent -------------------------------------------------------------

interface LoadedEvent {
  id: string;
  calHref: string;
  resourceHref: string;
  etag: string | null;
  raw: string;
  event: JsEvent;
}

function toJmapEvent(ctx: CalendarCtx, loaded: LoadedEvent, timeZone: string | null): JsonObject {
  const { utcStart, utcEnd } = utcBounds(loaded.event, timeZone);
  const me = `mailto:${ctx.account.username}`.toLowerCase();
  const organizer = loaded.event.organizerCalendarAddress?.toLowerCase() ?? null;
  return {
    ...loaded.event,
    id: loaded.id,
    baseEventId: loaded.id,
    calendarIds: { [calendarId(loaded.calHref)]: true },
    isDraft: false,
    isOrigin: organizer === null || organizer === me,
    utcStart,
    utcEnd,
  };
}

/** Parse a resource; null when it holds no VEVENT (a task, a journal…). */
function loadResource(calHref: string, r: { href: string; etag: string | null; data: string }): LoadedEvent | null {
  try {
    const { events } = parseICalendar(r.data);
    const event = events[0];
    if (!event) return null;
    return { id: eventId(calHref, r.href), calHref, resourceHref: r.href, etag: r.etag, raw: r.data, event };
  } catch (e) {
    log.warn({ href: r.href, err: (e as Error).message }, "unparsable calendar resource");
    return null;
  }
}

async function fetchEvents(
  client: CalDavClient,
  jobs: Array<{ calHref: string; hrefs: string[]; etags?: Map<string, string | null> }>,
): Promise<LoadedEvent[]> {
  const tasks: Array<{ calHref: string; chunk: string[]; etags?: Map<string, string | null> }> = [];
  for (const job of jobs) {
    for (let i = 0; i < job.hrefs.length; i += CHUNK) tasks.push({ calHref: job.calHref, chunk: job.hrefs.slice(i, i + CHUNK), etags: job.etags });
  }
  const fetched = await mapWithConcurrency(tasks, MULTIGET_CONCURRENCY, (t) => client.multiGet(t.calHref, t.chunk, t.etags));
  const out: LoadedEvent[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (const r of fetched[i]!) {
      const loaded = loadResource(tasks[i]!.calHref, r);
      if (loaded) out.push(loaded);
    }
  }
  return out;
}

export async function calendarEventGet(
  args: { accountId: string; ids?: string[] | null; properties?: string[] | null; timeZone?: string | null },
  ctx: CalendarCtx,
): Promise<{ accountId: string; state: string; list: JsonObject[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  const cals = eventCalendars(await client.listCalendars());
  const tz = isValidTimeZone(args.timeZone) ? args.timeZone : null;

  const jobs = new Map<string, { calHref: string; hrefs: string[]; etags: Map<string, string | null> }>();
  if (!args.ids) {
    for (const c of cals) {
      const resources = await client.listResources(c.href);
      jobs.set(c.href, { calHref: c.href, hrefs: resources.map((r) => r.href), etags: new Map(resources.map((r) => [r.href, r.etag])) });
    }
  } else {
    for (const id of args.ids) {
      const parts = splitEventId(id);
      if (!parts || !cals.some((c) => c.href === parts.calHref)) continue;
      let job = jobs.get(parts.calHref);
      if (!job) {
        job = { calHref: parts.calHref, hrefs: [], etags: new Map() };
        jobs.set(parts.calHref, job);
      }
      job.hrefs.push(parts.resourceHref);
    }
  }
  const loaded = await fetchEvents(client, [...jobs.values()]);
  const seen = new Set(loaded.map((l) => l.id));
  const list = loaded.map((l) => project(toJmapEvent(ctx, l, tz), args.properties));
  const notFound = args.ids ? args.ids.filter((id) => !seen.has(id)) : [];
  return { accountId: args.accountId, state: combinedState(cals), list, notFound };
}

interface EventFilter {
  operator?: "AND" | "OR" | "NOT";
  conditions?: EventFilter[];
  inCalendar?: string;
  inCalendars?: string[];
  after?: string;
  before?: string;
  uid?: string;
  text?: string;
  title?: string;
  description?: string;
  location?: string;
}

/** Calendar ids named anywhere in the filter tree (null = unrestricted). */
function calendarIdsOf(f: EventFilter | undefined): Set<string> | null {
  if (!f) return null;
  const ids = new Set<string>();
  let found = false;
  const walk = (n: EventFilter) => {
    if (n.inCalendar) {
      ids.add(n.inCalendar);
      found = true;
    }
    for (const c of n.inCalendars ?? []) {
      ids.add(c);
      found = true;
    }
    for (const c of n.conditions ?? []) walk(c);
  };
  walk(f);
  return found ? ids : null;
}

function rangeOf(f: EventFilter | undefined): { after?: string; before?: string } {
  if (!f) return {};
  if (f.after || f.before) return { after: f.after, before: f.before };
  for (const c of f.conditions ?? []) {
    const r = rangeOf(c);
    if (r.after || r.before) return r;
  }
  return {};
}

function contentMatch(f: EventFilter | undefined, ev: JsonObject): boolean {
  if (!f) return true;
  if (f.conditions) {
    const results = f.conditions.map((c) => contentMatch(c, ev));
    if (f.operator === "OR") return results.some(Boolean);
    if (f.operator === "NOT") return !results.some(Boolean);
    return results.every(Boolean);
  }
  const has = (v: unknown, needle: string) => typeof v === "string" && v.toLowerCase().includes(needle.toLowerCase());
  if (f.uid !== undefined && ev.uid !== f.uid) return false;
  if (f.title !== undefined && !has(ev.title, f.title)) return false;
  if (f.description !== undefined && !has(ev.description, f.description)) return false;
  if (f.location !== undefined) {
    const locs = Object.values((ev.locations as Record<string, JsonObject> | null) ?? {});
    if (!locs.some((l) => has(l.name, f.location!))) return false;
  }
  if (f.text !== undefined) {
    const locs = Object.values((ev.locations as Record<string, JsonObject> | null) ?? {}).map((l) => l.name);
    const parts = Object.values((ev.participants as Record<string, JsonObject> | null) ?? {}).flatMap((p) => [p.name, p.email]);
    if (![ev.title, ev.description, ...locs, ...parts].some((v) => has(v, f.text!))) return false;
  }
  return true;
}

function hasContentFilter(f: EventFilter | undefined): boolean {
  if (!f) return false;
  if (f.uid !== undefined || f.text !== undefined || f.title !== undefined || f.description !== undefined || f.location !== undefined) return true;
  return (f.conditions ?? []).some(hasContentFilter);
}

export async function calendarEventQuery(
  args: {
    accountId: string;
    filter?: EventFilter;
    sort?: Array<{ property: string; isAscending?: boolean }>;
    position?: number;
    limit?: number;
    timeZone?: string | null;
    expandRecurrences?: boolean;
  },
  ctx: CalendarCtx,
): Promise<{ accountId: string; queryState: string; canCalculateChanges: boolean; position: number; total: number; ids: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  const cals = eventCalendars(await client.listCalendars());
  const tz = isValidTimeZone(args.timeZone) ? args.timeZone : "UTC";

  const wanted = calendarIdsOf(args.filter);
  const targets = wanted ? cals.filter((c) => wanted.has(calendarId(c.href))) : cals;
  const { after, before } = rangeOf(args.filter);

  // Candidate resources per calendar: a time-range REPORT when the filter
  // has bounds (the server does the recurrence-aware overlap), else the
  // whole listing.
  const listings = await mapWithConcurrency(targets, MULTIGET_CONCURRENCY, async (c) => {
    if (after || before) {
      const start = after ? toIcalUtc(localToUtc(tz, parseLocal(after) ?? { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 })) : "19700101T000000Z";
      const end = before ? toIcalUtc(localToUtc(tz, parseLocal(before) ?? { year: 2100, month: 1, day: 1, hour: 0, minute: 0, second: 0 })) : "21000101T000000Z";
      return { calHref: c.href, resources: await client.queryRange(c.href, start, end) };
    }
    return { calHref: c.href, resources: await client.listResources(c.href) };
  });

  const sort = (args.sort ?? []).filter((s) => s.property === "start" || s.property === "utcStart" || s.property === "updated" || s.property === "title");
  const needBodies = hasContentFilter(args.filter) || sort.length > 0;

  let ids: string[];
  if (!needBodies) {
    ids = listings.flatMap((l) => l.resources.map((r) => eventId(l.calHref, r.href)));
  } else {
    const loaded = await fetchEvents(
      client,
      listings.map((l) => ({ calHref: l.calHref, hrefs: l.resources.map((r) => r.href), etags: new Map(l.resources.map((r) => [r.href, r.etag])) })),
    );
    let rows = loaded.map((l) => ({ id: l.id, ev: toJmapEvent(ctx, l, tz) })).filter((r) => contentMatch(args.filter, r.ev));
    for (const s of [...sort].reverse()) {
      const key = s.property === "start" ? "utcStart" : s.property;
      const dir = s.isAscending === false ? -1 : 1;
      rows = rows.sort((a, b) => dir * String(a.ev[key] ?? "").localeCompare(String(b.ev[key] ?? "")));
    }
    ids = rows.map((r) => r.id);
  }

  const position = Math.max(0, args.position ?? 0);
  const limit = args.limit && args.limit > 0 ? args.limit : ids.length;
  return {
    accountId: args.accountId,
    queryState: combinedState(cals),
    canCalculateChanges: false,
    position,
    total: ids.length,
    ids: ids.slice(position, position + limit),
  };
}

/** Fields the server owns or that this backend cannot change post-creation. */
const EVENT_IMMUTABLE = new Set(["id", "calendarIds", "uid", "baseEventId", "utcStart", "utcEnd", "isOrigin", "isDraft", "created", "updated", "method"]);

function stripAtType(o: unknown): void {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) {
    for (const x of o) stripAtType(x);
    return;
  }
  const r = o as Record<string, unknown>;
  if (r["@type"] !== "Event") delete r["@type"];
  for (const v of Object.values(r)) stripAtType(v);
}

/** Pick the (single) calendar an event should live in, `fallback` when the client names none. */
function resolveCalendar(cals: CalendarInfo[], fallback: CalendarInfo | undefined, calendarIds: unknown): { cal: CalendarInfo } | { error: SetError } {
  if (cals.length === 0 || !fallback) return { error: setError("invalidProperties", "no calendar exists on the CalDAV server", ["calendarIds"]) };
  if (calendarIds == null) return { cal: fallback };
  if (typeof calendarIds !== "object") return { error: setError("invalidProperties", "calendarIds must be an object", ["calendarIds"]) };
  const ids = Object.entries(calendarIds as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id);
  if (ids.length === 0) return { cal: fallback };
  if (ids.length > 1) return { error: setError("invalidProperties", "a CalDAV event can only live in one calendar", ["calendarIds"]) };
  const cal = cals.find((c) => calendarId(c.href) === ids[0]);
  if (!cal) return { error: setError("invalidProperties", "unknown calendarId", ["calendarIds"]) };
  return { cal };
}

function sameCalendar(v: unknown, wanted: string): boolean {
  if (!v || typeof v !== "object") return false;
  const on = Object.entries(v as Record<string, unknown>).filter(([, x]) => x === true).map(([k]) => k);
  return on.length === 1 && on[0] === wanted;
}

const DEFAULT_CALENDAR_SLUG = "calendar";
const DEFAULT_CALENDAR_NAME = "Calendar";

async function ensureDefaultCalendar(client: CalDavClient): Promise<CalendarInfo> {
  const home = await client.calendarHome();
  const href = `${home}${DEFAULT_CALENDAR_SLUG}/`;
  try {
    await client.makeCalendar(href, { displayName: DEFAULT_CALENDAR_NAME, components: ["VEVENT"] });
    log.info({ href }, "created default calendar");
  } catch (e) {
    if (!(e instanceof CalDavConflict)) throw e;
  }
  const cals = await client.listCalendars();
  const created = cals.find((c) => c.href === href) ?? eventCalendars(cals)[0];
  if (!created) throw new JmapError("serverFail", "calendar creation did not take effect");
  return created;
}

export async function calendarEventSet(
  args: SetArgs & { sendSchedulingMessages?: boolean },
  ctx: CalendarCtx,
): Promise<SetResponse<JsonObject>> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  let cals = eventCalendars(await client.listCalendars());
  const oldState = combinedState(cals);
  if (args.ifInState != null && args.ifInState !== oldState) throw new JmapError("stateMismatch");
  const out = emptySet<JsonObject>(args.accountId, oldState);
  // iMIP messages owed for the writes that succeeded; sent once the CalDAV
  // side is done so a mail failure can never fail the write itself.
  const scheduling: ImipMessage[] = [];
  const me = accountEmail(ctx.account);
  const schedule = (before: JsonObject | null, after: JsonObject | null) => {
    if (args.sendSchedulingMessages !== true) return;
    scheduling.push(...planScheduling({ me, meName: ctx.store.getIdentitySettings(ctx.account.id).displayName, before, after }));
  };

  for (const [tempId, raw] of Object.entries(args.create ?? {})) {
    try {
      if (!raw || typeof raw !== "object") throw new JmapError("invalidProperties", "create entry must be an object");
      const input = structuredClone(raw) as Record<string, unknown>;
      stripAtType(input);
      if (cals.length === 0 && !hasExplicitCalendar(input["calendarIds"])) cals = [await ensureDefaultCalendar(client)];
      const picked = resolveCalendar(cals, defaultCalendar(ctx, cals), input["calendarIds"]);
      if ("error" in picked) {
        (out.notCreated ??= {})[tempId] = picked.error;
        continue;
      }
      for (const k of EVENT_IMMUTABLE) if (k !== "uid") delete input[k];
      if (typeof input["start"] !== "string" || !parseLocal(input["start"] as string)) {
        (out.notCreated ??= {})[tempId] = setError("invalidProperties", "start must be a LocalDateTime", ["start"]);
        continue;
      }
      const uid = typeof input["uid"] === "string" && input["uid"] ? (input["uid"] as string) : crypto.randomUUID();
      input["uid"] = uid;
      const ics = serializeEvent(input);
      const resourceHref = `${picked.cal.href}${crypto.randomUUID()}.ics`;
      await client.putResource(resourceHref, ics);
      const id = eventId(picked.cal.href, resourceHref);
      const { utcStart, utcEnd } = utcBounds(input, null);
      (out.created ??= {})[tempId] = { id, uid, baseEventId: id, isDraft: false, isOrigin: true, utcStart, utcEnd };
      schedule(null, input);
    } catch (e) {
      log.warn({ err: (e as Error).message, tempId }, "CalendarEvent/set create failed");
      (out.notCreated ??= {})[tempId] = errorFor(e, "invalidProperties");
    }
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      const parts = splitEventId(id);
      if (!parts) {
        // Not one of our ids. Bulwark probes for Stalwart's synthetic
        // occurrence ids with an update on a made-up id and reads `notFound`
        // as "supported"; `invalidProperties` keeps it on client-side
        // recurrence expansion, which is what this backend needs.
        (out.notUpdated ??= {})[id] = setError("invalidProperties", "malformed id", ["id"]);
        continue;
      }
      const cal = cals.find((c) => c.href === parts.calHref);
      if (!cal) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      if (!patch || typeof patch !== "object") throw new JmapError("invalidPatch", "update entry must be an object");
      const [existing] = await client.multiGet(cal.href, [parts.resourceHref]);
      const current = existing ? loadResource(cal.href, existing) : null;
      if (!existing || !current) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      const cleaned = structuredClone(patch) as Record<string, unknown>;
      stripAtType(cleaned);
      const bad: string[] = [];
      for (const key of Object.keys(cleaned)) {
        const top = key.split("/")[0]!;
        if (!EVENT_IMMUTABLE.has(top)) continue;
        const v = cleaned[key];
        const same =
          (top === "id" && v === id) ||
          (top === "uid" && v === current.event.uid) ||
          (top === "calendarIds" && key === top && sameCalendar(v, calendarId(cal.href))) ||
          top === "utcStart" || top === "utcEnd" || top === "baseEventId" || top === "isOrigin" || top === "isDraft" || top === "created" || top === "updated" || top === "method";
        if (!same) bad.push(top);
        delete cleaned[key];
      }
      if (bad.length > 0) {
        (out.notUpdated ??= {})[id] = setError("invalidProperties", `immutable: ${bad.join(", ")}`, bad);
        continue;
      }
      const draft = { ...current.event } as Record<string, unknown>;
      applyPatch(draft, cleaned);
      draft["uid"] = current.event.uid;
      draft["sequence"] = (Number(current.event.sequence) || 0) + 1;
      const ics = serializeEvent(draft, { preserveFrom: current.raw });
      await client.putResource(parts.resourceHref, ics, { ifMatch: existing.etag });
      (out.updated ??= {})[id] = null;
      schedule(current.event, draft);
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "CalendarEvent/set update failed");
      (out.notUpdated ??= {})[id] = errorFor(e, "invalidProperties");
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      const parts = splitEventId(id);
      const cal = parts ? cals.find((c) => c.href === parts.calHref) : undefined;
      if (!parts || !cal) {
        (out.notDestroyed ??= {})[id] = setError("notFound");
        continue;
      }
      let before: LoadedEvent | null = null;
      if (args.sendSchedulingMessages === true) {
        const [existing] = await client.multiGet(cal.href, [parts.resourceHref]);
        before = existing ? loadResource(cal.href, existing) : null;
      }
      await client.deleteResource(parts.resourceHref);
      (out.destroyed ??= []).push(id);
      if (before) schedule(before.event, null);
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "CalendarEvent/set destroy failed");
      (out.notDestroyed ??= {})[id] = errorFor(e);
    }
  }

  if (out.created || out.updated || out.destroyed) {
    cals = eventCalendars(await client.listCalendars());
    out.newState = combinedState(cals);
    ctx.store.bumpState(ctx.account.id, "calendarevent");
  }
  if (scheduling.length) {
    await sendScheduling(
      { provider: ctx.provider, creds: ctx.creds, from: me, fromName: ctx.store.getIdentitySettings(ctx.account.id).displayName },
      scheduling,
    );
  }
  return out;
}

/** The account's address: the login when it is one, else user@host as Identity/get does. */
function accountEmail(account: AccountRow): string {
  if (account.username.includes("@")) return account.username.toLowerCase();
  const domain = (account.host || "localhost").replace(/^(imap|imaps|mail|smtp|submission|pop|pop3)\./i, "");
  return `${account.username}@${domain}`.toLowerCase();
}

function hasExplicitCalendar(calendarIds: unknown): boolean {
  if (!calendarIds || typeof calendarIds !== "object") return false;
  return Object.values(calendarIds as Record<string, unknown>).some((on) => on === true);
}

export async function calendarEventChanges(args: { accountId: string; sinceState: string }, ctx: CalendarCtx) {
  return calendarChanges(args, ctx);
}

export async function calendarEventQueryChanges(args: { accountId: string; sinceQueryState: string }, ctx: CalendarCtx) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const cals = await makeClient(ctx).listCalendars();
  const cur = combinedState(cals);
  if (args.sinceQueryState !== cur) throw new JmapError("cannotCalculateChanges");
  return { accountId: args.accountId, oldQueryState: cur, newQueryState: cur, removed: [] as string[], added: [] as { id: string; index: number }[] };
}

/** CalendarEvent/parse: iCalendar blobs (invitations, uploads) → JSCalendar. */
export async function calendarEventParse(
  args: { accountId: string; blobIds: string[]; properties?: string[] | null; timeZone?: string | null },
  ctx: CalendarCtx,
): Promise<{ accountId: string; parsed: Record<string, JsonObject[]>; notParsable: string[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const tz = isValidTimeZone(args.timeZone) ? args.timeZone : null;
  const parsed: Record<string, JsonObject[]> = {};
  const notParsable: string[] = [];
  const notFound: string[] = [];
  for (const blobId of args.blobIds ?? []) {
    const blob = await readBlob({ account: ctx.account, store: ctx.store, pool: ctx.pool }, blobId);
    if (!blob) {
      notFound.push(blobId);
      continue;
    }
    try {
      const { events } = parseICalendar(blob.body.toString("utf8"));
      if (events.length === 0) {
        notParsable.push(blobId);
        continue;
      }
      parsed[blobId] = events.map((ev) => {
        const { utcStart, utcEnd } = utcBounds(ev, tz);
        return project({ ...ev, utcStart, utcEnd, isDraft: false }, args.properties);
      });
    } catch {
      notParsable.push(blobId);
    }
  }
  return { accountId: args.accountId, parsed, notParsable, notFound };
}

// -- ParticipantIdentity ---------------------------------------------------------

/**
 * The addresses this account can organise as. IMAP knows one mailbox, so
 * there is exactly one identity: the login address (plus any reply-to the
 * user configured on their Identity, which shares the same principal).
 */
export async function participantIdentityGet(
  args: { accountId: string; ids?: string[] | null },
  ctx: { account: AccountRow; store: Store },
): Promise<{ accountId: string; state: string; list: JsonObject[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const all = [identityOf(ctx.account)];
  const list = args.ids ? all.filter((i) => args.ids!.includes(i.id as string)) : all;
  const notFound = args.ids ? args.ids.filter((id) => !all.some((i) => i.id === id)) : [];
  return { accountId: args.accountId, state: "0", list, notFound };
}

function identityOf(account: AccountRow): JsonObject {
  return { id: "primary", name: "", calendarAddress: `mailto:${accountEmail(account)}`, isDefault: true };
}

export async function participantIdentitySet(
  args: { accountId: string; onSuccessSetIsDefault?: string | null } & Partial<SetArgs>,
  ctx: { account: AccountRow; store: Store },
): Promise<SetResponse<JsonObject>> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const out = emptySet<JsonObject>(args.accountId, "0");
  for (const tempId of Object.keys(args.create ?? {})) (out.notCreated ??= {})[tempId] = setError("forbidden", "identities are derived from the IMAP login");
  for (const id of Object.keys(args.update ?? {})) (out.notUpdated ??= {})[id] = setError("forbidden");
  for (const id of args.destroy ?? []) (out.notDestroyed ??= {})[id] = setError("forbidden");
  if (args.onSuccessSetIsDefault != null && !out.notCreated && !out.notUpdated && !out.notDestroyed) {
    if (args.onSuccessSetIsDefault !== "primary") throw new JmapError("invalidArguments", "unknown identity");
    ctx.store.setPref(ctx.account.id, PREF_DEFAULT_IDENTITY, "primary");
  }
  return out;
}

export function calendarsAvailable(provider: ProviderConfig): boolean {
  return provider.caldav != null;
}

export const __test = { calendarId, eventId, splitEventId, combinedState };
