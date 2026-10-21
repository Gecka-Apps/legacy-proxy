// Email/query reuses an IMAP SEARCH while nothing moved; an arrival seen by
// the IDLE worker on another connection must still force a new one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type AccountRow } from "../../src/state/store.js";
import { emailQuery } from "../../src/jmap/methods/email.js";
import { encodeMailboxId } from "../../src/mapping/ids.js";

let dir: string;
let store: Store;
let account: AccountRow;
let inbox: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "searchcache-"));
  store = new Store(dir);
  account = store.upsertAccount({ slug: "a", kind: "generic", host: "example.org", username: "u@example.org", vault: Buffer.from("v") });
  const id = Number(store.prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'INBOX', 1)`).run(account.id).lastInsertRowid);
  inbox = encodeMailboxId({ accountIdx: account.id, mailboxIdx: id });
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Email/query search cache", () => {
  it("searches again once the account's email state moved", async () => {
    let uids = [1, 2];
    const search = vi.fn(async () => uids);
    const client = {
      mailbox: { path: "INBOX", uidValidity: 1n, highestModseq: 7n },
      getMailboxLock: async () => ({ release: () => {} }),
      search,
    };
    const ctx = { account, store, client: client as never };
    const args = { accountId: String(account.id), filter: { inMailbox: inbox }, sort: [{ property: "receivedAt", isAscending: false }] };

    expect((await emailQuery(args as never, ctx)).ids).toHaveLength(2);
    expect((await emailQuery(args as never, ctx)).ids).toHaveLength(2);
    expect(search).toHaveBeenCalledTimes(1);

    uids = [1, 2, 3];
    store.bumpState(account.id, "email");
    expect((await emailQuery(args as never, ctx)).ids).toHaveLength(3);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
