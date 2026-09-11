// JMAP for Sieve Scripts (RFC 9661) backed by ManageSieve (RFC 5804).
//
// Ids and blobIds are derived from the script name — ManageSieve has no
// other stable handle. `id` is `base64url(name)`; the blobId adds a short
// content hash so it changes whenever the script does (§2: "the blobId
// changes when the script is updated"). Script bodies are served by the
// download route from a live GETSCRIPT, see server.ts.
//
// The single-active-script constraint of ManageSieve is bridged by the
// wrapper in ../../sieve/manager.ts; every "active" notion here goes through
// it.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import type { AccountRow, Store } from "../../state/store.js";
import type { ProviderConfig } from "../../util/config.js";
import type { Credentials } from "../../auth/credentials.js";
import { encodeCounterState } from "../../state/states.js";
import { accountNotFound, forbidden, JmapError } from "../errors.js";
import { SieveClient, SieveCommandError, humanText } from "../../sieve/client.js";
import {
  VACATION_NAME,
  WRAPPER_NAME,
  activateUserScript,
  activeUserScript,
  isNonexistent,
  projectScripts,
} from "../../sieve/manager.js";
import { changesOrCannotCalculate, type ChangesResponse } from "./_shared.js";
import { log } from "../../util/log.js";

export interface SieveCtx {
  account: AccountRow;
  provider: ProviderConfig;
  creds: Credentials;
  store: Store;
}

export interface SieveScriptJson {
  id: string;
  name: string;
  blobId: string;
  isActive: boolean;
}

/** Prefix that tells the download route a blobId names a Sieve script. */
export const SIEVE_BLOB_PREFIX = "S";

export const MAX_SCRIPT_NAME = 512;
export const MAX_SCRIPT_SIZE = 1_000_000;
export const MAX_SCRIPTS = 100;

export function scriptId(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

export function scriptName(id: string): string | null {
  try {
    const name = Buffer.from(id, "base64url").toString("utf8");
    return name && scriptId(name) === id ? name : null;
  } catch {
    return null;
  }
}

export function scriptBlobId(name: string, body: string): string {
  const hash = crypto.createHash("sha1").update(body).digest("base64url").slice(0, 10);
  return `${SIEVE_BLOB_PREFIX}${scriptId(name)}.${hash}`;
}

/** Script name encoded in a `S…` blobId, or null when it is not one of ours. */
export function scriptNameFromBlobId(blobId: string): string | null {
  if (!blobId.startsWith(SIEVE_BLOB_PREFIX)) return null;
  const dot = blobId.indexOf(".");
  const idPart = dot < 0 ? blobId.slice(1) : blobId.slice(1, dot);
  return scriptName(idPart);
}

function sieveState(store: Store, accountId: number): string {
  return encodeCounterState(store.getState(accountId, "sieve"));
}

function ensureSieve(ctx: SieveCtx): NonNullable<ProviderConfig["sieve"]> {
  if (!ctx.provider.sieve) throw forbidden();
  return ctx.provider.sieve;
}

async function withClient<T>(ctx: SieveCtx, fn: (c: SieveClient) => Promise<T>): Promise<T> {
  const c = new SieveClient({ ...ensureSieve(ctx), creds: ctx.creds });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}

/** Fetch a script body from the server for the download route. */
export async function fetchScriptBody(ctx: SieveCtx, name: string): Promise<string | null> {
  return withClient(ctx, async (c) => {
    try {
      return await c.getScript(name);
    } catch (e) {
      if (isNonexistent(e)) return null;
      throw e;
    }
  });
}

async function listProjected(c: SieveClient): Promise<SieveScriptJson[]> {
  const raw = await c.listScripts();
  const active = await activeUserScript(c, raw);
  const view = projectScripts(raw, active);
  const out: SieveScriptJson[] = [];
  for (const s of view) {
    let body = "";
    try {
      body = await c.getScript(s.name);
    } catch (e) {
      if (!isNonexistent(e)) throw e;
    }
    out.push({ id: scriptId(s.name), name: s.name, blobId: scriptBlobId(s.name, body), isActive: s.isActive });
  }
  return out;
}

// -- SieveScript/get ---------------------------------------------------------

export async function sieveScriptGet(
  args: { accountId: string; ids?: string[] | null; properties?: string[] | null },
  ctx: SieveCtx,
): Promise<{ accountId: string; state: string; list: SieveScriptJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const all = await withClient(ctx, listProjected);
  const list = args.ids ? all.filter((s) => args.ids!.includes(s.id)) : all;
  const notFound = args.ids ? args.ids.filter((id) => !all.some((s) => s.id === id)) : [];
  return { accountId: args.accountId, state: sieveState(ctx.store, ctx.account.id), list, notFound };
}

// -- SieveScript/set ---------------------------------------------------------

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

function setError(type: string, description?: string, properties?: string[]): SetError {
  return { type, ...(description ? { description } : {}), ...(properties ? { properties } : {}) };
}

/** Map a ManageSieve failure onto the RFC 9661 SetError vocabulary. */
function errorFor(e: unknown): SetError {
  if (e instanceof SieveCommandError) {
    if (e.code?.startsWith("QUOTA")) return setError("overQuota", humanText(e.response));
    if (e.code === "NONEXISTENT") return setError("notFound");
    if (e.code === "ACTIVE") return setError("scriptIsActive");
    if (e.code === "ALREADYEXISTS") return setError("alreadyExists", humanText(e.response), ["name"]);
    if (e.verb === "PUTSCRIPT" || e.verb === "CHECKSCRIPT") return setError("invalidScript", humanText(e.response));
    return setError("serverFail", humanText(e.response));
  }
  if (e instanceof JmapError) return setError(e.type, e.message);
  return setError("serverFail", (e as Error)?.message);
}

interface SetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, { name?: unknown; blobId?: unknown }> | null;
  update?: Record<string, { name?: unknown; blobId?: unknown }> | null;
  destroy?: string[] | null;
  /** Script id or "#creationId" to activate; `null` deactivates; absent leaves as is. */
  onSuccessActivateScript?: string | null;
  onSuccessDeactivateScript?: boolean;
}

