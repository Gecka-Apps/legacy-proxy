// Minimal CalDAV client (RFC 4791). Mirrors ../carddav/client.ts: discover
// the calendar-home-set, list calendar collections, list / multiget / range-
// query the .ics resources in each, and write them back (PUT / DELETE,
// MKCALENDAR, PROPPATCH). Same hand-rolled XML extraction, same cache shape
// (discovery per account, short-lived collection and listing caches,
// etag-keyed body cache).

import { Buffer } from "node:buffer";
import type { Credentials } from "../auth/credentials.js";
import { log } from "../util/log.js";
import {
  absolutise,
  buildAuth,
  escapeXml,
  extractHref,
  hasResourceType,
  leafName,
  pickHref,
  splitProp,
  splitResponses,
  textOf,
} from "../carddav/client.js";

export interface CalDavOpts {
  host: string;
  port: number;
  secure?: boolean;
  basePath?: string;
  principalPath?: string;
  creds: Credentials;
}

export interface CalendarInfo {
  /** Server-side path, slash-terminated. Stable per calendar. */
  href: string;
  displayName: string;
  description: string | null;
  /** CSS colour from apple:calendar-color, when set. */
  color: string | null;
  /** Component types the collection accepts; empty means "unrestricted". */
  components: string[];
  /** ctag or sync-token, when offered. Used to derive a JMAP state string. */
  ctag: string | null;
}

export interface CalendarResource {
  href: string;
  etag: string | null;
  data: string;
}

interface DiscoveryEntry {
  principal?: string;
  home?: string;
  at: number;
}
const discoveryCache = new Map<string, DiscoveryEntry>();
const DISCOVERY_TTL_MS = 60 * 60_000;

interface ListEntry<T> {
  items: T[];
  at: number;
}
const calendarListCache = new Map<string, ListEntry<CalendarInfo>>();
const CALENDAR_LIST_TTL_MS = 15_000;
const resourceListCache = new Map<string, ListEntry<{ href: string; etag: string | null }>>();
const RESOURCE_LIST_TTL_MS = 15_000;

const icsCache = new Map<string, string>();
const ICS_CACHE_MAX = 5_000;

function rememberIcs(key: string, data: string): void {
  icsCache.delete(key);
  icsCache.set(key, data);
  if (icsCache.size <= ICS_CACHE_MAX) return;
  const drop = icsCache.size - ICS_CACHE_MAX;
  let i = 0;
  for (const k of icsCache.keys()) {
    if (i++ >= drop) break;
    icsCache.delete(k);
  }
}

const READ_METHODS = new Set(["PROPFIND", "REPORT", "GET", "HEAD", "OPTIONS"]);

export function resetCalDavCaches(): void {
  discoveryCache.clear();
  calendarListCache.clear();
  resourceListCache.clear();
  icsCache.clear();
}

function freshEntry<T extends { at: number }>(entry: T | undefined, ttl: number): T | null {
  if (!entry) return null;
  if (Date.now() - entry.at >= ttl) return null;
  return entry;
}

const NS = {
  D: "DAV:",
  C: "urn:ietf:params:xml:ns:caldav",
  CS: "http://calendarserver.org/ns/",
  A: "http://apple.com/ns/ical/",
};

export class CalDavClient {
  private readonly opts: CalDavOpts;
  private readonly origin: string;
  private readonly authHeader: string;
  private readonly cacheKey: string;

  constructor(opts: CalDavOpts) {
    this.opts = opts;
    const proto = opts.secure ? "https" : "http";
    this.origin = `${proto}://${opts.host}:${opts.port}`;
    this.authHeader = buildAuth(opts.creds);
    this.cacheKey = `cal|${this.origin}|${opts.creds.username}|${opts.basePath ?? ""}|${opts.principalPath ?? ""}`;
  }

  /** Find the principal URL via /.well-known/caldav (RFC 6764 §6). */
  async discoverPrincipal(): Promise<string> {
    if (this.opts.principalPath) return this.opts.principalPath;
    const cached = freshEntry(discoveryCache.get(this.cacheKey), DISCOVERY_TTL_MS);
    if (cached?.principal) return cached.principal;

    const start = this.opts.basePath ?? "/.well-known/caldav";
    const root = await this.followToCollection(start);
    const xml = await this.propfind(root, 0, ["DAV:current-user-principal"]);
    const principal = pickHref(xml, "current-user-principal") ?? root;
    this.rememberDiscovery({ principal });
    return principal;
  }

