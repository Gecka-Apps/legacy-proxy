// The IDLE worker follows open EventSource streams as well as verified push
// subscriptions, and outlives an account's last stream by a grace period.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const opened: FakeClient[] = [];

class FakeClient extends EventEmitter {
  loggedOut = false;
  async mailboxOpen(): Promise<void> {}
  async noop(): Promise<void> {}
  async logout(): Promise<void> {
    this.loggedOut = true;
  }
}

vi.mock("../../src/imap/client.js", () => ({
  openImap: vi.fn(async () => {
    const c = new FakeClient();
    opened.push(c);
    return c;
  }),
}));
vi.mock("../../src/auth/credentials.js", () => ({
  openCredentials: vi.fn(async () => ({ mech: "PLAIN", username: "u", password: "p" })),
}));
vi.mock("../../src/auth/providers.js", () => ({
  resolveProvider: vi.fn(() => ({ imap: { host: "imap.test", port: 993 } })),
}));

const { PushIdleManager } = await import("../../src/push/idle.js");
import type { AccountRow, Store } from "../../src/state/store.js";
import type { AppConfig } from "../../src/util/config.js";

const account = { id: 7, slug: "a", kind: "generic", vault: Buffer.alloc(0) } as AccountRow;
let pushAccounts: number[] = [];
const store = {
  accountsWithActivePushSubs: () => pushAccounts,
  getAccountById: (id: number) => (id === account.id ? account : undefined),
  bumpState: () => 1,
} as unknown as Store;

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  opened.length = 0;
  pushAccounts = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PushIdleManager and EventSource streams", () => {
  it("watches an account while a stream is open, without any push subscription", async () => {
    const m = new PushIdleManager({ vaultKey: Buffer.alloc(32) } as AppConfig, store);
    m.streamOpened(account.id);
    await flush();
    expect(opened).toHaveLength(1);

    m.streamOpened(account.id);
    await flush();
    expect(opened).toHaveLength(1);
    await m.closeAll();
  });

  it("keeps the worker through a reconnect and drops it after the grace period", async () => {
    const m = new PushIdleManager({ vaultKey: Buffer.alloc(32) } as AppConfig, store);
    m.streamOpened(account.id);
    await flush();
    m.streamClosed(account.id);
    await vi.advanceTimersByTimeAsync(30_000);
    m.streamOpened(account.id);
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.loggedOut).toBe(false);

    m.streamClosed(account.id);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(opened[0]!.loggedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opened[0]!.loggedOut).toBe(true);
    await m.closeAll();
  });

  it("keeps watching after the last stream when a push subscription remains", async () => {
    pushAccounts = [account.id];
    const m = new PushIdleManager({ vaultKey: Buffer.alloc(32) } as AppConfig, store);
    m.streamOpened(account.id);
    await flush();
    m.streamClosed(account.id);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.loggedOut).toBe(false);
    await m.closeAll();
  });
});
