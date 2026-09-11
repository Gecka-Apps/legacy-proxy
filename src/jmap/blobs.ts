// Read a blob by id into memory, whichever backing it has: an upload (`U…`),
// the download cache, or an IMAP message / part (`E…` / `P…`). The download
// route streams the IMAP case; this buffered variant serves method handlers
// that need the whole body (CalendarEvent/parse on an invitation attachment).

import type { Readable } from "node:stream";
import type { ImapPool } from "../imap/pool.js";
import type { AccountRow, Store } from "../state/store.js";
import { decodeBlobId, decodeEmailId } from "../mapping/ids.js";

export interface BlobCtx {
  account: AccountRow;
  store: Store;
  pool?: ImapPool;
}

export interface BlobData {
  ctype: string;
  body: Buffer;
}

/** Upper bound for a buffered read; anything larger is treated as absent. */
const MAX_BUFFERED_BLOB = 8 * 1024 * 1024;

export async function readBlob(ctx: BlobCtx, blobId: string): Promise<BlobData | null> {
  if (blobId.startsWith("U")) {
    const up = ctx.store.getUpload(blobId, ctx.account.id);
    return up ? { ctype: up.ctype, body: up.body } : null;
  }
  const cached = ctx.store.getCachedBlob(blobId, ctx.account.id);
  if (cached) return { ctype: cached.ctype ?? "application/octet-stream", body: cached.body };
  if (!ctx.pool) return null;

  let parsed: { emailId: string; partId: string | null };
  let emailParts: { mailboxIdx: number; uid: number };
  try {
    parsed = decodeBlobId(blobId);
    emailParts = decodeEmailId(parsed.emailId);
  } catch {
    return null;
  }
  const mbox = ctx.store
    .prep(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(emailParts.mailboxIdx, ctx.account.id) as { id: number; name: string } | undefined;
  if (!mbox) return null;

  return ctx.pool.withConnection(ctx.account, "bulk", async (client) => {
    const lock = await client.getMailboxLock(mbox.name);
    try {
      const dl = await client.download(`${emailParts.uid}`, parsed.partId ?? undefined, { uid: true });
      if (!dl) return null;
      const ctype = parsed.partId ? dl.meta?.contentType ?? "application/octet-stream" : "message/rfc822";
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of dl.content as Readable) {
        size += (chunk as Buffer).length;
        if (size > MAX_BUFFERED_BLOB) return null;
        chunks.push(chunk as Buffer);
      }
      return { ctype, body: Buffer.concat(chunks) };
    } finally {
      lock.release();
    }
  });
}