  /** From the principal URL, locate the calendar-home-set (slash-terminated). */
  async calendarHome(): Promise<string> {
    const cached = freshEntry(discoveryCache.get(this.cacheKey), DISCOVERY_TTL_MS);
    if (cached?.home) return cached.home;

    const principal = await this.discoverPrincipal();
    const xml = await this.propfind(principal, 0, [`${NS.C} calendar-home-set`]);
    const found = pickHref(xml, "calendar-home-set") ?? principal;
    const home = found.endsWith("/") ? found : found + "/";
    this.rememberDiscovery({ home });
    return home;
  }

  private rememberDiscovery(patch: { principal?: string; home?: string }): void {
    const existing = freshEntry(discoveryCache.get(this.cacheKey), DISCOVERY_TTL_MS);
    discoveryCache.set(this.cacheKey, {
      principal: patch.principal ?? existing?.principal,
      home: patch.home ?? existing?.home,
      at: existing?.at ?? Date.now(),
    });
  }

  /** Every calendar collection beneath the home set. */
  async listCalendars(): Promise<CalendarInfo[]> {
    const cached = freshEntry(calendarListCache.get(this.cacheKey), CALENDAR_LIST_TTL_MS);
    if (cached) return cached.items;

    const home = await this.calendarHome();
    const xml = await this.propfind(home, 1, [
      "DAV:resourcetype",
      "DAV:displayname",
      `${NS.C} calendar-description`,
      `${NS.C} supported-calendar-component-set`,
      `${NS.A} calendar-color`,
      `${NS.CS} getctag`,
      "DAV:sync-token",
    ]);

    const calendars: CalendarInfo[] = [];
    for (const r of splitResponses(xml)) {
      if (!hasResourceType(r, "calendar")) continue;
      const href = extractHref(r);
      if (!href) continue;
      const compBlock = textOf(r, "supported-calendar-component-set") ?? "";
      const components = [...compBlock.matchAll(/<(?:[A-Za-z][\w-]*:)?comp\b[^>]*\bname="([A-Z]+)"/g)].map((m) => m[1]!);
      const rawColor = textOf(r, "calendar-color");
      calendars.push({
        href,
        displayName: textOf(r, "displayname") ?? leafName(href),
        description: textOf(r, "calendar-description"),
        color: rawColor ? normaliseColor(rawColor) : null,
        components,
        ctag: textOf(r, "getctag") ?? textOf(r, "sync-token"),
      });
    }
    calendarListCache.set(this.cacheKey, { items: calendars, at: Date.now() });
    return calendars;
  }

  /** List the resources in one calendar collection. */
  async listResources(calHref: string): Promise<Array<{ href: string; etag: string | null }>> {
    const key = `${this.cacheKey}|${calHref}`;
    const cached = freshEntry(resourceListCache.get(key), RESOURCE_LIST_TTL_MS);
    if (cached) return cached.items;

    const xml = await this.propfind(calHref, 1, ["DAV:getetag", "DAV:resourcetype", "DAV:getcontenttype"]);
    const out: Array<{ href: string; etag: string | null }> = [];
    for (const r of splitResponses(xml)) {
      if (hasResourceType(r, "collection")) continue;
      const href = extractHref(r);
      if (!href) continue;
      out.push({ href, etag: textOf(r, "getetag") });
    }
    resourceListCache.set(key, { items: out, at: Date.now() });
    return out;
  }

