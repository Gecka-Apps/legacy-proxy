// Reconciles two script models on top of a ManageSieve server that runs a
// single active script.
//
// JMAP for Sieve (RFC 9661) and its reference implementation (Stalwart)
// expose a server-managed `vacation` script that runs alongside whichever
// user script is active. Bulwark's filter editor relies on that: it edits a
// `filters` script, skips the one named `vacation`, and drives the
// autoresponder through VacationResponse/set. Dovecot/Pigeonhole, like every
// other ManageSieve server, executes exactly one active script.
//
// With the `include` extension (RFC 6609) the active script can be a
// *master* that includes the others. Two cases:
//
// 1. The user (or their admin) already runs such a master — a hand-written
//    `default` that includes the script Roundcube manages, say. It is
//    adopted as is: the proxy only adds its own two lines, tagged with a
//    trailing `# legacy-proxy` comment so they can be found and updated
//    again, and never edits anything else in it.
//
//      include :personal :optional "vacation"; # legacy-proxy
//      include :personal "filters"; # legacy-proxy
//
//    The script the master includes is what the JMAP client sees as active
//    (so it opens and edits the existing Roundcube script). Switching to
//    another script comments the previous include out rather than deleting
//    it (`# legacy-proxy disabled: …`).
//
// 2. No master exists (nothing active, or a plain script is active). The
//    proxy writes its own, named `bulwark`, and activates it.
//
// The master is hidden from JMAP clients either way. Without `include` we
// fall back to plain SETACTIVE semantics, so activating a filter script
// silences the autoresponder and vice versa — the best a single-script
// server can do.

import { SieveClient, SieveCommandError, type SieveScriptInfo } from "./client.js";

/** Name of the proxy-written master script (case 2). */
export const WRAPPER_NAME = "bulwark";
/** RFC 9661 §4: the autoresponder lives in a script literally named "vacation". */
export const VACATION_NAME = "vacation";

const WRAPPER_HEADER = "# Managed by legacy-proxy: activates the user's scripts via include.";
/** Trailing comment on the lines the proxy adds to a foreign master. */
const OURS = "# legacy-proxy";
const DISABLED = "# legacy-proxy disabled: ";

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

// -- master script bodies --------------------------------------------------------

/** Our own master body activating `vacation` (always) and the given user script. */
export function buildWrapper(userScript: string | null): string {
  const lines = [
    WRAPPER_HEADER,
    'require ["include"];',
    `include :personal :optional "${escapeString(VACATION_NAME)}";`,
  ];
  if (userScript) lines.push(`include :personal :optional "${escapeString(userScript)}";`);
  return lines.join("\r\n") + "\r\n";
}

export interface IncludeLine {
  name: string;
  /** `:global` includes come from the server's shared directory; never a user script. */
  global: boolean;
  /** Carries our `# legacy-proxy` tag. */
  ours: boolean;
}

