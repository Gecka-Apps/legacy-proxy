import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImapFlow } from "imapflow";
import { Store } from "../../src/state/store.js";
import { emailQuery } from "../../src/jmap/methods/email.js";
import { decodeEmailId, encodeMailboxId } from "../../src/mapping/ids.js";

// What imapflow yields for a date it could not parse: the raw string.
const UNPARSEABLE =
  "Tue, 3 Nov 2026 04:21:57 +0000 From: Sender <sender@example.com> MIME-Version: 1.0";

interface Message {
  uid: number;
  internalDate: Date | string;
  date: Date | string;
  flags?: string[];
}

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "querysortdate-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function query(messages: Message[], sort: unknown[]): Promise<number[]> {
  const account = store.upsertAccount({ slug: "a", kind: "generic", host: "h", username: "u", vault: Buffer.from("v") });
  store
    .prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'INBOX', 1)`)
    .run(account.id);
  const mailboxIdx = (store.prep(`SELECT id FROM mailbox WHERE name = 'INBOX'`).get() as { id: number }).id;

  const client = {
    mailbox: { path: "INBOX", uidValidity: 1n, highestModseq: 5n },
    getMailboxLock: async () => ({ release: () => {} }),
    noop: async () => {},
    search: async () => messages.map((m) => m.uid),
    fetch: async function* () {
      for (const m of messages) {
        yield {
          uid: m.uid,
          internalDate: m.internalDate,
          size: 100,
          envelope: { date: m.date },
          flags: new Set(m.flags ?? []),
        };
      }
    },
  };
  const ctx = { account, client: client as unknown as ImapFlow, store };
  const result = await emailQuery(
    {
      accountId: String(account.id),
      filter: { inMailbox: encodeMailboxId({ accountIdx: account.id, mailboxIdx }) },
      sort,
    } as never,
    ctx,
  );
  return result.ids.map((id) => decodeEmailId(id).uid);
}

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4, 21, 57));

it("sorts a message whose Date header does not parse as the oldest by sentAt", async () => {
  const messages: Message[] = [1, 2, 3, 4, 5, 6, 7, 8].map((uid) => ({
    uid,
    internalDate: day(uid),
    date: uid === 4 ? UNPARSEABLE : day(uid),
  }));
  const uids = await query(messages, [{ property: "sentAt", isAscending: false }]);
  expect(uids).toEqual([8, 7, 6, 5, 3, 2, 1, 4]);
});

it("sorts a message whose INTERNALDATE does not parse as the oldest behind the flagged ones", async () => {
  const messages: Message[] = [1, 2, 3, 4, 5, 6, 7, 8].map((uid) => ({
    uid,
    internalDate: uid === 5 ? "not a date" : day(uid),
    date: day(uid),
    flags: uid === 2 ? ["\\Flagged"] : [],
  }));
  const uids = await query(messages, [
    { property: "hasKeyword", keyword: "$flagged", isAscending: false },
    { property: "receivedAt", isAscending: false },
  ]);
  expect(uids).toEqual([2, 8, 7, 6, 4, 3, 1, 5]);
});