  /**
   * Hrefs of the VEVENT resources overlapping [start, end) — a
   * `calendar-query` REPORT with a time-range filter (RFC 4791 §7.8.1). The
   * server does the recurrence-aware overlap test, so recurring masters
   * whose occurrences fall in the range come back too. Dates are UTC
   * `YYYYMMDDTHHMMSSZ`.
   */
  async queryRange(calHref: string, startUtc: string, endUtc: string): Promise<Array<{ href: string; etag: string | null }>> {
    const body =
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
      `<C:calendar-query xmlns:D="DAV:" xmlns:C="${NS.C}">\n` +
      `  <D:prop><D:getetag/></D:prop>\n` +
      `  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">` +
      `<C:time-range start="${startUtc}" end="${endUtc}"/>` +
      `</C:comp-filter></C:comp-filter></C:filter>\n` +
      `</C:calendar-query>`;
    const xml = await this.request("REPORT", calHref, body, { Depth: "1" });
    const out: Array<{ href: string; etag: string | null }> = [];
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      if (!href || href === calHref) continue;
      out.push({ href, etag: textOf(r, "getetag") });
    }
    return out;
  }

  private knownEtag(calHref: string, href: string): string | null {
    const cached = freshEntry(resourceListCache.get(`${this.cacheKey}|${calHref}`), RESOURCE_LIST_TTL_MS);
    return cached?.items.find((r) => r.href === href)?.etag ?? null;
  }

  private icsKey(href: string, etag: string): string {
    return `${this.cacheKey}|${href}|${etag}`;
  }

  /** Fetch a batch of resources via `calendar-multiget` (RFC 4791 §7.9). */
  async multiGet(calHref: string, hrefs: string[], etags: Map<string, string | null> = new Map()): Promise<CalendarResource[]> {
    if (hrefs.length === 0) return [];
    const out: CalendarResource[] = [];
    const toFetch: string[] = [];
    for (const href of hrefs) {
      const etag = etags.get(href) ?? this.knownEtag(calHref, href);
      const hit = etag ? icsCache.get(this.icsKey(href, etag)) : undefined;
      if (etag && hit !== undefined) out.push({ href, etag, data: hit });
      else toFetch.push(href);
    }
    if (toFetch.length === 0) return out;

    const body =
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
      `<C:calendar-multiget xmlns:D="DAV:" xmlns:C="${NS.C}">\n` +
      `  <D:prop><D:getetag/><C:calendar-data/></D:prop>\n` +
      toFetch.map((h) => `  <D:href>${escapeXml(h)}</D:href>`).join("\n") +
      `\n</C:calendar-multiget>`;
    const xml = await this.request("REPORT", calHref, body, { Depth: "1" });
    for (const r of splitResponses(xml)) {
      const href = extractHref(r);
      const data = textOf(r, "calendar-data");
      if (!href || !data) continue;
      const etag = textOf(r, "getetag");
      if (etag) rememberIcs(this.icsKey(href, etag), data);
      out.push({ href, etag, data });
    }
    return out;
  }

  // -- writes ---------------------------------------------------------------

  async putResource(href: string, ics: string, opts: { ifMatch?: string | null } = {}): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    else headers["If-None-Match"] = "*";
    const res = await this.raw("PUT", href, ics, headers);
    if (res.status === 412) throw new CalDavConflict(href);
    if (!res.ok) throw await httpError("PUT", href, res);
    return { etag: res.headers.get("etag") };
  }

  async deleteResource(href: string, opts: { ifMatch?: string | null } = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    const res = await this.raw("DELETE", href, null, headers);
    if (res.status === 412) throw new CalDavConflict(href);
    if (!res.ok && res.status !== 404) throw await httpError("DELETE", href, res);
  }

  /** MKCALENDAR (RFC 4791 §5.3.1) with display name, colour and component set. */
  async makeCalendar(
    href: string,
    props: { displayName: string; description?: string | null; color?: string | null; components?: string[] },
  ): Promise<void> {
    const comps = props.components && props.components.length > 0 ? props.components : ["VEVENT"];
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<C:mkcalendar xmlns:D="DAV:" xmlns:C="${NS.C}" xmlns:A="${NS.A}">\n` +
      `  <D:set><D:prop>\n` +
      `    <D:displayname>${escapeXml(props.displayName)}</D:displayname>\n` +
      (props.description ? `    <C:calendar-description>${escapeXml(props.description)}</C:calendar-description>\n` : "") +
      (props.color ? `    <A:calendar-color>${escapeXml(props.color)}</A:calendar-color>\n` : "") +
      `    <C:supported-calendar-component-set>${comps.map((c) => `<C:comp name="${c}"/>`).join("")}</C:supported-calendar-component-set>\n` +
      `  </D:prop></D:set>\n` +
      `</C:mkcalendar>`;
    const res = await this.raw("MKCALENDAR", href, body, { "Content-Type": "application/xml; charset=utf-8" });
    if (res.status === 405) throw new CalDavConflict(href);
    if (!res.ok) throw await httpError("MKCALENDAR", href, res);
  }

  /** PROPPATCH displayname / description / colour on a collection. */
  async updateCalendarProps(
    href: string,
    props: { displayName?: string; description?: string | null; color?: string | null },
  ): Promise<void> {
    const set: string[] = [];
    const remove: string[] = [];
    if (props.displayName !== undefined) set.push(`<D:displayname>${escapeXml(props.displayName)}</D:displayname>`);
    if (props.description !== undefined) {
      if (props.description) set.push(`<C:calendar-description>${escapeXml(props.description)}</C:calendar-description>`);
      else remove.push(`<C:calendar-description/>`);
    }
    if (props.color !== undefined) {
      if (props.color) set.push(`<A:calendar-color>${escapeXml(props.color)}</A:calendar-color>`);
      else remove.push(`<A:calendar-color/>`);
    }
    if (set.length === 0 && remove.length === 0) return;
    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<D:propertyupdate xmlns:D="DAV:" xmlns:C="${NS.C}" xmlns:A="${NS.A}">\n` +
      (set.length ? `  <D:set><D:prop>${set.join("")}</D:prop></D:set>\n` : "") +
      (remove.length ? `  <D:remove><D:prop>${remove.join("")}</D:prop></D:remove>\n` : "") +
      `</D:propertyupdate>`;
    const res = await this.raw("PROPPATCH", href, body, { "Content-Type": "application/xml; charset=utf-8" });
    if (!res.ok && res.status !== 207) throw await httpError("PROPPATCH", href, res);
    const text = await res.text();
    if (/HTTP\/1\.[01] (4\d\d|5\d\d)/.test(text)) {
      throw new Error(`CalDAV PROPPATCH ${href} → property failure: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Forward an arbitrary DAV request from a client (the webmail's MKCALENDAR
   * path) to the server and hand the raw response back.
   */
  async proxy(method: string, href: string, body: Buffer | null, headers: Record<string, string>): Promise<Response> {
    return this.raw(method, href, body, headers);
  }

  // -- low-level ----------------------------------------------------------

  private async raw(method: string, path: string, body: string | Buffer | null, headers: Record<string, string> = {}): Promise<Response> {
    const url = absolutise(this.origin, path);
    if (!READ_METHODS.has(method.toUpperCase())) {
      calendarListCache.delete(this.cacheKey);
      for (const k of resourceListCache.keys()) if (k.startsWith(this.cacheKey + "|")) resourceListCache.delete(k);
    }
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.authHeader, ...headers },
      ...(body === null ? {} : { body: body as BodyInit }),
    });
    log.debug({ method, url, status: res.status }, "caldav request");
    return res;
  }

  private async followToCollection(path: string): Promise<string> {
    let url = absolutise(this.origin, path);
    for (let i = 0; i < 4; i++) {
      const res = await fetch(url, {
        method: "PROPFIND",
        headers: { Authorization: this.authHeader, Depth: "0", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
        redirect: "manual",
      });
      log.debug({ url, status: res.status }, "caldav discovery probe");
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        url = absolutise(this.origin, loc);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`CalDAV ${res.status}: auth required`);
      const u = new URL(url);
      return u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
    }
    throw new Error("CalDAV: too many redirects in discovery");
  }

  private async propfind(path: string, depth: 0 | 1, props: string[]): Promise<string> {
    const prefixes = new Map<string, string>(Object.entries(NS).map(([p, uri]) => [uri, p]));
    const propXml = props
      .map((p) => {
        const [uri, name] = splitProp(p);
        let prefix = prefixes.get(uri);
        if (!prefix) {
          prefix = `n${prefixes.size}`;
          prefixes.set(uri, prefix);
        }
        return `<${prefix}:${name}/>`;
      })
      .join("");
    const decls = [...prefixes.entries()].map(([uri, p]) => `xmlns:${p}="${uri}"`).join(" ");
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:propfind ${decls}>\n  <D:prop>${propXml}</D:prop>\n</D:propfind>`;
    return this.request("PROPFIND", path, body, { Depth: String(depth) });
  }

  private async request(method: string, path: string, body: string, extra: Record<string, string> = {}): Promise<string> {
    const res = await this.raw(method, path, body, { "Content-Type": "application/xml; charset=utf-8", ...extra });
    if (!res.ok && res.status !== 207) throw await httpError(method, path, res);
    return await res.text();
  }
}

export class CalDavConflict extends Error {
  constructor(readonly href: string) {
    super(`CalDAV conflict on ${href}`);
  }
}

async function httpError(method: string, path: string, res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  log.warn({ method, path, status: res.status }, "caldav request failed");
  return new Error(`CalDAV ${method} ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
}

/** Apple's calendar-color carries an alpha byte (`#RRGGBBAA`); JMAP wants CSS. */
export function normaliseColor(raw: string): string {
  const s = raw.trim();
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s);
  if (m && m[1]) return `#${m[1].toLowerCase()}`;
  return s;
}
