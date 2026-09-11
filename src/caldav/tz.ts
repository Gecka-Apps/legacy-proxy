// Time-zone arithmetic on top of Intl, and VTIMEZONE synthesis.
//
// Node ships the IANA database through ICU but exposes no transition table,
// so offsets are sampled with Intl.DateTimeFormat. Converting a local
// wall-clock time to UTC is done by fixed-point iteration on the offset,
// which converges in two steps for every real zone (offsets change by at
// most a couple of hours at a transition).
//
// CalDAV servers want a VTIMEZONE for every TZID a resource references
// (RFC 5545 §3.6.5). Rather than embed the whole database we synthesise one
// per zone covering a window of years around the event: each observed
// transition becomes a STANDARD or DAYLIGHT sub-component with an explicit
// DTSTART and no RRULE, which is valid and what every client understands.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock components of a UTC instant in `tz`. */
export function utcToLocal(tz: string, utcMs: number): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** UTC offset of `tz` at a UTC instant, in minutes east of Greenwich. */
export function offsetMinutes(tz: string, utcMs: number): number {
  const l = utcToLocal(tz, utcMs);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** UTC instant (ms) of a wall-clock time in `tz`. A time inside a DST gap takes the post-transition offset. */
export function localToUtc(tz: string, l: LocalParts): number {
  const naive = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  let guess = naive - offsetMinutes(tz, naive) * 60_000;
  guess = naive - offsetMinutes(tz, guess) * 60_000;
  return guess;
}

/** `YYYY-MM-DDTHH:MM:SS` (RFC 8984 LocalDateTime) → parts. */
export function parseLocal(s: string): LocalParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?Z?$/.exec(s);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
}

export function formatLocal(l: LocalParts): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(l.year, 4)}-${p(l.month)}-${p(l.day)}T${p(l.hour)}:${p(l.minute)}:${p(l.second)}`;
}

/** RFC 3339 UTC with second precision, as JMAP UTCDate. */
export function formatUtc(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Local parts as an iCalendar DATE-TIME value without zone (`YYYYMMDDTHHMMSS`). */
export function toIcalLocal(l: LocalParts): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(l.year, 4)}${p(l.month)}${p(l.day)}T${p(l.hour)}${p(l.minute)}${p(l.second)}`;
}

export function toIcalUtc(ms: number): string {
  return formatUtc(ms).replace(/[-:]/g, "");
}

function icalOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
}

interface Transition {
  utcMs: number;
  from: number;
  to: number;
}

/** Offset transitions of `tz` between Jan 1 `fromYear` and Dec 31 `toYear`, UTC. */
export function transitions(tz: string, fromYear: number, toYear: number): Transition[] {
  const out: Transition[] = [];
  const DAY = 86_400_000;
  let t = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  let prev = offsetMinutes(tz, t);
  while (t < end) {
    const next = t + DAY;
    const off = offsetMinutes(tz, next);
    if (off !== prev) {
      // Bisect the day to the minute the offset flips.
      let lo = t;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
        if (offsetMinutes(tz, mid) === prev) lo = mid;
        else hi = mid;
      }
      out.push({ utcMs: hi, from: prev, to: off });
      prev = off;
    }
    t = next;
  }
  return out;
}

/**
 * A VTIMEZONE component for `tz` valid over [fromYear, toYear], as an
 * iCalendar text block (CRLF-terminated lines, no folding needed).
 */
export function buildVTimezone(tz: string, fromYear: number, toYear: number): string {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tz}`, `X-LIC-LOCATION:${tz}`];
  const ts = transitions(tz, fromYear, toYear);
  if (ts.length === 0) {
    const off = offsetMinutes(tz, Date.UTC(fromYear, 0, 1));
    lines.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${icalOffset(off)}`, `TZOFFSETTO:${icalOffset(off)}`, "END:STANDARD");
  } else {
    for (const tr of ts) {
      const kind = tr.to > tr.from ? "DAYLIGHT" : "STANDARD";
      // DTSTART is local time in the *previous* offset (RFC 5545 §3.8.2.4).
      const local = utcToLocal("UTC", tr.utcMs + tr.from * 60_000);
      lines.push(`BEGIN:${kind}`, `DTSTART:${toIcalLocal(local)}`, `TZOFFSETFROM:${icalOffset(tr.from)}`, `TZOFFSETTO:${icalOffset(tr.to)}`, `END:${kind}`);
    }
  }
  lines.push("END:VTIMEZONE");
  return lines.join("\r\n");
}
