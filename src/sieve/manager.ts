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
// When the server offers the `include` extension (RFC 6609) we bridge the gap
// with a wrapper script the client never sees:
//
//   require ["include"];
//   include :personal :optional "vacation";
//   include :personal :optional "filters";
//
// The wrapper is what SETACTIVE points at; "active" from the client's point
// of view means "listed in the wrapper". Without `include` we fall back to
// plain SETACTIVE semantics, so activating a filter script silences the
// autoresponder and vice versa — the best a single-script server can do.

import { SieveClient, SieveCommandError, type SieveScriptInfo } from "./client.js";

/** Name of the proxy-managed wrapper script. Hidden from JMAP clients. */
export const WRAPPER_NAME = "bulwark";
/** RFC 9661 §4: the autoresponder lives in a script literally named "vacation". */
export const VACATION_NAME = "vacation";

const WRAPPER_HEADER = "# Managed by legacy-proxy: activates the user's scripts via include.";

export interface ScriptView {
  name: string;
  /** Active as the client understands it (see module comment). */
  isActive: boolean;
}

export function supportsInclude(client: SieveClient): boolean {
  return client.serverCapabilities().extensions.map((e) => e.toLowerCase()).includes("include");
}

/** Wrapper body activating `vacation` (always) and the given user script. */
export function buildWrapper(userScript: string | null): string {
  const lines = [
    WRAPPER_HEADER,
    'require ["include"];',
    `include :personal :optional "${escapeString(VACATION_NAME)}";`,
  ];
  if (userScript) lines.push(`include :personal :optional "${escapeString(userScript)}";`);
  return lines.join("\r\n") + "\r\n";
}

/** Names included by a wrapper body, in order. Returns [] for a foreign script. */
export function parseWrapper(body: string): string[] {
  if (!body.startsWith(WRAPPER_HEADER)) return [];
  const out: string[] = [];
  const re = /^\s*include\b[^"]*"((?:[^"\\]|\\.)*)"\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, "$1"));
  }
  return out;
}

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Scripts as the JMAP client should see them: the wrapper is dropped and
 * `isActive` is derived from the wrapper's includes when one is active.
 */
export async function listScriptsView(client: SieveClient): Promise<ScriptView[]> {
  const raw = await client.listScripts();
  return projectScripts(raw, await activeUserScript(client, raw), await wrapperOwnedByUs(client, raw));
}

/**
 * `hideWrapper` is false when a script named like the wrapper is really the
 * user's (see rescueForeignWrapper); it then stays visible.
 */
export function projectScripts(raw: SieveScriptInfo[], activeUser: string | null, hideWrapper = true): ScriptView[] {
  return raw
    .filter((s) => !(hideWrapper && s.name === WRAPPER_NAME))
    .map((s) => ({ name: s.name, isActive: s.name === activeUser }));
}

/** True when no script wears the wrapper's name, or the one that does is ours. */
export async function wrapperOwnedByUs(client: SieveClient, raw: SieveScriptInfo[]): Promise<boolean> {
  if (!raw.some((s) => s.name === WRAPPER_NAME)) return true;
  return isOurWrapper(client);
}

/**
 * The user script that is effectively active: the one the wrapper includes
 * (besides `vacation`) when the wrapper is active; otherwise the script the
 * server itself marks ACTIVE, unless that is the vacation script.
 */
export async function activeUserScript(client: SieveClient, raw?: SieveScriptInfo[]): Promise<string | null> {
  const list = raw ?? (await client.listScripts());
  const active = list.find((s) => s.active);
  if (!active) return null;
  if (active.name === WRAPPER_NAME) {
    const body = await client.getScript(WRAPPER_NAME);
    // Not ours (yet): a user script that happens to wear the name.
    if (!body.startsWith(WRAPPER_HEADER)) return active.name;
    return parseWrapper(body).find((n) => n !== VACATION_NAME) ?? null;
  }
  return active.name === VACATION_NAME ? null : active.name;
}

/**
 * Make `name` the active user script (`null` deactivates). With `include`
 * support this rewrites and activates the wrapper so the autoresponder keeps
 * running; without it, it is a plain SETACTIVE.
 */
export async function activateUserScript(client: SieveClient, name: string | null): Promise<void> {
  if (supportsInclude(client)) {
    const displaced = await rescueForeignWrapper(client);
    // The user's own script wore our name: it keeps being the active one,
    // under its new name, unless the caller asked for something else.
    const target = name === WRAPPER_NAME ? displaced ?? null : name;
    await client.putScript(WRAPPER_NAME, buildWrapper(target));
    await client.setActive(WRAPPER_NAME);
    return;
  }
  await client.setActive(name ?? "");
}

/**
 * A script named like the wrapper that we did not write (a user who picked
 * "bulwark" as a name before the proxy existed) must not be overwritten.
 * Rename it to the first free `bulwark-N` and return the new name.
 */
async function rescueForeignWrapper(client: SieveClient): Promise<string | null> {
  const list = await client.listScripts();
  if (!list.some((s) => s.name === WRAPPER_NAME)) return null;
  let body: string;
  try {
    body = await client.getScript(WRAPPER_NAME);
  } catch (e) {
    if (isNonexistent(e)) return null;
    throw e;
  }
  if (body.startsWith(WRAPPER_HEADER)) return null;
  const taken = new Set(list.map((s) => s.name));
  let n = 1;
  while (taken.has(`${WRAPPER_NAME}-${n}`)) n++;
  const fresh = `${WRAPPER_NAME}-${n}`;
  await client.renameScript(WRAPPER_NAME, fresh);
  return fresh;
}

/**
 * Called after the vacation script was (re)written: make sure it is wired
 * in. With `include`, the wrapper always references it, so the wrapper only
 * needs to exist and be active — if the user has a directly-activated
 * script (pre-proxy state), it is carried into the wrapper. Without
 * `include`, `enabled` decides whether the vacation script takes over the
 * single active slot.
 */
export async function ensureVacationWired(client: SieveClient, enabled: boolean): Promise<void> {
  const raw = await client.listScripts();
  const active = raw.find((s) => s.active);
  if (supportsInclude(client)) {
    if (active?.name === WRAPPER_NAME && (await isOurWrapper(client))) return;
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

async function isOurWrapper(client: SieveClient): Promise<boolean> {
  try {
    return (await client.getScript(WRAPPER_NAME)).startsWith(WRAPPER_HEADER);
  } catch {
    return false;
  }
}

/** True when the ManageSieve error means "no such script". */
export function isNonexistent(e: unknown): boolean {
  return e instanceof SieveCommandError && (e.code === "NONEXISTENT" || /not\s+(found|exist)/i.test(e.message));
}