interface SetResponse {
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, { id: string; blobId: string; isActive: boolean }> | null;
  updated: Record<string, { blobId?: string; isActive?: boolean } | null> | null;
  destroyed: string[] | null;
  notCreated: Record<string, SetError> | null;
  notUpdated: Record<string, SetError> | null;
  notDestroyed: Record<string, SetError> | null;
}

function validName(name: unknown): string | SetError {
  if (typeof name !== "string" || !name.trim()) return setError("invalidProperties", "name is required", ["name"]);
  if (name.length > MAX_SCRIPT_NAME) return setError("invalidProperties", "name too long", ["name"]);
  if (/[\r\n\0]/.test(name)) return setError("invalidProperties", "name contains control characters", ["name"]);
  if (name === WRAPPER_NAME) return setError("invalidProperties", `"${WRAPPER_NAME}" is reserved by the proxy`, ["name"]);
  if (name === VACATION_NAME) return setError("forbidden", "the vacation script is managed via VacationResponse/set", ["name"]);
  return name;
}

function loadBlob(ctx: SieveCtx, blobId: unknown): string | SetError {
  if (typeof blobId !== "string" || !blobId) return setError("invalidProperties", "blobId is required", ["blobId"]);
  const up = ctx.store.getUpload(blobId, ctx.account.id);
  if (!up) return setError("blobNotFound", undefined, ["blobId"]);
  if (up.body.length > MAX_SCRIPT_SIZE) return setError("tooLarge", undefined, ["blobId"]);
  return up.body.toString("utf8");
}