const INCLUDE_RE = /^[ \t]*include\b([^"\r\n]*)"((?:[^"\\]|\\.)*)"[ \t]*;[ \t]*(#[^\r\n]*)?$/gm;

/** Live (uncommented) `include` statements of a script, in order. */
export function parseIncludes(body: string): IncludeLine[] {
  const out: IncludeLine[] = [];
  let m: RegExpExecArray | null;
  INCLUDE_RE.lastIndex = 0;
  while ((m = INCLUDE_RE.exec(body)) !== null) {
    out.push({
      name: (m[2] ?? "").replace(/\\(.)/g, "$1"),
      global: /:global\b/.test(m[1] ?? ""),
      ours: (m[3] ?? "").trim() === OURS,
    });
  }
  return out;
}

/** Names included by our own master body. Returns [] for a foreign script. */
export function parseWrapper(body: string): string[] {
  if (!body.startsWith(WRAPPER_HEADER)) return [];
  return parseIncludes(body).map((i) => i.name);
}

export function isOurWrapperBody(body: string): boolean {
  return body.startsWith(WRAPPER_HEADER);
}

/** A script acts as a master when it includes other personal scripts. */
export function isMasterBody(body: string): boolean {
  return isOurWrapperBody(body) || parseIncludes(body).some((i) => !i.global);
}

/**
 * The user script a master runs: our tagged include when present, else the
 * first personal include that is not the vacation script.
 */
export function userScriptOf(body: string): string | null {
  const personal = parseIncludes(body).filter((i) => !i.global && i.name !== VACATION_NAME);
  return (personal.find((i) => i.ours) ?? personal[0])?.name ?? null;
}

/**
 * Rewrite a foreign master so that it runs `vacation` and exactly `name`
 * (null: no user script). Only lines we own change: our tagged includes are
 * replaced, a foreign include of another user script is commented out, and
 * a commented-out include of `name` is brought back.
 */
export function retargetMaster(body: string, name: string | null): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let hasVacation = false;
  let hasTarget = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    // Re-enable a line we disabled earlier when it is the one wanted now.
    if (line.trimStart().startsWith(DISABLED)) {
      const original = line.trimStart().slice(DISABLED.length);
      const inc = parseIncludes(original)[0];
      if (inc && name !== null && inc.name === name && !inc.global) {
        out.push(original);
        hasTarget = true;
      } else {
        out.push(raw);
      }
      continue;
    }
    const inc = parseIncludes(line)[0];
    if (!inc || inc.global) {
      out.push(raw);
      continue;
    }
    if (inc.name === VACATION_NAME) {
      hasVacation = true;
      out.push(raw);
      continue;
    }
    if (name !== null && inc.name === name) {
      hasTarget = true;
      out.push(raw);
      continue;
    }
    // Another user script: ours goes away, theirs is switched off in place.
    if (inc.ours) continue;
    out.push(`${DISABLED}${line}`);
  }

  // Drop trailing blank lines so our additions sit right after the content.
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  if (!hasVacation) out.push(`include :personal :optional "${escapeString(VACATION_NAME)}"; ${OURS}`);
  if (name !== null && !hasTarget) out.push(`include :personal "${escapeString(name)}"; ${OURS}`);
  let result = out.join(eol) + eol;
  if (!/^\s*require\b[^;]*\binclude\b/m.test(result)) result = `require ["include"];${eol}${result}`;
  return result;
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

/**
 * Scripts as the JMAP client should see them: the master is dropped and
 * `isActive` is derived from what the master includes.
 */
export async function listScriptsView(client: SieveClient): Promise<ScriptView[]> {
  const raw = await client.listScripts();
  const master = await activeMaster(client, raw);
  return projectScripts(raw, activeUserScriptFrom(raw, master), master?.name ?? null);
}

/** `hidden` is the master's name (or null when no master is active). */
export function projectScripts(raw: SieveScriptInfo[], activeUser: string | null, hidden: string | null): ScriptView[] {
  return raw.filter((s) => s.name !== hidden).map((s) => ({ name: s.name, isActive: s.name === activeUser }));
}

function activeUserScriptFrom(raw: SieveScriptInfo[], master: Master | null): string | null {
  if (master) return userScriptOf(master.body);
  const active = raw.find((s) => s.active);
  if (!active || active.name === VACATION_NAME) return null;
  return active.name;
}

/** What a JMAP client should consider the active script, plus the master to hide. */
export async function activeUserScript(client: SieveClient, raw?: SieveScriptInfo[]): Promise<{ active: string | null; hidden: string | null }> {
  const list = raw ?? (await client.listScripts());
  const master = await activeMaster(client, list);
  return { active: activeUserScriptFrom(list, master), hidden: master?.name ?? null };
}

/**
 * Make `name` the active user script (`null` deactivates). With `include`
 * support the active master is retargeted (or created), so the autoresponder
 * keeps running; without it, it is a plain SETACTIVE.
 */
export async function activateUserScript(client: SieveClient, name: string | null): Promise<void> {
  if (!supportsInclude(client)) {
    await client.setActive(name ?? "");
    return;
  }
  const raw = await client.listScripts();
  const master = await activeMaster(client, raw);
  if (master && !master.ours) {
    if (name === master.name) throw new Error(`"${name}" is the active master script and cannot include itself`);
    await client.putScript(master.name, retargetMaster(master.body, name));
    return;
  }
  const displaced = await rescueForeignWrapper(client, raw);
  // The user's own script wore our name: it keeps being the active one,
  // under its new name, unless the caller asked for something else.
  const target = name === WRAPPER_NAME ? (displaced ?? null) : name;
  await client.putScript(WRAPPER_NAME, buildWrapper(target));
  await client.setActive(WRAPPER_NAME);
}

/**
 * A plain script named like our wrapper that we did not write (a user who
 * picked "bulwark" as a name before the proxy existed) must not be
 * overwritten. Rename it to the first free `bulwark-N` and return the name.
 */
async function rescueForeignWrapper(client: SieveClient, raw: SieveScriptInfo[]): Promise<string | null> {
  if (!raw.some((s) => s.name === WRAPPER_NAME)) return null;
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
  return fresh;
}

/**
 * Called after the vacation script was (re)written: make sure it runs.
 * With `include`, a master that already references it needs nothing; a
 * foreign master gets the include added; with no master, ours is created
 * and the currently active script carried into it. Without `include`,
 * `enabled` decides whether the vacation script takes the single active slot.
 */
export async function ensureVacationWired(client: SieveClient, enabled: boolean): Promise<void> {
  const raw = await client.listScripts();
  const active = raw.find((s) => s.active);
  if (supportsInclude(client)) {
    const master = await activeMaster(client, raw);
    if (master) {
      if (parseIncludes(master.body).some((i) => i.name === VACATION_NAME && !i.global)) return;
      await client.putScript(master.name, retargetMaster(master.body, userScriptOf(master.body)));
      return;
    }
    const carried = active && active.name !== VACATION_NAME ? active.name : null;
    await activateUserScript(client, carried);
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
