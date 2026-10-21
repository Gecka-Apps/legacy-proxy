// Limits one authenticated account cannot push past: pending uploads per
// account, and the attachments a single Email/set create may load.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type AccountRow } from "../../src/state/store.js";
import { emailSet } from "../../src/jmap/methods/email.js";
import { encodeMailboxId } from "../../src/mapping/ids.js";
import { MAX_SIZE_ATTACHMENTS_PER_EMAIL } from "../../src/jmap/capabilities.js";

let dir: string;
let store: Store;
let account: AccountRow;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "limits-"));
  store = new Store(dir);
  account = store.upsertAccount({ slug: "a", kind: "generic", host: "example.org", username: "u@example.org", vault: Buffer.from("v") });
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("upload quota", () => {
  const put = (id: string, size: number, accountId = account.id) =>
    store.putUpload({ id, accountId, ctype: "application/octet-stream", body: Buffer.alloc(size) });

  it("drops the account's oldest uploads until the new one fits", () => {
    vi.useFakeTimers();
    try {
      for (const id of ["U1", "U2", "U3"]) {
        put(id, 40);
        vi.advanceTimersByTime(1000);
      }
      put("other", 40, account.id + 1);
      store.makeRoomForUpload(account.id, 50, 100);
      expect(["U1", "U2", "U3"].map((id) => store.getUpload(id, account.id) !== null)).toEqual([false, false, true]);
      expect(store.getUpload("other", account.id + 1)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never keeps an older upload past a newer one it had to drop", () => {
    vi.useFakeTimers();
    try {
      put("small-old", 10);
      vi.advanceTimersByTime(1000);
      put("big-new", 80);
      store.makeRoomForUpload(account.id, 30, 100);
      expect(store.getUpload("big-new", account.id)).toBeNull();
      expect(store.getUpload("small-old", account.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Email/set create", () => {
  it("refuses attachments past maxSizeAttachmentsPerEmail before writing anything", async () => {
    const mailboxId = Number(
      store.prep(`INSERT INTO mailbox(account_id, name, uidvalidity) VALUES (?, 'Drafts', 1)`).run(account.id).lastInsertRowid,
    );
    const half = Math.floor(MAX_SIZE_ATTACHMENTS_PER_EMAIL / 2) + 1;
    for (const id of ["Ua", "Ub"]) store.putUpload({ id, accountId: account.id, ctype: "application/pdf", body: Buffer.alloc(half) });
    const append = vi.fn();
    const r = await emailSet(
      {
        accountId: String(account.id),
        create: {
          d: {
            mailboxIds: { [encodeMailboxId({ accountIdx: account.id, mailboxIdx: mailboxId })]: true },
            subject: "big",
            textBody: [{ partId: "1", type: "text/plain" }],
            bodyValues: { "1": { value: "x" } },
            attachments: [
              { blobId: "Ua", type: "application/pdf", name: "a.pdf" },
              { blobId: "Ub", type: "application/pdf", name: "b.pdf" },
            ],
          },
        },
      } as never,
      { account, store, client: { append } as never },
    );
    expect(r.notCreated?.d).toMatchObject({ type: "tooLarge" });
    expect(append).not.toHaveBeenCalled();
  });
});