export async function sieveScriptSet(args: SetArgs, ctx: SieveCtx): Promise<SetResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const oldState = sieveState(ctx.store, ctx.account.id);
  if (args.ifInState != null && args.ifInState !== oldState) throw new JmapError("stateMismatch");
  if (
    args.onSuccessActivateScript !== undefined &&
    args.onSuccessActivateScript !== null &&
    args.onSuccessDeactivateScript
  ) {
    throw new JmapError("invalidArguments", "onSuccessActivateScript and onSuccessDeactivateScript are exclusive");
  }

  const out: SetResponse = {
    accountId: args.accountId,
    oldState,
    newState: oldState,
    created: null,
    updated: null,
    destroyed: null,
    notCreated: null,
    notUpdated: null,
    notDestroyed: null,
  };
  const createdNames = new Map<string, string>();
  let changed = false;

  await withClient(ctx, async (c) => {
    let raw = await c.listScripts();
    let active = await activeUserScript(c, raw);
    const known = () => new Set(raw.filter((s) => s.name !== WRAPPER_NAME).map((s) => s.name));

    // -- create
    for (const [tempId, spec] of Object.entries(args.create ?? {})) {
      const name = validName(spec?.name);
      if (typeof name !== "string") {
        (out.notCreated ??= {})[tempId] = name;
        continue;
      }
      if (known().has(name)) {
        (out.notCreated ??= {})[tempId] = setError("alreadyExists", `a script named "${name}" exists`, ["name"]);
        continue;
      }
      if (known().size >= MAX_SCRIPTS) {
        (out.notCreated ??= {})[tempId] = setError("overQuota", `at most ${MAX_SCRIPTS} scripts`);
        continue;
      }
      const body = loadBlob(ctx, spec?.blobId);
      if (typeof body !== "string") {
        (out.notCreated ??= {})[tempId] = body;
        continue;
      }
      try {
        await c.putScript(name, body);
        raw = [...raw, { name, active: false }];
        createdNames.set(tempId, name);
        changed = true;
        (out.created ??= {})[tempId] = { id: scriptId(name), blobId: scriptBlobId(name, body), isActive: false };
      } catch (e) {
        log.warn({ err: (e as Error).message, tempId }, "SieveScript/set create failed");
        (out.notCreated ??= {})[tempId] = errorFor(e);
      }
    }

    // -- update
    for (const [id, spec] of Object.entries(args.update ?? {})) {
      const current = scriptName(id);
      if (!current || !known().has(current) || current === VACATION_NAME) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      try {
        let blobIdOut: string | undefined;
        if (spec?.blobId !== undefined) {
          const body = loadBlob(ctx, spec.blobId);
          if (typeof body !== "string") {
            (out.notUpdated ??= {})[id] = body;
            continue;
          }
          await c.putScript(current, body);
          blobIdOut = scriptBlobId(current, body);
          changed = true;
        }
        if (spec?.name !== undefined && spec.name !== current) {
          const next = validName(spec.name);
          if (typeof next !== "string") {
            (out.notUpdated ??= {})[id] = next;
            continue;
          }
          if (known().has(next)) {
            (out.notUpdated ??= {})[id] = setError("alreadyExists", `a script named "${next}" exists`, ["name"]);
            continue;
          }
          await c.renameScript(current, next);
          raw = raw.map((s) => (s.name === current ? { ...s, name: next } : s));
          if (active === current) {
            active = next;
            await activateUserScript(c, next);
          }
          changed = true;
          if (blobIdOut) blobIdOut = blobIdOut.replace(scriptId(current), scriptId(next));
        }
        (out.updated ??= {})[id] = blobIdOut ? { blobId: blobIdOut } : null;
      } catch (e) {
        log.warn({ err: (e as Error).message, id }, "SieveScript/set update failed");
        (out.notUpdated ??= {})[id] = errorFor(e);
      }
    }

    // -- destroy
    for (const id of args.destroy ?? []) {
      const name = scriptName(id);
      if (!name || !known().has(name) || name === VACATION_NAME) {
        (out.notDestroyed ??= {})[id] = setError("notFound");
        continue;
      }
      if (active === name) {
        (out.notDestroyed ??= {})[id] = setError("scriptIsActive");
        continue;
      }
      try {
        await c.deleteScript(name);
        raw = raw.filter((s) => s.name !== name);
        changed = true;
        (out.destroyed ??= []).push(id);
      } catch (e) {
        log.warn({ err: (e as Error).message, id }, "SieveScript/set destroy failed");
        (out.notDestroyed ??= {})[id] = errorFor(e);
      }
    }

    // -- activation (§2.2): applied only when no other part of the request failed.
    const anyFailure = out.notCreated || out.notUpdated || out.notDestroyed;
    if (!anyFailure && (args.onSuccessActivateScript !== undefined || args.onSuccessDeactivateScript)) {
      let target: string | null = null;
      if (args.onSuccessActivateScript != null) {
        const ref = args.onSuccessActivateScript;
        target = ref.startsWith("#") ? (createdNames.get(ref.slice(1)) ?? null) : scriptName(ref);
        if (!target || !known().has(target) || target === VACATION_NAME) {
          throw new JmapError("invalidArguments", `onSuccessActivateScript: unknown script ${ref}`);
        }
      }
      if (target !== active) {
        await activateUserScript(c, target);
        const previous = active;
        active = target;
        changed = true;
        // Reflect the flip on whatever we already reported and on the
        // affected scripts (§2.2: both appear in `updated`).
        for (const [tempId, name] of createdNames) {
          if (name === target && out.created?.[tempId]) out.created[tempId].isActive = true;
        }
        const freshlyCreated = new Set(createdNames.values());
        for (const name of [previous, target]) {
          if (!name || freshlyCreated.has(name)) continue;
          const id = scriptId(name);
          const existing = out.updated?.[id] ?? null;
          (out.updated ??= {})[id] = { ...(existing ?? {}), isActive: name === target };
        }
      }
    }
  });

  if (changed) {
    ctx.store.bumpState(ctx.account.id, "sieve");
    out.newState = sieveState(ctx.store, ctx.account.id);
  }
  return out;
}

// -- SieveScript/validate ----------------------------------------------------

export async function sieveScriptValidate(
  args: { accountId: string; blobId: string },
  ctx: SieveCtx,
): Promise<{ accountId: string; blobId: string; error: SetError | null }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const body = loadBlob(ctx, args.blobId);
  if (typeof body !== "string") {
    if (body.type === "blobNotFound") throw new JmapError("blobNotFound");
    return { accountId: args.accountId, blobId: args.blobId, error: body };
  }
  try {
    await withClient(ctx, (c) => c.checkScript(body));
    return { accountId: args.accountId, blobId: args.blobId, error: null };
  } catch (e) {
    if (e instanceof SieveCommandError) {
      return { accountId: args.accountId, blobId: args.blobId, error: setError("invalidScript", humanText(e.response)) };
    }
    throw e;
  }
}

// -- SieveScript/changes -----------------------------------------------------

export async function sieveScriptChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; store: Store },
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  return changesOrCannotCalculate(args.accountId, args.sinceState, sieveState(ctx.store, ctx.account.id));
}
