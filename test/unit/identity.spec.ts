import { describe, expect, it, beforeEach } from "vitest";
import { identityGet, identitySet } from "../../src/jmap/methods/identity.js";
import type { AccountRow, Store } from "../../src/state/store.js";

function fakeStore() {
  const prefs = new Map<string, unknown>();
  let settings = { displayName: null, replyTo: null, textSignature: null, htmlSignature: null };
  let state = 0;
  const log: Array<{ created?: string[]; updated?: string[]; destroyed?: string[] }> = [];
  return {
    log,
    getPref: (_a: number, k: string) => prefs.get(k) ?? null,
    setPref: (_a: number, k: string, v: unknown) => prefs.set(k, v),
    deletePref: (_a: number, k: string) => prefs.delete(k),
    getIdentitySettings: () => settings,
    putIdentitySettings: (_a: number, s: typeof settings) => {
      settings = s;
    },
    getState: () => state,
    bumpState: () => ++state,
    recordChanges: (_a: number, _k: string, diff: { created?: string[]; updated?: string[]; destroyed?: string[] }) => {
      if (!diff.created?.length && !diff.updated?.length && !diff.destroyed?.length) return state;
      log.push(diff);
      return ++state;
    },
  } as unknown as Store & { log: typeof log };
}

const account = { id: 7, username: "u@x.io", host: "mail.x.io", kind: "generic" } as AccountRow;
let store: ReturnType<typeof fakeStore>;
let ctx: { account: AccountRow; store: Store };

beforeEach(() => {
  store = fakeStore();
  ctx = { account, store };
});

describe("Identity", () => {
  it("starts with the login identity alone, which cannot be destroyed", async () => {
    const r = await identityGet({ accountId: "7", ids: null }, ctx);
    expect(r.list).toEqual([expect.objectContaining({ id: "i-7", email: "u@x.io", mayDelete: false })]);
    const d = await identitySet({ accountId: "7", destroy: ["i-7"] }, ctx);
    expect(d.notDestroyed).toEqual({ "i-7": { type: "forbidden", description: "Identity may not be destroyed" } });
    expect(d.destroyed).toBeNull();
  });

  it("creates, lists, updates and destroys an alias identity", async () => {
    const c = await identitySet(
      { accountId: "7", create: { a: { name: "Alias", email: "alias@x.io", replyTo: [{ email: "u@x.io" }], textSignature: "-- a" } } },
      ctx,
    );
    expect(c.notCreated).toBeNull();
    const id = c.created!["a"]!.id;
    expect(id).toMatch(/^i-7-[0-9a-f]{8}$/);
    expect(c.created!["a"]).toEqual({ id, mayDelete: true });
    expect(c.newState).not.toBe(c.oldState);
    expect(store.log).toEqual([{ created: [id], updated: [], destroyed: [] }]);

    const r = await identityGet({ accountId: "7", ids: null }, ctx);
    expect(r.list.map((i) => i.id)).toEqual(["i-7", id]);
    expect(r.list[1]).toEqual({ id, name: "Alias", email: "alias@x.io", replyTo: [{ name: null, email: "u@x.io" }], bcc: null, textSignature: "-- a", htmlSignature: "", mayDelete: true });

    const u = await identitySet({ accountId: "7", update: { [id]: { name: "Alias 2", email: "alias@x.io", htmlSignature: "<b>a</b>" } } }, ctx);
    expect(u.notUpdated).toBeNull();
    expect(u.updated).toEqual({ [id]: null });
    expect((await identityGet({ accountId: "7", ids: [id] }, ctx)).list[0]).toMatchObject({ name: "Alias 2", htmlSignature: "<b>a</b>" });

    const d = await identitySet({ accountId: "7", destroy: [id] }, ctx);
    expect(d.destroyed).toEqual([id]);
    expect((await identityGet({ accountId: "7", ids: null }, ctx)).list.map((i) => i.id)).toEqual(["i-7"]);
    expect((await identityGet({ accountId: "7", ids: [id] }, ctx)).notFound).toEqual([id]);
  });

  it("requires an email address on create and keeps it immutable afterwards", async () => {
    const bad = await identitySet({ accountId: "7", create: { a: { name: "No mail" }, b: { email: "not-an-address" } } }, ctx);
    expect(bad.notCreated?.["a"]).toMatchObject({ type: "invalidProperties", properties: ["email"] });
    expect(bad.notCreated?.["b"]).toMatchObject({ type: "invalidProperties", properties: ["email"] });
    expect(bad.created).toBeNull();
    expect(bad.newState).toBe(bad.oldState);

    const ok = await identitySet({ accountId: "7", create: { a: { email: "alias@x.io" } } }, ctx);
    const id = ok.created!["a"]!.id;
    const u = await identitySet({ accountId: "7", update: { [id]: { email: "other@x.io" } } }, ctx);
    expect(u.notUpdated?.[id]).toMatchObject({ type: "invalidProperties", properties: ["email"] });
    const unknown = await identitySet({ accountId: "7", update: { "i-7-nope": { name: "x" } }, destroy: ["i-7-nope"] }, ctx);
    expect(unknown.notUpdated).toEqual({ "i-7-nope": { type: "notFound" } });
    expect(unknown.notDestroyed).toEqual({ "i-7-nope": { type: "notFound" } });
  });

  it("still edits the login identity and tolerates its email echoed back", async () => {
    const u = await identitySet({ accountId: "7", update: { "i-7": { name: "Me", email: "u@x.io", textSignature: "sig" } } }, ctx);
    expect(u.notUpdated).toBeNull();
    expect((await identityGet({ accountId: "7", ids: ["i-7"] }, ctx)).list[0]).toMatchObject({ name: "Me", textSignature: "sig" });
    const bad = await identitySet({ accountId: "7", update: { "i-7": { email: "other@x.io" } } }, ctx);
    expect(bad.notUpdated?.["i-7"]).toMatchObject({ type: "invalidProperties" });
  });
});
