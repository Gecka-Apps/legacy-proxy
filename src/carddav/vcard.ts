// vCard 3.0 / 4.0 parser → JSContact (RFC 9553) projection used by JMAP for
// Contacts (RFC 9610), and the reverse serialiser used by ContactCard/set.
// The property mapping follows RFC 9555 (JSContact ⇄ vCard): PROP-ID keeps
// the JSContact object keys across a round trip, a vCard property group ties
// an X-ABLabel to the property it labels and a TITLE to its ORG, and JSPROP
// carries the few JSContact values vCard has no property for. Properties the
// projection does not model are passed through untouched on update.

import { Buffer } from "node:buffer";
import type { DavFlavor } from "../util/config.js";

type Contexts = Record<string, boolean>;

export interface JsContact {
  uid: string;
  kind?: "individual" | "group" | "org" | "location" | "device" | "application";
  language?: string;
  created?: string;
  updated?: string;
  prodId?: string;
  name?: {
    full?: string;
    components?: Array<{
      kind:
        | "given"
        | "surname"
        | "prefix"
        | "suffix"
        | "additional"
        | "separator"
        | "credential"
        | "title"
        | "middle"
        | "given2"
        | "surname2"
        | "generation";
      value: string;
    }>;
    isOrdered?: boolean;
    defaultSeparator?: string;
    sortAs?: Record<string, string>;
  };
  nicknames?: Record<string, { name: string; contexts?: Contexts; pref?: number }>;
  emails?: Record<string, { address: string; contexts?: Contexts; label?: string; pref?: number }>;
  phones?: Record<string, { number: string; contexts?: Contexts; features?: Record<string, boolean>; label?: string; pref?: number }>;
  onlineServices?: Record<
    string,
    { service?: string; uri?: string; user?: string; vCardName?: string; contexts?: Contexts; label?: string; pref?: number }
  >;
  preferredLanguages?: Record<string, { language: string; contexts?: Contexts; pref?: number }>;
  organizations?: Record<string, { name?: string; units?: Array<{ name: string }>; sortAs?: string; contexts?: Contexts }>;
  titles?: Record<string, { name: string; kind?: "title" | "role"; organizationId?: string }>;
  addresses?: Record<
    string,
    {
      components?: Array<{ kind: string; value: string }>;
      full?: string;
      isOrdered?: boolean;
      defaultSeparator?: string;
      countryCode?: string;
      coordinates?: string;
      timeZone?: string;
      contexts?: Contexts;
      label?: string;
      pref?: number;
      // Flat fields kept for the webmail UI's legacy reader.
      street?: string;
      locality?: string;
      region?: string;
      postcode?: string;
      country?: string;
    }
  >;
  anniversaries?: Record<string, { kind: "birth" | "death" | "wedding" | "other"; date: string | AnniversaryDate; place?: { full?: string } }>;
  personalInfo?: Record<string, { kind: "expertise" | "hobby" | "interest" | "other"; value: string; level?: "high" | "medium" | "low"; listAs?: number }>;
  notes?: Record<string, { note: string; created?: string; author?: { name?: string; uri?: string } }>;
  media?: Record<string, { kind: "photo" | "logo" | "sound"; uri: string; mediaType?: string; contexts?: Contexts; label?: string; pref?: number }>;
  cryptoKeys?: Record<string, { uri: string; mediaType?: string; contexts?: Contexts; pref?: number }>;
  directories?: Record<string, { uri: string; kind?: "directory" | "entry"; mediaType?: string; listAs?: number; pref?: number }>;
  links?: Record<string, { uri: string; kind?: "contact" | "generic"; mediaType?: string; contexts?: Contexts; label?: string; pref?: number }>;
  calendars?: Record<string, { uri: string; kind?: "calendar" | "freeBusy"; mediaType?: string; contexts?: Contexts; pref?: number }>;
  schedulingAddresses?: Record<string, { uri: string; contexts?: Contexts; pref?: number }>;
  /** The webmail's flat view of the first calendar, free-busy and scheduling URIs. */
  calendarUri?: string;
  freeBusyUri?: string;
  schedulingUri?: string;
  relatedTo?: Record<string, { relation?: Record<string, boolean> }>;
  keywords?: Record<string, boolean>;
  /** Group membership (KIND:group): map of member UID/URI → true. */
  members?: Record<string, boolean>;
  speakToAs?: {
    grammaticalGender?: string;
    pronouns?: Record<string, { pronouns: string; contexts?: Contexts; pref?: number }>;
  };
}

/** RFC 9553 §1.5.5 date shapes a client may send for anniversaries. */
export type AnniversaryDate =
  | { "@type"?: "Timestamp"; utc: string }
  | { "@type"?: "PartialDate"; year?: number; month?: number; day?: number; calendarScale?: string };

interface ParsedLine {
  group: string | null;
  name: string;
  params: Record<string, string[]>;
  value: string;
}

/**
 * Parse a vCard 3.0/4.0 text body. Returns one JsContact per `BEGIN:VCARD` /
 * `END:VCARD` block. Tolerant of folded lines (RFC 6350 §3.2), unknown
 * properties, and non-ASCII content.
 */
export function parseVCards(text: string): JsContact[] {
  const lines = unfold(text).split(/\r?\n/);
  const out: JsContact[] = [];
  let current: ParsedLine[] | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCARD") {
      current = [];
      continue;
    }
    if (upper === "END:VCARD") {
      if (current) out.push(toJsContact(current));
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(line);
    if (parsed) current.push(parsed);
  }
  return out;
}

