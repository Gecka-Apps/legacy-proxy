// Reconciles two script models on top of a ManageSieve server that runs a
// single active script.
//
// JMAP for Sieve (RFC 9661) and its reference implementation (Stalwart)
// expose a server-managed `vacation` script that runs alongside whichever
// user script is active. Bulwark's filter editor relies on that: it edits
// the active script (or the first one listed), skips the one named
// `vacation`, and drives the autoresponder through VacationResponse/set.
// Dovecot/Pigeonhole, like every other ManageSieve server, executes exactly
// one active script.
//
// With the `include` extension (RFC 6609) the active script can be a
// *master* that only includes the others, one rule script per line. That
// is the convention described in CONVENTION.md, shared with any webmail
// that wants to follow it: the master, whoever wrote it, is the registry,
// and each client signs the lines it manages with its own tag.
//
//   include :personal "rainloop.user";                             <- nobody's, never touched
//   include :personal "roundcube"; # roundcube                     <- another client's
//   include :personal :optional "vacation"; # jmap-legacy-proxy    <- ours
//   include :personal "filters"; # jmap-legacy-proxy               <- ours, the active one
//   # jmap-legacy-proxy off: include :personal "old";              <- ours, inactive
//
// A JMAP client sees only the scripts referenced by a line carrying its
// tag, live or off, so it can neither open nor overwrite a script another
// webmail manages; those keep running from their own includes. The master
// itself is hidden. When no master exists the proxy writes its own, named
// `main`, carrying the script that was active (untagged) so it keeps
// running.
//
// Masters written before the convention had a header naming this proxy and
// a "# legacy-proxy" tag. They are read as ours and rewritten in the current
// form the first time one of their lines changes.
//
// Without `include` we fall back to plain SETACTIVE semantics: the proxy
// then owns whatever is active, and activating a filter script silences the
// autoresponder and vice versa, the best a single-script server can do.

import { SieveClient, SieveCommandError, type SieveScriptInfo } from "./client.js";

/** Name of the proxy-written master script. */
export const WRAPPER_NAME = "main";
/** RFC 9661 §4: the autoresponder lives in a script literally named "vacation". */
export const VACATION_NAME = "vacation";
/** How this client signs the master lines it manages. */
export const CLIENT_TAG = "jmap-legacy-proxy";

/** First line of a master written to the convention; the rest is for humans. */
const MAIN_SIGNATURE = "# main: the active script only activates rule scripts, through include (RFC 6609).";
const MAIN_HEADER = [
  MAIN_SIGNATURE,
  "# Each line is one script that keeps running as long as its include is live.",
  '# A trailing "# <client>" comment marks the line as managed by that client,',
  '# which alone lists, edits and switches it off ("# <client> off: include ...").',
  "# Lines without a tag belong to nobody: leave them alone.",
  "# Do not put rules here; put them in a script of their own and include it.",
];
/** Trailing comment on the lines the proxy owns. */
const OURS = `# ${CLIENT_TAG}`;
/** Prefix of an owned include switched off in place: the script stays registered. */
const DISABLED = `# ${CLIENT_TAG} off: `;

/** Forms written before the convention, still recognised on read. */
const LEGACY_HEADER = "# Managed by legacy-proxy: activates the user's scripts via include.";
const LEGACY_OURS = "# legacy-proxy";
const LEGACY_DISABLED = "# legacy-proxy disabled: ";

export interface ScriptView {
  name: string;
  /** Active as the client understands it (see module comment). */
  isActive: boolean;
}

export function supportsInclude(client: SieveClient): boolean {
  return client.serverCapabilities().extensions.map((e) => e.toLowerCase()).includes("include");
}

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function includeLine(name: string, optional = false): string {
  return `include :personal${optional ? " :optional" : ""} "${escapeString(name)}";`;
}

/** An include of `name` in our live form. */
function ownedLine(name: string, optional = false): string {
  return `${includeLine(name, optional)} ${OURS}`;
}

/** An include of `name` in our switched-off form. */
function offLine(name: string): string {
  return `${DISABLED}${includeLine(name)}`;
}

// -- master script bodies --------------------------------------------------------

/**
 * Our own master body: `vacation` (always), the owned script to run, and
 * `carried`, a foreign script that was active before the master existed and
 * must keep running, included without our tag.
 */
