// The in-memory change log behind */changes: it answers only for a range it
// can account for state by state, and leaves the rest to cannotCalculateChanges.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "changelog-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("entriesSince", () => {
  it("returns what was logged between two states", () => {
    const s0 = store.getState(1, "email");
    store.recordChanges(1, "email", { created: ["a"] });
    const s2 = store.recordChanges(1, "email", { updated: ["a"], destroyed: ["b"] });
    expect(store.entriesSince(1, "email", s0, s2)?.map((e) => `${e.action}:${e.id}`)).toEqual(["created:a", "updated:a", "destroyed:b"]);
  });

  it("gives up when a bare state bump left a gap, as an IDLE arrival does", () => {
    const s0 = store.getState(1, "email");
    store.recordChanges(1, "email", { updated: ["a"] });
    const s1 = store.getState(1, "email");
    store.bumpState(1, "email");
    const s2 = store.getState(1, "email");
    expect(store.entriesSince(1, "email", s0, s1)).not.toBeNull();
    expect(store.entriesSince(1, "email", s1, s2)).toBeNull();
    expect(store.entriesSince(1, "email", s0, s2)).toBeNull();
    const s3 = store.recordChanges(1, "email", { updated: ["c"] });
    expect(store.entriesSince(1, "email", s2, s3)?.map((e) => e.id)).toEqual(["c"]);
  });

  it("gives up with nothing logged and on a sinceState from the future", () => {
    store.bumpState(1, "email");
    expect(store.entriesSince(1, "email", 0, 1)).toBeNull();
    expect(store.entriesSince(1, "email", 5, 1)).toBeNull();
    expect(store.entriesSince(1, "email", 1, 1)).toEqual([]);
  });
});