function unfold(text: string): string {
  // RFC 6350 §3.2: a line wrapped at 75 octets is folded by inserting CRLF
  // followed by a single whitespace. To unfold, drop those join points.
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseLine(line: string): ParsedLine | null {
  // Property syntax:  GROUP.NAME;PARAM=val;PARAM=val:value
  // Values can contain ":" if escaped or inside quoted parameters; we look
  // for the first unquoted ":".
  let i = 0;
  let inQuote = false;
  let colonIdx = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx < 0) return null;

  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segs = splitUnquoted(head, ";");
  if (segs.length === 0) return null;
  const namePart = segs[0];
  if (!namePart) return null;
  const dot = namePart.indexOf(".");
  const group = dot >= 0 ? namePart.slice(0, dot) : null;
  const name = (dot >= 0 ? namePart.slice(dot + 1) : namePart).toUpperCase();

  // Parameter names are case-insensitive, values are not: PROP-ID, LABEL,
  // MEDIATYPE, JSPTR and the like must come back exactly as written. TYPE
  // values are compared case-insensitively where they are read.
  const params: Record<string, string[]> = {};
  for (let s = 1; s < segs.length; s++) {
    const seg = segs[s]!;
    const eq = seg.indexOf("=");
    if (eq < 0) {
      // vCard 2.1 bare type, e.g. "HOME"
      params["TYPE"] = (params["TYPE"] ?? []).concat(seg);
      continue;
    }
    const k = seg.slice(0, eq).toUpperCase();
    const v = seg.slice(eq + 1);
    // TYPE and SORT-AS carry comma-separated lists, quoted or not.
    const values = splitUnquoted(v, ",")
      .map((x) => stripQuotes(x))
      .flatMap((x) => (k === "TYPE" || k === "SORT-AS" ? x.split(",") : [x]));
    params[k] = (params[k] ?? []).concat(values);
  }
  return { group, name, params, value };
}

function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
    } else if (ch === sep && !inQuote) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

