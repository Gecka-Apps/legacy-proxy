import { randomUUID } from "node:crypto";
import type { AccountRow, Store } from "../../state/store.js";
import { encodeCounterState } from "../../state/states.js";
import { JmapError, accountNotFound } from "../errors.js";
import { changesFromLog, changesOrCannotCalculate, type ChangesResponse } from "./_shared.js";
import { decodeCounterState } from "../../state/states.js";

interface IdentityJson {
  id: string;
  name: string;
  email: string;
  replyTo: { name?: string | null; email: string }[] | null;
  bcc: { name?: string | null; email: string }[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

function identityState(store: Store, accountId: number): string {
  return encodeCounterState(store.getState(accountId, "identity"));
}

function singletonId(accountId: number): string {
  return `i-${accountId}`;
}

// IMAP usernames aren't always email addresses (e.g. shared-hosting accounts
// like `m347812_0-foo`). RFC 8621 §6.1 requires Identity.email to be an email
// address, so when the username has no `@` we synthesize one from the IMAP
// host with the leading service prefix stripped. It's not authoritative —
// providers that know better should send the right replyTo override — but
// it produces a structurally valid address.
function deriveIdentityEmail(account: AccountRow): string {
  if (account.username.includes("@")) return account.username;
  const host = account.host || "localhost";
  const domain = host.replace(/^(imap|imaps|mail|smtp|submission|pop|pop3)\./i, "");
  return `${account.username}@${domain}`;
}

function projectIdentity(account: AccountRow, store: Store): IdentityJson {
  const s = store.getIdentitySettings(account.id);
  return {
    id: singletonId(account.id),
    name: s.displayName ?? account.username,
    email: deriveIdentityEmail(account),
    replyTo: s.replyTo,
    bcc: null,
    textSignature: s.textSignature ?? "",
    htmlSignature: s.htmlSignature ?? "",
    // The Identity is a projection of the IMAP credentials; deleting it would
    // mean losing the account.
    mayDelete: false,
  };
}

/** An identity the account added itself, kept in the pref table under PREF_IDENTITIES. */
type ExtraIdentity = Omit<IdentityJson, "id" | "mayDelete">;

const PREF_IDENTITIES = "identities";

function extraIdentities(store: Store, accountId: number): Record<string, ExtraIdentity> {
  return store.getPref<Record<string, ExtraIdentity>>(accountId, PREF_IDENTITIES) ?? {};
}

function allIdentities(account: AccountRow, store: Store): IdentityJson[] {
  const extras = Object.entries(extraIdentities(store, account.id)).map(([id, x]) => ({ id, ...x, mayDelete: true }));
  return [projectIdentity(account, store), ...extras];
}

export async function identityGet(
  args: { accountId: string; ids: string[] | null },
  ctx: { account: AccountRow; store: Store },
): Promise<{ accountId: string; state: string; list: IdentityJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const all = allIdentities(ctx.account, ctx.store);
  const list = args.ids ? all.filter((i) => args.ids!.includes(i.id)) : all;
  const notFound = args.ids ? args.ids.filter((x) => !all.some((i) => i.id === x)) : [];
  return {
    accountId: args.accountId,
    state: identityState(ctx.store, ctx.account.id),
    list,
    notFound,
  };
}

export interface IdentitySetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
}

// The singleton takes name, replyTo, textSignature and htmlSignature; its
// email is the IMAP login and it cannot be destroyed. Any other identity is
// the account's own: created with whatever address the client names, since
// the MTA is the one place that knows which senders a login may use and it
// enforces that on MAIL FROM regardless of what the proxy accepts.
export async function identitySet(
  args: IdentitySetArgs,
  ctx: { account: AccountRow; store: Store },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const oldState = identityState(ctx.store, ctx.account.id);
  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new JmapError("stateMismatch", "ifInState does not match current Identity state");
  }
  const id = singletonId(ctx.account.id);
  const extras = extraIdentities(ctx.store, ctx.account.id);
  let extrasTouched = false;

  const created: Record<string, { id: string; mayDelete: boolean }> = {};
  const notCreated: Record<string, SetError> = {};
  for (const [tempId, raw] of Object.entries(args.create ?? {})) {
    try {
      const extra = parseExtraIdentity(raw);
      const newId = `${id}-${randomUUID().slice(0, 8)}`;
      extras[newId] = extra;
      extrasTouched = true;
      created[tempId] = { id: newId, mayDelete: true };
    } catch (e) {
      notCreated[tempId] = toSetError(e);
    }
  }

  const notUpdated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  for (const [target, patch] of Object.entries(args.update ?? {})) {
    try {
      if (target === id) {
        applyIdentityPatch(ctx, patch);
      } else if (extras[target]) {
        extras[target] = applyExtraPatch(extras[target], patch);
        extrasTouched = true;
      } else {
        notUpdated[target] = { type: "notFound" };
        continue;
      }
      updated[target] = null;
    } catch (e) {
      notUpdated[target] = toSetError(e);
    }
  }

  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  for (const target of args.destroy ?? []) {
    if (target === id) {
      notDestroyed[target] = { type: "forbidden", description: "Identity may not be destroyed" };
    } else if (extras[target]) {
      delete extras[target];
      extrasTouched = true;
      destroyed.push(target);
    } else {
      notDestroyed[target] = { type: "notFound" };
    }
  }