export function buildWrapper(userScript: string | null, carried: string | null = null): string {
  const lines = [...MAIN_HEADER, 'require ["include"];', ownedLine(VACATION_NAME, true)];
  if (carried) lines.push(includeLine(carried));
  if (userScript) lines.push(ownedLine(userScript));
  return lines.join("\r\n") + "\r\n";
}

export interface IncludeLine {
  name: string;
  /** `:global` includes come from the server's shared directory; never a user script. */
  global: boolean;
  /** Carries our tag, current or legacy. */
  ours: boolean;
}

const INCLUDE_RE = /^[ \t]*include\b([^"\r\n]*)"((?:[^"\\]|\\.)*)"[ \t]*;[ \t]*(#[^\r\n]*)?$/gm;

/** Live (uncommented) `include` statements of a script, in order. */
export function parseIncludes(body: string): IncludeLine[] {
  const out: IncludeLine[] = [];
  let m: RegExpExecArray | null;
  INCLUDE_RE.lastIndex = 0;
  while ((m = INCLUDE_RE.exec(body)) !== null) {
    const tag = (m[3] ?? "").trim();
    out.push({
      name: (m[2] ?? "").replace(/\\(.)/g, "$1"),
      global: /:global\b/.test(m[1] ?? ""),
      ours: tag === OURS || tag === LEGACY_OURS,
    });
  }
  return out;
}

/** Names included by a convention master body, live lines only. Returns [] for a foreign script. */
export function parseWrapper(body: string): string[] {
  if (!isOurWrapperBody(body)) return [];
  return parseIncludes(body).map((i) => i.name);
}

/** Written to the convention, by this proxy or another client, or by this proxy before it. */
export function isOurWrapperBody(body: string): boolean {
  return body.startsWith(MAIN_SIGNATURE) || body.startsWith(LEGACY_HEADER);
}

/** A script acts as a master when it includes other personal scripts. */
export function isMasterBody(body: string): boolean {
  return isOurWrapperBody(body) || parseIncludes(body).some((i) => !i.global);
}

/** The owned include switched off on this line, if it is one. */
function disabledInclude(line: string): IncludeLine | null {
  const t = line.trimStart();
  const prefix = t.startsWith(DISABLED) ? DISABLED : t.startsWith(LEGACY_DISABLED) ? LEGACY_DISABLED : null;
  if (!prefix) return null;
  const inc = parseIncludes(t.slice(prefix.length))[0];
  return inc && !inc.global ? inc : null;
}

/** The owned user script a master runs: the tagged live include, if any. */
export function userScriptOf(body: string): string | null {
  return parseIncludes(body).find((i) => i.ours && !i.global && i.name !== VACATION_NAME)?.name ?? null;
}

/** Every script the master registers as ours, live or disabled, `vacation` aside. */
export function ownedScriptsOf(body: string): string[] {
  const out: string[] = [];
  for (const i of parseIncludes(body)) if (i.ours && !i.global && i.name !== VACATION_NAME) out.push(i.name);
  for (const raw of body.split(/\r?\n/)) {
    const inc = disabledInclude(raw);
    if (inc && inc.name !== VACATION_NAME && !out.includes(inc.name)) out.push(inc.name);
  }
  return out;
}

function ensureRequire(body: string, eol: string): string {
  return /^\s*require\b[^;]*\binclude\b/m.test(body) ? body : `require ["include"];${eol}${body}`;
}

function eolOf(body: string): string {
  return body.includes("\r\n") ? "\r\n" : "\n";
}

/** Body lines with trailing blank lines dropped, so additions sit right after the content. Migrates the legacy header. */
function trimmedLines(body: string): string[] {
  const lines = body.split(/\r?\n/);
  if (lines[0] === LEGACY_HEADER) lines.splice(0, 1, ...MAIN_HEADER);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/**
 * Rewrite a master so that it runs `vacation` and, among the scripts we
 * own, exactly `name` (null: none). Only our lines change: the previously
 * active owned include is switched off in place, a disabled include of
 * `name` is brought back, missing lines are appended. Foreign includes are
 * left as they are, live.
 */
export function retargetMaster(body: string, name: string | null): string {
  const eol = eolOf(body);
  const out: string[] = [];
  let hasVacation = false;
  let hasTarget = false;

  for (const raw of trimmedLines(body)) {
    const line = raw.trimEnd();
    const off = disabledInclude(line);
    if (off) {
      if (name !== null && off.name === name) {
        out.push(ownedLine(name));
        hasTarget = true;
      } else {
        out.push(offLine(off.name));
      }
      continue;
    }
    const inc = parseIncludes(line)[0];
    if (!inc || inc.global || !inc.ours) {
      out.push(raw);
      continue;
    }
    if (inc.name === VACATION_NAME) {
      hasVacation = true;
      out.push(ownedLine(VACATION_NAME, true));
      continue;
    }
    if (name !== null && inc.name === name) {
      hasTarget = true;
      out.push(ownedLine(name));
      continue;
    }
    out.push(offLine(inc.name));
  }

  if (!hasVacation) out.push(ownedLine(VACATION_NAME, true));
  if (name !== null && !hasTarget) out.push(ownedLine(name));
  return ensureRequire(out.join(eol) + eol, eol);
}

/** Register `name` as ours in the master, inactive, unless it is already referenced. */
export function registerInMaster(body: string, name: string): string {
  if (ownedScriptsOf(body).includes(name)) return body;
  const eol = eolOf(body);
  const out = trimmedLines(body);
  out.push(offLine(name));
  return ensureRequire(out.join(eol) + eol, eol);
}

/** Drop every line of ours that references `name`. */
export function unregisterFromMaster(body: string, name: string): string {
  const eol = eolOf(body);
  const out = trimmedLines(body).filter((raw) => {
    const off = disabledInclude(raw);
    if (off) return off.name !== name;
    const inc = parseIncludes(raw.trimEnd())[0];
    return !(inc && inc.ours && !inc.global && inc.name === name);
  });
  return out.join(eol) + eol;
}

// -- server state ---------------------------------------------------------------

interface Master {
  name: string;
  body: string;
  ours: boolean;
}

/** The active master script, if the active script is one. */
async function activeMaster(client: SieveClient, raw: SieveScriptInfo[]): Promise<Master | null> {
  const active = raw.find((s) => s.active);
  if (!active) return null;
  let body: string;
  try {
    body = await client.getScript(active.name);
  } catch (e) {
    if (isNonexistent(e)) return null;
    throw e;
  }
  if (!isMasterBody(body)) return null;
  return { name: active.name, body, ours: isOurWrapperBody(body) };
}

export interface ScriptsState {
  /** The owned script the client should consider active, or null. */
  active: string | null;
  /** The master's name, hidden from clients, or null when none is active. */
  hidden: string | null;
  /** Scripts the client may see and touch, `vacation` excluded. */
  owned: string[];
}

/**
 * What a JMAP client should see. With a master, ownership comes from its
 * tagged lines. Without one and without `include` there is nothing to
 * register in: every script is then in reach and the active one is active.
 * Without one but with `include`, nothing is ours yet.
 */
function scriptsStateFrom(client: SieveClient, raw: SieveScriptInfo[], master: Master | null): ScriptsState {
  if (master) return { active: userScriptOf(master.body), hidden: master.name, owned: ownedScriptsOf(master.body) };
  const names = raw.map((s) => s.name).filter((n) => n !== VACATION_NAME);
  if (!supportsInclude(client)) {
    const active = raw.find((s) => s.active);
    return { active: active && active.name !== VACATION_NAME ? active.name : null, hidden: null, owned: names };
  }
  return { active: null, hidden: null, owned: [] };
}

export async function scriptsState(client: SieveClient, raw?: SieveScriptInfo[]): Promise<ScriptsState> {
  const list = raw ?? (await client.listScripts());
  return scriptsStateFrom(client, list, await activeMaster(client, list));
}

/** Scripts as the JMAP client should see them: owned ones plus `vacation`. */
export function projectScripts(raw: SieveScriptInfo[], state: ScriptsState): ScriptView[] {
  return raw
    .filter((s) => s.name !== state.hidden && (s.name === VACATION_NAME || state.owned.includes(s.name)))
    .map((s) => ({ name: s.name, isActive: s.name === state.active }));
}

export async function listScriptsView(client: SieveClient): Promise<ScriptView[]> {
  const raw = await client.listScripts();
  return projectScripts(raw, await scriptsState(client, raw));
}

/**
 * Make sure a master is active and return it. Without one, ours is written
 * with the previously active script carried along, untagged, so it keeps
 * running without becoming ours.
 */
async function ensureMaster(client: SieveClient, raw: SieveScriptInfo[]): Promise<Master> {
  const master = await activeMaster(client, raw);
  if (master) return master;
  const displaced = await rescueForeignWrapper(client, raw);
  const active = raw.find((s) => s.active);
  const carried = displaced ?? (active && active.name !== VACATION_NAME ? active.name : null);
  const body = buildWrapper(null, carried);
  await client.putScript(WRAPPER_NAME, body);
  await client.setActive(WRAPPER_NAME);
  return { name: WRAPPER_NAME, body, ours: true };
}

/**
 * Make `name` the active owned script (`null` deactivates ours). With
 * `include` support the master is retargeted (or created), so the
 * autoresponder and foreign scripts keep running; without it, it is a
 * plain SETACTIVE.
 */
export async function activateUserScript(client: SieveClient, name: string | null): Promise<void> {
  if (!supportsInclude(client)) {
    await client.setActive(name ?? "");
    return;
  }
  const raw = await client.listScripts();
  const master = await ensureMaster(client, raw);
  if (name === master.name) throw new Error(`"${name}" is the active master script and cannot include itself`);
  await client.putScript(master.name, retargetMaster(master.body, name));
}

/** Record `name` as ours, inactive. A no-op without `include`. */
export async function registerScript(client: SieveClient, name: string): Promise<void> {
  if (!supportsInclude(client)) return;
  const master = await ensureMaster(client, await client.listScripts());
  const next = registerInMaster(master.body, name);
  if (next !== master.body) await client.putScript(master.name, next);
}

/** Forget `name`; the caller deletes or renames the script itself. */
export async function unregisterScript(client: SieveClient, name: string): Promise<void> {
  if (!supportsInclude(client)) return;
  const master = await activeMaster(client, await client.listScripts());
  if (!master) return;
  const next = unregisterFromMaster(master.body, name);
  if (next !== master.body) await client.putScript(master.name, next);
}

/**
 * A plain script named like our wrapper that we did not write (a user who
 * picked "main" as a name before the proxy existed) must not be
 * overwritten. Rename it to the first free `main-N` and return the name
 * when it was the active script, so the caller carries it along.
 */
async function rescueForeignWrapper(client: SieveClient, raw: SieveScriptInfo[]): Promise<string | null> {
  const found = raw.find((s) => s.name === WRAPPER_NAME);
  if (!found) return null;
  let body: string;
  try {
    body = await client.getScript(WRAPPER_NAME);
  } catch (e) {
    if (isNonexistent(e)) return null;
    throw e;
  }
  if (isOurWrapperBody(body)) return null;
  const taken = new Set(raw.map((s) => s.name));
  let n = 1;
  while (taken.has(`${WRAPPER_NAME}-${n}`)) n++;
  const fresh = `${WRAPPER_NAME}-${n}`;
  await client.renameScript(WRAPPER_NAME, fresh);
  return found.active ? fresh : null;
}

/**
 * Called after the vacation script was (re)written: make sure it runs.
 * With `include`, a master that already references it needs nothing; any
 * other gets the include added, ours being created first if need be.
 * Without `include`, `enabled` decides whether the vacation script takes
 * the single active slot.
 */
export async function ensureVacationWired(client: SieveClient, enabled: boolean): Promise<void> {
  const raw = await client.listScripts();
  const active = raw.find((s) => s.active);
  if (supportsInclude(client)) {
    const master = await ensureMaster(client, raw);
    if (parseIncludes(master.body).some((i) => i.name === VACATION_NAME && !i.global)) return;
    await client.putScript(master.name, retargetMaster(master.body, userScriptOf(master.body)));
    return;
  }
  if (enabled) {
    await client.setActive(VACATION_NAME);
  } else if (active?.name === VACATION_NAME) {
    await client.setActive("");
  }
}

/** Whether the vacation script is actually run by the active script. */
export async function vacationIsWired(client: SieveClient, raw: SieveScriptInfo[]): Promise<boolean> {
  const active = raw.find((s) => s.active);
  if (!active) return false;
  if (active.name === VACATION_NAME) return true;
  const master = await activeMaster(client, raw);
  return !!master && parseIncludes(master.body).some((i) => i.name === VACATION_NAME && !i.global);
}

/** True when the ManageSieve error means "no such script". */
export function isNonexistent(e: unknown): boolean {
  return e instanceof SieveCommandError && (e.code === "NONEXISTENT" || /not\s+(found|exist)/i.test(e.message));
}