/** Split a text value on unescaped separators (`\,` and `\;` stay in place). */
function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      buf += ch + s[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function unescapeValue(v: string): string {
  return v.replace(/\\([nN,;:\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function param(p: ParsedLine, name: string): string | undefined {
  const v = p.params[name]?.[0];
  return v === undefined || v === "" ? undefined : v;
}

function typeValues(p: ParsedLine): string[] {
  return (p.params["TYPE"] ?? []).map((x) => x.toLowerCase());
}

function contextsOf(p: ParsedLine): Contexts | undefined {
  const types = typeValues(p);
  const ctx: Contexts = {};
  if (types.includes("home")) ctx["private"] = true;
  if (types.includes("work")) ctx["work"] = true;
  return Object.keys(ctx).length ? ctx : undefined;
}

function prefOf(p: ParsedLine): number | undefined {
  const n = parseFloat(param(p, "PREF") ?? "");
  return Number.isFinite(n) ? n : undefined;
}

function intOf(p: ParsedLine, name: string): number | undefined {
  const n = parseInt(param(p, name) ?? "", 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Drop undefined members so the JSON the client sees carries only what is set. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

/** vCard 3.0 inline binary (`ENCODING=b` + `TYPE=JPEG`) → the data URI vCard 4.0 uses. */
function mediaUri(p: ParsedLine, fallbackType: string): { uri: string; mediaType?: string } {
  const value = p.value.trim();
  const encoding = (param(p, "ENCODING") ?? "").toLowerCase();
  if (encoding === "b" || encoding === "base64") {
    const type = param(p, "MEDIATYPE") ?? typeValues(p).find((t) => t !== "pref") ?? "";
    const mime = type.includes("/") ? type : type ? `${fallbackType}/${type}` : fallbackType;
    return { uri: `data:${mime};base64,${value.replace(/\s+/g, "")}`, mediaType: mime };
  }
  const uri = unescapeValue(value);
  const explicit = param(p, "MEDIATYPE");
  if (explicit) return { uri, mediaType: explicit };
  const data = /^data:([^;,]+)[;,]/i.exec(uri);
  return data?.[1] ? { uri, mediaType: data[1] } : { uri };
}

// -- dates -------------------------------------------------------------------

/**
 * vCard date-and-or-time (RFC 6350 §4.3) → RFC 9553 Timestamp or
 * PartialDate. A value that does not fit either shape is returned as text.
 */
function parseDate(raw: string, valueType: string | undefined): string | AnniversaryDate {
  const v = raw.trim();
  if (valueType?.toLowerCase() === "text") return v;
  const stamp = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (stamp) {
    const [, y, mo, d, h, mi, s, tz] = stamp;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz ? tz.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z"}`;
    const t = new Date(iso);
    if (!Number.isNaN(t.getTime())) return { "@type": "Timestamp", utc: t.toISOString().replace(/\.\d{3}Z$/, "Z") };
  }
  const partial = (year?: string, month?: string, day?: string): AnniversaryDate =>
    compact({
      "@type": "PartialDate" as const,
      year: year ? parseInt(year, 10) : undefined,
      month: month ? parseInt(month, 10) : undefined,
      day: day ? parseInt(day, 10) : undefined,
    });
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v))) return partial(m[1], m[2], m[3]);
  if ((m = /^(\d{4})-(\d{2})$/.exec(v))) return partial(m[1], m[2]);
  if ((m = /^--(\d{2})-?(\d{2})$/.exec(v))) return partial(undefined, m[1], m[2]);
  if ((m = /^--(\d{2})$/.exec(v))) return partial(undefined, m[1]);
  if ((m = /^---(\d{2})$/.exec(v))) return partial(undefined, undefined, m[1]);
  if ((m = /^(\d{4})$/.exec(v))) return partial(m[1]);
  return v;
}

/** vCard timestamp (`20260820T000000Z`) → RFC 9553 UTCDateTime; anything else passes through. */
function parseTimestamp(raw: string): string {
  const d = parseDate(raw, undefined);
  return typeof d === "object" && "utc" in d ? d.utc : raw.trim();
}

function formatTimestamp(v: string): string | null {
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return v.trim() || null;
  return t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function formatDate(d: string | AnniversaryDate | undefined): string | null {
  if (!d) return null;
  if (typeof d === "string") {
    const v = d.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) return `${m[1]}${m[2]}${m[3]}`;
    if ((m = /^--(\d{2})-(\d{2})$/.exec(v))) return `--${m[1]}${m[2]}`;
    return v || null;
  }
  if ("utc" in d && d.utc) return formatTimestamp(d.utc);
  const pd = d as { year?: number; month?: number; day?: number };
  const yy = pd.year != null ? String(pd.year).padStart(4, "0") : null;
  const mm = pd.month != null ? String(pd.month).padStart(2, "0") : null;
  const dd = pd.day != null ? String(pd.day).padStart(2, "0") : null;
  if (yy && mm && dd) return `${yy}${mm}${dd}`;
  if (yy && mm) return `${yy}-${mm}`;
  if (mm && dd) return `--${mm}${dd}`;
  if (mm) return `--${mm}`;
  if (dd) return `---${dd}`;
  if (yy) return yy;
  return null;
}

// -- vCard → JSContact --------------------------------------------------------

/** Where a parsed property landed, so a grouped X-ABLabel can find it. */
interface Placed {
  collection: keyof JsContact;
  key: string;
}

function toJsContact(props: ParsedLine[]): JsContact {
  const c: JsContact = { uid: "" };
  const counters: Record<string, number> = {};
  const byGroup = new Map<string, Placed[]>();
  const labels = new Map<string, string>();
  const orgByGroup = new Map<string, string[]>();
  const titleGroups: Array<{ key: string; group: string }> = [];
  const patches: Array<{ pointer: string; value: unknown }> = [];

  // Key of a multi-valued entry: PROP-ID when the card carries one (RFC 9554
  // §4.7), else a counter so a card written by another client still projects.
  const keyFor = (p: ParsedLine, prefix: string): string => {
    const id = param(p, "PROP-ID");
    if (id && /^[A-Za-z0-9_-]+$/.test(id)) return id;
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}${counters[prefix]}`;
  };
  const place = (p: ParsedLine, collection: keyof JsContact, key: string): void => {
    if (!p.group) return;
    const list = byGroup.get(p.group) ?? [];
    list.push({ collection, key });
    byGroup.set(p.group, list);
  };
  const mapOf = <K extends keyof JsContact>(k: K): NonNullable<JsContact[K]> => {
    if (c[k] === undefined) (c as unknown as Record<string, unknown>)[k] = {};
    return c[k] as NonNullable<JsContact[K]>;
  };

  for (const p of props) {
    switch (p.name) {
      case "VERSION":
        break;
      case "UID":
        c.uid = unescapeValue(p.value);
        break;
      case "FN": {
        c.name = c.name ?? {};
        c.name.full = unescapeValue(p.value);
        break;
      }
      case "N": {
        // surname;given;additional;prefix;suffix
        const parts = splitEscaped(p.value, ";").map(unescapeValue);
        const components: NonNullable<JsContact["name"]>["components"] = [];
        const map = [
          { kind: "surname", idx: 0 },
          { kind: "given", idx: 1 },
          { kind: "additional", idx: 2 },
          { kind: "prefix", idx: 3 },
          { kind: "suffix", idx: 4 },
        ] as const;
        for (const m of map) {
          const v = parts[m.idx];
          if (v) components.push({ kind: m.kind, value: v });
        }
        c.name = c.name ?? {};
        if (components.length > 0) c.name.components = components;
        const sortAs = p.params["SORT-AS"];
        if (sortAs?.[0]) {
          c.name.sortAs = compact({ surname: sortAs[0] || undefined, given: sortAs[1] || undefined }) as Record<string, string>;
        }
        break;
      }
      case "NICKNAME": {
        const key = keyFor(p, "n");
        mapOf("nicknames")[key] = compact({ name: unescapeValue(p.value), contexts: contextsOf(p), pref: prefOf(p) });
        place(p, "nicknames", key);
        break;
      }
      case "EMAIL": {
        const key = keyFor(p, "e");
        mapOf("emails")[key] = compact({ address: unescapeValue(p.value), contexts: contextsOf(p), pref: prefOf(p) });
        place(p, "emails", key);
        break;
      }
      case "TEL": {
        const key = keyFor(p, "p");
        const types = typeValues(p);
        const features: Record<string, boolean> = {};
        if (types.includes("cell") || types.includes("mobile")) features["mobile"] = true;
        if (types.includes("fax")) features["fax"] = true;
        if (types.includes("voice")) features["voice"] = true;
        if (types.includes("text") || types.includes("sms")) features["text"] = true;
        if (types.includes("video")) features["video"] = true;
        if (types.includes("pager")) features["pager"] = true;
        if (types.includes("textphone")) features["textphone"] = true;
        if (types.includes("main-number")) features["main-number"] = true;
        mapOf("phones")[key] = compact({
          number: unescapeValue(p.value.replace(/^tel:/i, "")),
          contexts: contextsOf(p),
          features: Object.keys(features).length ? features : undefined,
          pref: prefOf(p),
        });
        place(p, "phones", key);
        break;
      }
      case "IMPP":
      case "SOCIALPROFILE": {
        const key = keyFor(p, "os");
        const asText = (param(p, "VALUE") ?? "").toLowerCase() === "text";
        const value = unescapeValue(p.value);
        mapOf("onlineServices")[key] = compact({
          service: param(p, "SERVICE-TYPE") ?? (p.name === "IMPP" ? param(p, "X-SERVICE-TYPE") : undefined),
          uri: asText ? undefined : value,
          user: asText ? value : param(p, "USERNAME"),
          vCardName: p.name === "IMPP" ? "impp" : undefined,
          contexts: contextsOf(p),
          pref: prefOf(p),
        });
        place(p, "onlineServices", key);
        break;
      }
      case "LANG": {
        const key = keyFor(p, "lang");
        mapOf("preferredLanguages")[key] = compact({ language: unescapeValue(p.value), contexts: contextsOf(p), pref: prefOf(p) });
        break;
      }
      case "ORG": {
        const parts = splitEscaped(p.value, ";").map(unescapeValue);
        if (parts.every((x) => !x)) break;
        const key = keyFor(p, "o");
        const [name, ...units] = parts;
        const sortAs = param(p, "SORT-AS");
        mapOf("organizations")[key] = compact({
          name: name || undefined,
          units: units.filter(Boolean).length ? units.filter(Boolean).map((u) => ({ name: u })) : undefined,
          sortAs,
          contexts: contextsOf(p),
        });
        place(p, "organizations", key);
        if (p.group) orgByGroup.set(p.group, [...(orgByGroup.get(p.group) ?? []), key]);
        break;
      }
      case "TITLE":
      case "ROLE": {
        const key = keyFor(p, "t");
        mapOf("titles")[key] = { name: unescapeValue(p.value), kind: p.name === "ROLE" ? "role" : "title" };
        if (p.group) titleGroups.push({ key, group: p.group });
        break;
      }
      case "ADR": {
        // pobox;ext;street;locality;region;postcode;country
        const parts = splitEscaped(p.value, ";").map(unescapeValue);
        const key = keyFor(p, "a");
        const components: Array<{ kind: string; value: string }> = [];
        const pobox = parts[0] ?? "";
        const ext = parts[1] ?? "";
        const street = parts[2] ?? "";
        const locality = parts[3] ?? "";
        const region = parts[4] ?? "";
        const postcode = parts[5] ?? "";
        const country = parts[6] ?? "";
        if (pobox) components.push({ kind: "postOfficeBox", value: pobox });
        if (ext) components.push({ kind: "apartment", value: ext });
        if (street) components.push({ kind: "name", value: street });
        if (locality) components.push({ kind: "locality", value: locality });
        if (region) components.push({ kind: "region", value: region });
        if (postcode) components.push({ kind: "postcode", value: postcode });
        if (country) components.push({ kind: "country", value: country });
        mapOf("addresses")[key] = compact({
          components: components.length ? components : undefined,
          full: param(p, "LABEL") ? unescapeValue(param(p, "LABEL")!) : undefined,
          countryCode: param(p, "CC"),
          coordinates: param(p, "GEO"),
          timeZone: param(p, "TZ"),
          contexts: contextsOf(p),
          pref: prefOf(p),
          street: street || undefined,
          locality: locality || undefined,
          region: region || undefined,
          postcode: postcode || undefined,
          country: country || undefined,
        });
        place(p, "addresses", key);
        break;
      }
      case "NOTE": {
        const key = keyFor(p, "n");
        const authorName = param(p, "AUTHOR-NAME");
        const authorUri = param(p, "AUTHOR");
        mapOf("notes")[key] = compact({
          note: unescapeValue(p.value),
          created: param(p, "CREATED") ? parseTimestamp(param(p, "CREATED")!) : undefined,
          author: authorName || authorUri ? compact({ name: authorName, uri: authorUri }) : undefined,
        });
        break;
      }
      case "URL":
      case "CONTACT-URI": {
        const key = keyFor(p, "l");
        mapOf("links")[key] = compact({
          uri: unescapeValue(p.value),
          kind: p.name === "CONTACT-URI" ? "contact" : "generic",
          mediaType: param(p, "MEDIATYPE"),
          contexts: contextsOf(p),
          pref: prefOf(p),
        });
        place(p, "links", key);
        break;
      }
      case "PHOTO":
      case "LOGO":
      case "SOUND": {
        const key = keyFor(p, p.name === "PHOTO" ? "photo" : p.name === "LOGO" ? "logo" : "sound");
        const { uri, mediaType } = mediaUri(p, p.name === "SOUND" ? "audio" : "image");
        mapOf("media")[key] = compact({
          kind: p.name === "PHOTO" ? "photo" : p.name === "LOGO" ? "logo" : "sound",
          uri,
          mediaType,
          contexts: contextsOf(p),
          pref: prefOf(p),
        });
        place(p, "media", key);
        break;
      }
      case "KEY": {
        const key = keyFor(p, "k");
        const { uri, mediaType } = mediaUri(p, "application");
        mapOf("cryptoKeys")[key] = compact({ uri, mediaType, contexts: contextsOf(p), pref: prefOf(p) });
        break;
      }
      case "SOURCE":
      case "ORG-DIRECTORY": {
        const key = keyFor(p, "d");
        mapOf("directories")[key] = compact({
          uri: unescapeValue(p.value),
          kind: p.name === "SOURCE" ? "entry" : "directory",
          mediaType: param(p, "MEDIATYPE"),
          listAs: intOf(p, "INDEX"),
          pref: prefOf(p),
        });
        break;
      }
      case "CALURI":
      case "FBURL": {
        const key = keyFor(p, "cal");
        const uri = unescapeValue(p.value);
        mapOf("calendars")[key] = compact({
          uri,
          kind: p.name === "FBURL" ? "freeBusy" : "calendar",
          mediaType: param(p, "MEDIATYPE"),
          contexts: contextsOf(p),
          pref: prefOf(p),
        });
        if (p.name === "CALURI") c.calendarUri = c.calendarUri ?? uri;
        else c.freeBusyUri = c.freeBusyUri ?? uri;
        break;
      }
      case "CALADRURI": {
        const key = keyFor(p, "sched");
        const uri = unescapeValue(p.value);
        mapOf("schedulingAddresses")[key] = compact({ uri, contexts: contextsOf(p), pref: prefOf(p) });
        c.schedulingUri = c.schedulingUri ?? uri;
        break;
      }
      case "RELATED": {
        const uri = unescapeValue(p.value);
        if (!uri) break;
        const relation: Record<string, boolean> = {};
        for (const t of typeValues(p)) relation[t] = true;
        mapOf("relatedTo")[uri] = Object.keys(relation).length ? { relation } : {};
        break;
      }
      case "CATEGORIES": {
        for (const k of splitEscaped(p.value, ",").map(unescapeValue)) {
          if (k.trim()) mapOf("keywords")[k.trim()] = true;
        }
        break;
      }
      case "EXPERTISE":
      case "HOBBY":
      case "INTEREST": {
        const key = keyFor(p, "pi");
        const level = (param(p, "LEVEL") ?? "").toLowerCase();
        mapOf("personalInfo")[key] = compact({
          kind: p.name === "EXPERTISE" ? "expertise" : p.name === "HOBBY" ? "hobby" : "interest",
          value: unescapeValue(p.value),
          level: level === "high" || level === "medium" || level === "low" ? level : level === "beginner" ? "low" : level === "average" ? "medium" : level === "expert" ? "high" : undefined,
          listAs: intOf(p, "INDEX"),
        });
        break;
      }
      case "GRAMGENDER": {
        c.speakToAs = c.speakToAs ?? {};
        c.speakToAs.grammaticalGender = unescapeValue(p.value).toLowerCase();
        break;
      }
      case "PRONOUNS": {
        const key = keyFor(p, "pr");
        c.speakToAs = c.speakToAs ?? {};
        c.speakToAs.pronouns = c.speakToAs.pronouns ?? {};
        c.speakToAs.pronouns[key] = compact({ pronouns: unescapeValue(p.value), contexts: contextsOf(p), pref: prefOf(p) });
        break;
      }
      case "BDAY":
      case "DEATHDATE":
      case "ANNIVERSARY": {
        const key = keyFor(p, p.name === "BDAY" ? "b" : p.name === "DEATHDATE" ? "d" : "w");
        const kind = p.name === "BDAY" ? "birth" : p.name === "DEATHDATE" ? "death" : "wedding";
        const existing = mapOf("anniversaries")[key];
        mapOf("anniversaries")[key] = { ...(existing ?? {}), kind, date: parseDate(unescapeValue(p.value), param(p, "VALUE")) };
        break;
      }
      case "BIRTHPLACE":
      case "DEATHPLACE": {
        // Pairs with the BDAY / DEATHDATE of the same PROP-ID, else the first
        // anniversary of that kind.
        const kind = p.name === "BIRTHPLACE" ? "birth" : "death";
        const wanted = param(p, "PROP-ID");
        const anns = mapOf("anniversaries");
        let key = wanted && anns[wanted] ? wanted : Object.keys(anns).find((k) => anns[k]!.kind === kind);
        if (!key) {
          key = wanted && /^[A-Za-z0-9_-]+$/.test(wanted) ? wanted : keyFor(p, kind === "birth" ? "b" : "d");
          anns[key] = { kind, date: "" };
        }
        anns[key]!.place = { full: unescapeValue(p.value) };
        break;
      }
      case "LANGUAGE":
        c.language = unescapeValue(p.value);
        break;
      case "CREATED":
        c.created = parseTimestamp(unescapeValue(p.value));
        break;
      case "REV":
        c.updated = parseTimestamp(unescapeValue(p.value));
        break;
      case "PRODID":
        c.prodId = unescapeValue(p.value);
        break;
      case "KIND":
      case "X-ADDRESSBOOKSERVER-KIND": {
        const k = unescapeValue(p.value).toLowerCase();
        if (k === "individual" || k === "group" || k === "org" || k === "location" || k === "device" || k === "application") {
          c.kind = k;
        }
        break;
      }
      case "MEMBER":
      case "X-ADDRESSBOOKSERVER-MEMBER": {
        const uri = unescapeValue(p.value);
        if (!uri) break;
        mapOf("members")[uri] = true;
        break;
      }
      case "X-ABLABEL": {
        if (p.group) labels.set(p.group, unescapeValue(p.value));
        break;
      }
      case "JSPROP": {
        const pointer = param(p, "JSPTR");
        if (!pointer) break;
        try {
          patches.push({ pointer, value: JSON.parse(unescapeValue(p.value)) });
        } catch {
          // Not JSON: nothing to restore.
        }
        break;
      }
    }
  }

  // Labels ride on the property group (RFC 9555 §2.14 X-ABLabel).
  for (const [group, label] of labels) {
    for (const { collection, key } of byGroup.get(group) ?? []) {
      const entry = (c[collection] as Record<string, Record<string, unknown>> | undefined)?.[key];
      if (entry) entry["label"] = label;
    }
  }
  // A TITLE grouped with exactly one ORG belongs to that organization.
  for (const { key, group } of titleGroups) {
    const orgs = orgByGroup.get(group);
    if (orgs?.length === 1 && c.titles?.[key]) c.titles[key].organizationId = orgs[0];
  }
  // RFC 9555 §3.2: JSPROP entries form a PatchObject applied last.
  for (const { pointer, value } of patches) setPointer(c as unknown as Record<string, unknown>, pointer, value);

  if (!c.uid) {
    // Some servers don't include UID. Synthesize a stable one from FN/EMAIL.
    const seed = (c.name?.full ?? "") + "|" + (c.emails ? Object.values(c.emails)[0]?.address ?? "" : "");
    c.uid = `urn:vcard:${hashString(seed)}`;
  }
  c.kind = c.kind ?? "individual";
  return c;
}

/** Set a value at a PatchObject path (`a/b/c`, JSON Pointer escapes honoured). */
function setPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const segs = pointer.replace(/^\//, "").split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segs.length === 0 || segs[0] === "") return;
  let cur = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    const next = cur[s];
    if (!next || typeof next !== "object") cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1]!;
  if (value === null) delete cur[last];
  else cur[last] = value;
}

// ---------------------------------------------------------------------------
// JSContact → vCard 4.0 serialisation (the write path for ContactCard/set).
// ---------------------------------------------------------------------------

/**
 * vCard property names the JSContact projection above models. Everything
 * else in an existing card (X-*, GEO, TZ, …) is opaque to us and is carried
 * over verbatim on update so we never destroy data we don't understand.
 */
const MANAGED_PROPS = new Set([
  "BEGIN",
  "END",
  "VERSION",
  "PRODID",
  "REV",
  "CREATED",
  "UID",
  "FN",
  "N",
  "NICKNAME",
  "EMAIL",
  "TEL",
  "IMPP",
  "SOCIALPROFILE",
  "LANG",
  "ORG",
  "TITLE",
  "ROLE",
  "ADR",
  "NOTE",
  "URL",
  "CONTACT-URI",
  "PHOTO",
  "LOGO",
  "SOUND",
  "KEY",
  "SOURCE",
  "ORG-DIRECTORY",
  "CALURI",
  "FBURL",
  "CALADRURI",
  "RELATED",
  "CATEGORIES",
  "EXPERTISE",
  "HOBBY",
  "INTEREST",
  "GRAMGENDER",
  "PRONOUNS",
  "BDAY",
  "ANNIVERSARY",
  "DEATHDATE",
  "BIRTHPLACE",
  "DEATHPLACE",
  "LANGUAGE",
  "KIND",
  "X-ADDRESSBOOKSERVER-KIND",
  "MEMBER",
  "X-ADDRESSBOOKSERVER-MEMBER",
  "JSPROP",
]);

export const PRODID = "-//Bulwark//legacy-proxy//EN";

export interface SerializeOpts {
  /**
   * The vCard text the card was loaded from. Properties we don't model are
   * copied through unchanged so a round trip through JMAP is lossless for
   * them.
   */
  preserveFrom?: string;
  /** Override REV (defaults to now). Tests pass a fixed value. */
  rev?: string;
  /**
   * The server the card is written to. `radicale` rewrites every card
   * through vobject, which cuts a value at its first unescaped comma, so
   * URIs are text-escaped and inline media goes out as ENCODING=b binary;
   * every other flavor gets the RFC 6350 forms.
   */
  flavor?: DavFlavor;
}

type Params = Record<string, string[] | undefined>;

/** Serialise one JSContact as a vCard 4.0 body (CRLF line endings). */
export function serializeVCard(c: JsContact, opts: SerializeOpts = {}): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:4.0", `PRODID:${escapeValue(PRODID)}`];
  const preserved = opts.preserveFrom ? unmanagedLines(opts.preserveFrom) : [];
  // Groups already used by preserved lines stay out of reach of the ones
  // minted below for labels and organization links.
  const takenGroups = new Set(preserved.map((l) => groupOf(l)).filter((g): g is string => g !== null));
  let groupSeq = 0;
  const newGroup = (): string => {
    let g: string;
    do g = `g${++groupSeq}`;
    while (takenGroups.has(g));
    return g;
  };

  const push = (name: string, params: Params, value: string, group?: string | null) => {
    let head = group ? `${group}.${name}` : name;
    for (const [k, vs] of Object.entries(params)) {
      if (!vs || vs.length === 0) continue;
      head += `;${k}=${vs.map(quoteParam).join(",")}`;
    }
    lines.push(`${head}:${value}`);
  };
  const propId = (key: string): string[] | undefined => (/^[A-Za-z0-9_-]+$/.test(key) ? [key] : undefined);
  // A labelled entry gets its own group so the X-ABLabel line can name it.
  const labelled = (label: string | undefined, group: string | null): string | null => {
    if (!label) return group;
    const g = group ?? newGroup();
    push("X-ABLabel", {}, escapeValue(label), g);
    return g;
  };
  const vobject = opts.flavor === "radicale";
  const uriText = (v: string): string => (vobject ? escapeValue(v) : v.replace(/[\r\n]/g, ""));
  const jsprop = (pointer: string, value: unknown) => {
    push("JSPROP", { JSPTR: [pointer] }, escapeValue(JSON.stringify(value)));
  };

  push("UID", {}, escapeValue(c.uid));
  if (c.kind && c.kind !== "individual") push("KIND", {}, c.kind);
  if (c.language) push("LANGUAGE", {}, escapeValue(c.language));
  if (c.created) {
    const stamp = formatTimestamp(c.created);
    if (stamp) push("CREATED", {}, stamp);
  }

  const fn = fullName(c);
  push("FN", {}, escapeValue(fn));

  const comps = c.name?.components ?? [];
  if (comps.length > 0 || c.name?.sortAs) {
    const pick = (...kinds: string[]) =>
      comps
        .filter((x) => kinds.includes(x.kind))
        .map((x) => x.value)
        .join(",");
    const n = [
      pick("surname", "surname2"),
      pick("given"),
      pick("additional", "middle", "given2"),
      pick("prefix", "title"),
      pick("suffix", "credential", "generation"),
    ];
    const sortAs = c.name?.sortAs;
    const sortParam = sortAs?.["surname"] || sortAs?.["given"] ? [sortAs["surname"] ?? "", sortAs["given"] ?? ""] : undefined;
    if (sortParam && !sortParam[1]) sortParam.pop();
    push("N", { "SORT-AS": sortParam }, n.map(escapeComponent).join(";"));
  }

  for (const [key, nick] of Object.entries(c.nicknames ?? {})) {
    if (nick?.name) push("NICKNAME", { "PROP-ID": propId(key), TYPE: contextTypes(nick.contexts), PREF: prefParam(nick.pref) }, escapeValue(nick.name));
  }

  for (const [key, e] of Object.entries(c.emails ?? {})) {
    if (!e?.address) continue;
    const g = labelled(e.label, null);
    push("EMAIL", { "PROP-ID": propId(key), TYPE: contextTypes(e.contexts), PREF: prefParam(e.pref) }, escapeValue(e.address), g);
  }

  for (const [key, p] of Object.entries(c.phones ?? {})) {
    if (!p?.number) continue;
    const types = contextTypes(p.contexts);
    const f = p.features ?? {};
    if (f["mobile"] || f["cell"]) types.push("cell");
    if (f["fax"]) types.push("fax");
    if (f["voice"]) types.push("voice");
    if (f["text"]) types.push("text");
    if (f["video"]) types.push("video");
    if (f["pager"]) types.push("pager");
    if (f["textphone"]) types.push("textphone");
    if (f["main-number"]) types.push("main-number");
    const g = labelled(p.label, null);
    push("TEL", { "PROP-ID": propId(key), TYPE: types, PREF: prefParam(p.pref) }, escapeValue(p.number), g);
  }

  for (const [key, s] of Object.entries(c.onlineServices ?? {})) {
    if (!s || (!s.uri && !s.user)) continue;
    const g = labelled(s.label, null);
    const asImpp = s.vCardName === "impp" || (!s.service && !s.user);
    const params: Params = { "PROP-ID": propId(key), TYPE: contextTypes(s.contexts), PREF: prefParam(s.pref) };
    if (asImpp) {
      if (s.service) params["X-SERVICE-TYPE"] = [s.service];
      push("IMPP", params, uriText(s.uri ?? s.user!), g);
      continue;
    }
    if (s.service) params["SERVICE-TYPE"] = [s.service];
    if (s.uri) {
      if (s.user) params["USERNAME"] = [s.user];
      push("SOCIALPROFILE", params, uriText(s.uri), g);
    } else {
      params["VALUE"] = ["text"];
      push("SOCIALPROFILE", params, escapeValue(s.user!), g);
    }
  }

  for (const [key, l] of Object.entries(c.preferredLanguages ?? {})) {
    if (l?.language) push("LANG", { "PROP-ID": propId(key), TYPE: contextTypes(l.contexts), PREF: prefParam(l.pref) }, escapeValue(l.language));
  }

  // Titles that point at an organization share a group with its ORG line.
  const orgGroups = new Map<string, string>();
  for (const t of Object.values(c.titles ?? {})) {
    if (t?.organizationId && c.organizations?.[t.organizationId] && !orgGroups.has(t.organizationId)) {
      orgGroups.set(t.organizationId, newGroup());
    }
  }

  for (const [key, o] of Object.entries(c.organizations ?? {})) {
    if (!o) continue;
    const parts = [o.name ?? "", ...(o.units ?? []).map((u) => u.name)];
    if (parts.every((x) => !x)) continue;
    push(
      "ORG",
      { "PROP-ID": propId(key), TYPE: contextTypes(o.contexts), "SORT-AS": o.sortAs ? [o.sortAs] : undefined },
      parts.map(escapeComponent).join(";"),
      orgGroups.get(key) ?? null,
    );
  }

  for (const [key, t] of Object.entries(c.titles ?? {})) {
    if (!t?.name) continue;
    const g = t.organizationId ? orgGroups.get(t.organizationId) ?? null : null;
    push(t.kind === "role" ? "ROLE" : "TITLE", { "PROP-ID": propId(key) }, escapeValue(t.name), g);
  }

  for (const [key, a] of Object.entries(c.addresses ?? {})) {
    if (!a) continue;
    const fields = addressFields(a);
    if (fields.every((x) => !x)) continue;
    const params: Params = { "PROP-ID": propId(key), TYPE: contextTypes(a.contexts), PREF: prefParam(a.pref) };
    if (a.full) params["LABEL"] = [a.full];
    if (a.countryCode) params["CC"] = [a.countryCode];
    if (a.coordinates) params["GEO"] = [a.coordinates];
    if (a.timeZone) params["TZ"] = [a.timeZone];
    const g = labelled(a.label, null);
    push("ADR", params, fields.map(escapeComponent).join(";"), g);
  }

  for (const [key, n] of Object.entries(c.notes ?? {})) {
    if (!n?.note) continue;
    const params: Params = { "PROP-ID": propId(key) };
    if (n.created) {
      const stamp = formatTimestamp(n.created);
      if (stamp) params["CREATED"] = [stamp];
    }
    if (n.author?.name) params["AUTHOR-NAME"] = [n.author.name];
    if (n.author?.uri) params["AUTHOR"] = [n.author.uri];
    push("NOTE", params, escapeValue(n.note));
  }

  for (const [key, l] of Object.entries(c.links ?? {})) {
    if (!l?.uri) continue;
    const g = labelled(l.label, null);
    push(
      l.kind === "contact" ? "CONTACT-URI" : "URL",
      { "PROP-ID": propId(key), TYPE: contextTypes(l.contexts), PREF: prefParam(l.pref), MEDIATYPE: l.mediaType ? [l.mediaType] : undefined },
      uriText(l.uri),
      g,
    );
  }

  for (const [key, m] of Object.entries(c.media ?? {})) {
    if (!m?.uri) continue;
    const prop = m.kind === "logo" ? "LOGO" : m.kind === "sound" ? "SOUND" : "PHOTO";
    const g = labelled(m.label, null);
    const params: Params = { "PROP-ID": propId(key), TYPE: contextTypes(m.contexts), PREF: prefParam(m.pref) };
    push(prop, params, binaryValue(params, m.uri, m.mediaType, prop === "SOUND" ? "audio/basic" : "image/jpeg", vobject), g);
  }

  for (const [key, k] of Object.entries(c.cryptoKeys ?? {})) {
    if (!k?.uri) continue;
    const params: Params = { "PROP-ID": propId(key), TYPE: contextTypes(k.contexts), PREF: prefParam(k.pref) };
    push("KEY", params, binaryValue(params, k.uri, k.mediaType, "application/octet-stream", vobject));
  }

  for (const [key, d] of Object.entries(c.directories ?? {})) {
    if (!d?.uri) continue;
    push(
      d.kind === "entry" ? "SOURCE" : "ORG-DIRECTORY",
      { "PROP-ID": propId(key), PREF: prefParam(d.pref), MEDIATYPE: d.mediaType ? [d.mediaType] : undefined, INDEX: d.listAs != null ? [String(d.listAs)] : undefined },
      uriText(d.uri),
    );
  }

  // The webmail edits calendarUri / freeBusyUri / schedulingUri as single
  // fields and never touches the maps, so a flat value stands for every entry
  // of its kind: the map entries of that kind are replaced by it.
  const calendars: NonNullable<JsContact["calendars"]> = {};
  for (const [key, cal] of Object.entries(c.calendars ?? {})) {
    if (!cal?.uri) continue;
    if (c.calendarUri !== undefined && (cal.kind ?? "calendar") === "calendar") continue;
    if (c.freeBusyUri !== undefined && cal.kind === "freeBusy") continue;
    calendars[key] = cal;
  }
  if (c.calendarUri) calendars["calendarUri"] = { uri: c.calendarUri, kind: "calendar" };
  if (c.freeBusyUri) calendars["freeBusyUri"] = { uri: c.freeBusyUri, kind: "freeBusy" };
  for (const [key, cal] of Object.entries(calendars)) {
    push(
      cal.kind === "freeBusy" ? "FBURL" : "CALURI",
      { "PROP-ID": key === "calendarUri" || key === "freeBusyUri" ? undefined : propId(key), TYPE: contextTypes(cal.contexts), PREF: prefParam(cal.pref), MEDIATYPE: cal.mediaType ? [cal.mediaType] : undefined },
      uriText(cal.uri),
    );
  }
  const scheduling: NonNullable<JsContact["schedulingAddresses"]> = {};
  if (c.schedulingUri === undefined) {
    for (const [key, s] of Object.entries(c.schedulingAddresses ?? {})) if (s?.uri) scheduling[key] = s;
  } else if (c.schedulingUri) {
    scheduling["schedulingUri"] = { uri: c.schedulingUri };
  }
  for (const [key, s] of Object.entries(scheduling)) {
    push("CALADRURI", { "PROP-ID": key === "schedulingUri" ? undefined : propId(key), TYPE: contextTypes(s.contexts), PREF: prefParam(s.pref) }, uriText(s.uri));
  }

  for (const [uri, r] of Object.entries(c.relatedTo ?? {})) {
    if (!uri) continue;
    const types = Object.entries(r?.relation ?? {})
      .filter(([, on]) => on)
      .map(([t]) => t);
    push("RELATED", { TYPE: types }, uriText(uri));
  }

  const keywords = Object.entries(c.keywords ?? {})
    .filter(([k, on]) => on && k)
    .map(([k]) => k);
  if (keywords.length > 0) push("CATEGORIES", {}, keywords.map((k) => escapeValue(k)).join(","));

  for (const [key, pi] of Object.entries(c.personalInfo ?? {})) {
    if (!pi?.value) continue;
    if (pi.kind !== "expertise" && pi.kind !== "hobby" && pi.kind !== "interest") {
      jsprop(`personalInfo/${key}`, pi);
      continue;
    }
    const prop = pi.kind === "expertise" ? "EXPERTISE" : pi.kind === "hobby" ? "HOBBY" : "INTEREST";
    // RFC 6715: EXPERTISE grades beginner/average/expert, HOBBY and INTEREST high/medium/low.
    const level = !pi.level ? undefined : prop !== "EXPERTISE" ? pi.level : pi.level === "high" ? "expert" : pi.level === "medium" ? "average" : "beginner";
    push(prop, { "PROP-ID": propId(key), LEVEL: level ? [level] : undefined, INDEX: pi.listAs != null ? [String(pi.listAs)] : undefined }, escapeValue(pi.value));
  }

  if (c.speakToAs?.grammaticalGender) push("GRAMGENDER", {}, escapeValue(c.speakToAs.grammaticalGender));
  for (const [key, pr] of Object.entries(c.speakToAs?.pronouns ?? {})) {
    if (pr?.pronouns) push("PRONOUNS", { "PROP-ID": propId(key), TYPE: contextTypes(pr.contexts), PREF: prefParam(pr.pref) }, escapeValue(pr.pronouns));
  }

  for (const [key, an] of Object.entries(c.anniversaries ?? {})) {
    if (!an) continue;
    const date = formatDate(an.date);
    if (an.kind === "other") {
      jsprop(`anniversaries/${key}`, an);
      continue;
    }
    const prop = an.kind === "birth" ? "BDAY" : an.kind === "death" ? "DEATHDATE" : "ANNIVERSARY";
    if (date) push(prop, { "PROP-ID": propId(key) }, date);
    if (an.place?.full) {
      if (an.kind === "wedding") jsprop(`anniversaries/${key}/place`, an.place);
      else push(an.kind === "birth" ? "BIRTHPLACE" : "DEATHPLACE", { "PROP-ID": propId(key) }, escapeValue(an.place.full));
    }
  }

  for (const [uri, on] of Object.entries(c.members ?? {})) {
    if (on && uri) push("MEMBER", {}, uriText(uri));
  }

  push("REV", {}, opts.rev ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"));

  for (const raw of preserved) lines.push(raw);

  lines.push("END:VCARD");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function groupOf(line: string): string | null {
  const m = /^([A-Za-z0-9-]+)\.[A-Za-z0-9-]+[;:]/.exec(line);
  return m?.[1] ?? null;
}

/**
 * Lines of an existing vCard whose property we don't model (first VCARD
 * only). An X-ABLabel stays with the property it labels: it is dropped when
 * that property is managed (the label comes back from the JSContact side)
 * and kept when it is not.
 */
export function unmanagedLines(text: string): string[] {
  const parsed: Array<{ line: string; p: ParsedLine }> = [];
  let inCard = false;
  for (const raw of unfold(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCARD") {
      if (inCard) break; // only the first card in the resource
      inCard = true;
      continue;
    }
    if (upper === "END:VCARD") break;
    if (!inCard) continue;
    const p = parseLine(line);
    if (p) parsed.push({ line, p });
  }
  const managedGroups = new Set(parsed.filter(({ p }) => p.group && MANAGED_PROPS.has(p.name)).map(({ p }) => p.group));
  const out: string[] = [];
  for (const { line, p } of parsed) {
    if (MANAGED_PROPS.has(p.name)) continue;
    if (p.name === "X-ABLABEL" && p.group && managedGroups.has(p.group)) continue;
    out.push(line);
  }
  return out;
}

function fullName(c: JsContact): string {
  if (c.name?.full) return c.name.full;
  const comps = c.name?.components ?? [];
  if (comps.length > 0) {
    const order = ["prefix", "title", "given", "given2", "middle", "additional", "surname", "surname2", "suffix", "credential", "generation"];
    const parts = order
      .flatMap((k) => comps.filter((x) => x.kind === k).map((x) => x.value))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  const org = Object.values(c.organizations ?? {}).find((o) => o?.name)?.name;
  if (org) return org;
  const email = Object.values(c.emails ?? {}).find((e) => e?.address)?.address;
  if (email) return email;
  return "";
}

function contextTypes(ctx?: Contexts): string[] {
  const out: string[] = [];
  if (!ctx) return out;
  if (ctx["private"] || ctx["home"]) out.push("home");
  if (ctx["work"]) out.push("work");
  return out;
}

function prefParam(pref?: number): string[] | undefined {
  if (typeof pref !== "number" || !Number.isFinite(pref)) return undefined;
  const v = Math.min(100, Math.max(1, Math.round(pref)));
  return [String(v)];
}

function addressFields(a: NonNullable<JsContact["addresses"]>[string]): string[] {
  // pobox;ext;street;locality;region;postcode;country
  const byKind = (...kinds: string[]) =>
    (a.components ?? [])
      .filter((x) => kinds.includes(x.kind))
      .map((x) => x.value)
      .filter(Boolean)
      .join(" ");
  const street = a.street ?? byKind("name", "street", "number", "block", "direction", "landmark");
  const ext = byKind("apartment", "floor", "building", "room", "subDistrict", "subdistrict", "district");
  const pobox = byKind("postOfficeBox");
  const locality = a.locality ?? byKind("locality");
  const region = a.region ?? byKind("region");
  const postcode = a.postcode ?? byKind("postcode");
  const country = a.country ?? byKind("country");
  const fields = [pobox, ext, street, locality, region, postcode, country];
  if (fields.every((x) => !x) && a.full) fields[2] = a.full;
  return fields;
}

/**
 * Value of a PHOTO, LOGO, SOUND or KEY. Behind vobject an inline base64
 * `data:` URI goes out as ENCODING=b binary with its type in MEDIATYPE, the
 * one form that server decodes and re-encodes intact (a `data:` URI written
 * as is comes back cut at its first comma). Elsewhere the URI is written as
 * RFC 6350 has it, MEDIATYPE naming the type of a non-`data:` URI.
 */
function binaryValue(params: Params, uri: string, mediaType: string | undefined, fallbackType: string, vobject: boolean): string {
  const inline = /^data:([^;,]*)(?:;[^;,]*)*;base64,(.*)$/is.exec(uri);
  if (inline && vobject) {
    params["ENCODING"] = ["b"];
    params["MEDIATYPE"] = [mediaType || inline[1] || fallbackType];
    return inline[2]!.replace(/\s+/g, "");
  }
  if (mediaType && !inline) params["MEDIATYPE"] = [mediaType];
  return vobject ? escapeValue(uri) : uri.replace(/[\r\n]/g, "");
}

/** RFC 6350 §3.4: escape backslash, comma, semicolon and newline in a text value. */
export function escapeValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Like escapeValue, for one field of a structured (`;`-separated) value. */
function escapeComponent(v: string): string {
  return escapeValue(v);
}

function quoteParam(v: string): string {
  const clean = v.replace(/["\r\n]/g, "");
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

/** RFC 6350 §3.2: fold at 75 octets, continuation lines start with a space. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  const limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const budget = out.length === 0 ? limit : limit - 1;
    if (curLen + n > budget) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += n;
  }
  if (cur) out.push(cur);
  return out.map((s, i) => (i === 0 ? s : " " + s)).join("\r\n");
}

function hashString(s: string): string {
  // Tiny non-cryptographic hash; only used to give synthesised UIDs some
  // stability. Real UIDs are taken straight from the vCard.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