  if (extrasTouched) ctx.store.setPref(ctx.account.id, PREF_IDENTITIES, extras);
  ctx.store.recordChanges(ctx.account.id, "identity", {
    created: Object.values(created).map((c) => c.id),
    updated: Object.keys(updated),
    destroyed,
  });

  return {
    accountId: args.accountId,
    oldState,
    newState: identityState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: Object.keys(updated).length ? updated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: destroyed.length ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

/** A full identity from a create body: email required, the rest optional. */
function parseExtraIdentity(raw: Record<string, unknown>): ExtraIdentity {
  if (!raw || typeof raw !== "object") throw new JmapError("invalidProperties", "create entry must be an object");
  const email = typeof raw["email"] === "string" ? raw["email"].trim() : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new JmapError("invalidProperties", "email must be an email address", { properties: ["email"] });
  }
  const base: ExtraIdentity = { name: "", email, replyTo: null, bcc: null, textSignature: "", htmlSignature: "" };
  const { email: _e, ...rest } = raw;
  return applyExtraPatch(base, rest);
}

function applyExtraPatch(cur: ExtraIdentity, patch: Record<string, unknown>): ExtraIdentity {
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "name":
      case "textSignature":
      case "htmlSignature":
        if (v != null && typeof v !== "string") {
          throw new JmapError("invalidProperties", `${k} must be a string`, { properties: [k] });
        }
        next[k] = (v as string | null) ?? "";
        break;
      case "replyTo":
      case "bcc":
        next[k] = parseAddressList(v, k);
        break;
      case "email":
        // Immutable per RFC 8621 §6.1; the same value echoed back is fine.
        if (v !== cur.email) throw new JmapError("invalidProperties", "email is immutable", { properties: [k] });
        break;
      case "id":
      case "mayDelete":
        break;
      default:
        throw new JmapError("invalidProperties", `unknown property: ${k}`, { properties: [k] });
    }
  }
  return next;
}

function parseAddressList(v: unknown, k: string): { name?: string | null; email: string }[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new JmapError("invalidProperties", `${k} must be an array or null`, { properties: [k] });
  return v.map((entry) => {
    const e = entry as { name?: string | null; email?: unknown };
    if (typeof e.email !== "string") {
      throw new JmapError("invalidProperties", `${k}[].email is required`, { properties: [k] });
    }
    return { name: e.name ?? null, email: e.email };
  });
}

function applyIdentityPatch(
  ctx: { account: AccountRow; store: Store },
  patch: Record<string, unknown>,
): void {
  const cur = ctx.store.getIdentitySettings(ctx.account.id);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "name":
        if (v != null && typeof v !== "string") {
          throw new JmapError("invalidProperties", "name must be a string", { properties: [k] });
        }
        next.displayName = (v as string | null) ?? null;
        break;
      case "textSignature":
        if (v != null && typeof v !== "string") {
          throw new JmapError("invalidProperties", "textSignature must be a string", { properties: [k] });
        }
        next.textSignature = (v as string | null) ?? null;
        break;
      case "htmlSignature":
        if (v != null && typeof v !== "string") {
          throw new JmapError("invalidProperties", "htmlSignature must be a string", { properties: [k] });
        }
        next.htmlSignature = (v as string | null) ?? null;
        break;
      case "replyTo":
        next.replyTo = parseAddressList(v, k);
        break;
      case "email":
        // Server-derived; per RFC 8621 §6.1 changes are not allowed.
        if (v !== deriveIdentityEmail(ctx.account)) {
          throw new JmapError("invalidProperties", "email is server-controlled", {
            properties: [k],
          });
        }
        break;
      case "id":
      case "mayDelete":
      case "bcc":
        // ids are immutable; bcc and mayDelete are read-only in our model.
        break;
      default:
        throw new JmapError("invalidProperties", `unknown property: ${k}`, { properties: [k] });
    }
  }
  ctx.store.putIdentitySettings(ctx.account.id, next);
}

export async function identityChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; store: Store },
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "identity");
  const currentRaw = identityState(ctx.store, ctx.account.id);
  let sinceNumeric: number;
  try {
    sinceNumeric = decodeCounterState(args.sinceState);
  } catch {
    return changesOrCannotCalculate(args.accountId, args.sinceState, currentRaw);
  }
  return changesFromLog({
    accountId: args.accountId,
    store: ctx.store,
    numericAccountId: ctx.account.id,
    kind: "identity",
    sinceStateRaw: args.sinceState,
    sinceStateNumeric: sinceNumeric,
    currentStateRaw: currentRaw,
    currentStateNumeric: currentNumeric,
  });
}

function toSetError(e: unknown): SetError {
  if (e instanceof JmapError) return e.toMethodError() as SetError;
  return { type: "serverFail", description: (e as Error).message };
}
