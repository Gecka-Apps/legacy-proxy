// The attachments a single Email/set create may load.

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
