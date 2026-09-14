// Build an RFC 5322 / MIME message from a JMAP Email/set create payload.
// Used by Email/set create (drafts) which APPENDs the result via IMAP.
//
// We use nodemailer's MimeNode (already a transitive dep) to handle
// quoted-printable encoding, header folding, and message id generation.

import MimeNode from "nodemailer/lib/mime-node/index.js";
import { JmapError } from "../jmap/errors.js";

interface JmapAddress {
  name?: string | null;
  email?: string;
}

interface BodyPartRef {
  partId?: string;
}

interface BodyValue {
  value?: string;
}

// JMAP `bodyStructure` (RFC 8621 §4.1.4): a recursive tree describing the
// MIME hierarchy. Leaves carry either a partId (resolved through bodyValues)
// or a blobId (references a previously-uploaded blob).
export interface BodyStructurePart {
  type?: string;
  partId?: string;
  blobId?: string;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  charset?: string | null;
  subParts?: BodyStructurePart[];
}

export interface JmapEmailCreate {
  bodyStructure?: BodyStructurePart | null;
  from?: JmapAddress[] | null;
  sender?: JmapAddress[] | null;
  to?: JmapAddress[] | null;
  cc?: JmapAddress[] | null;
  bcc?: JmapAddress[] | null;
  replyTo?: JmapAddress[] | null;
  subject?: string | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  messageId?: string[] | null;
  sentAt?: string | null;
  textBody?: BodyPartRef[] | null;
  htmlBody?: BodyPartRef[] | null;
  // Simple form companion of textBody/htmlBody (RFC 8621 §4.6): leaf parts
  // by blobId, each with its own type, name, disposition and cid.
  attachments?: BodyStructurePart[] | null;
  bodyValues?: Record<string, BodyValue> | null;
  // Headers passed through verbatim (asRaw form). We don't attempt to
  // re-parse these; clients that send us structured forms should map them
  // before submission.
  headers?: { name: string; value: string }[] | null;
}

function jmapAddrToHeader(list: JmapAddress[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.email)
    .map((a) => {
      const name = a.name?.trim();
      const email = a.email!;
      if (!name) return email;
      // Quote names that contain RFC 5322 specials
      const escaped = /[",;:<>@()\[\]\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
      return `${escaped} <${email}>`;
    })
    .join(", ");
}

// Walk a bodyStructure tree into a nodemailer MimeNode. Multipart parts
// (type starting with "multipart/") get child nodes; leaves are filled from
// either bodyValues[partId] (text/* parts) or getBlob(blobId) (attachments).
function nodeFromBodyStructure(
  part: BodyStructurePart,
  bodyValues: Record<string, BodyValue> | null,
  getBlob: BlobLookup,
  hostname: string,
): MimeNode {
  const type = part.type ?? "text/plain";
  if (type.toLowerCase().startsWith("multipart/")) {
    const node = new MimeNode(type, { hostname });
    for (const child of part.subParts ?? []) {
      node.appendChild(nodeFromBodyStructure(child, bodyValues, getBlob, hostname));
    }
    return node;
  }
  // Leaf part: either text content via bodyValues, or a blob attachment.
  const headers: Record<string, string> = {};
  if (part.disposition || part.name) {
    const disp = part.disposition ?? "inline";
    const filename = part.name ? `; filename="${part.name.replace(/"/g, "")}"` : "";
    headers["Content-Disposition"] = `${disp}${filename}`;
  }
  if (part.cid) headers["Content-ID"] = `<${part.cid}>`;
  let contentType = type;
  if (type.toLowerCase().startsWith("text/")) {
    contentType = `${type}; charset=${part.charset ?? "utf-8"}`;
  }
  const node = new MimeNode(contentType, { hostname });
  for (const [k, v] of Object.entries(headers)) node.setHeader(k, v);

  if (part.partId && bodyValues?.[part.partId]?.value !== undefined) {
    node.setContent(bodyValues[part.partId]!.value!);
  } else if (part.blobId) {
    const blob = getBlob(part.blobId);
    if (!blob) {
      throw new JmapError("blobNotFound", `blob ${part.blobId} does not exist`, {
        notFound: [part.blobId],
      });
    }
    node.setContent(blob.body);
  }
  return node;
}

// Simple form (RFC 8621 §4.6): the server derives the MIME tree from
// textBody, htmlBody and attachments. Text and HTML sit in a
// multipart/alternative; inline parts referenced from the HTML by cid: are
// grouped with it in a multipart/related; the remaining attachments hang
// off a multipart/mixed root, in the order the client listed them.
function nodeFromSimpleForm(
  create: JmapEmailCreate,
  getBlob: BlobLookup,
  hostname: string,
): MimeNode {
  const text = resolveBody(create.textBody, create.bodyValues);
  const html = resolveBody(create.htmlBody, create.bodyValues);
  const attachments = (create.attachments ?? []).filter((a) => a.blobId);
  const related = html
    ? attachments.filter((a) => a.cid && (a.disposition ?? "inline").toLowerCase() === "inline")
    : [];
  const mixed = attachments.filter((a) => !related.includes(a));

  let htmlNode: MimeNode | null = null;
  if (html) {
    htmlNode = new MimeNode("text/html; charset=utf-8", { hostname });
    htmlNode.setContent(html);
    if (related.length) {
      const wrap = new MimeNode('multipart/related; type="text/html"', { hostname });
      wrap.appendChild(htmlNode);
      for (const a of related) wrap.appendChild(nodeFromBodyStructure(a, null, getBlob, hostname));
      htmlNode = wrap;
    }
  }

  let body: MimeNode;
  if (text && htmlNode) {
    body = new MimeNode("multipart/alternative", { hostname });
    body.createChild("text/plain; charset=utf-8").setContent(text);
    body.appendChild(htmlNode);
  } else if (htmlNode) {
    body = htmlNode;
  } else {
    body = new MimeNode("text/plain; charset=utf-8", { hostname });
    body.setContent(text ?? "");
  }

  if (mixed.length === 0) return body;
  const root = new MimeNode("multipart/mixed", { hostname });
  root.appendChild(body);
  for (const a of mixed) {
    root.appendChild(
      nodeFromBodyStructure({ ...a, disposition: a.disposition ?? "attachment" }, null, getBlob, hostname),
    );
  }
  return root;
}

function resolveBody(
  refs: BodyPartRef[] | null | undefined,
  values: Record<string, BodyValue> | null | undefined,
): string | null {
  if (!refs || refs.length === 0 || !values) return null;
  const chunks: string[] = [];
  for (const r of refs) {
    if (!r.partId) continue;
    const v = values[r.partId]?.value;
    if (typeof v === "string") chunks.push(v);
  }
  if (chunks.length === 0) return null;
  return chunks.join("\r\n");
}

export interface BlobLookup {
  // Returns the bytes behind a blobId, or null when there are none: the walk
  // then fails the create with blobNotFound. The lookup is synchronous for
  // buildRfc822's MimeNode walk; callers load IMAP-backed blobs beforehand
  // (see collectBlobIds).
  (blobId: string): { body: Buffer; ctype: string } | null;
}

export async function buildRfc822(
  create: JmapEmailCreate,
  hostname: string,
  getBlob: BlobLookup = () => null,
): Promise<Buffer> {
  // Choose a root structure based on the inputs we got. Prefer `bodyStructure`
  // (RFC 8621 §4.5.1 form 1) when present — it's the canonical source of
  // truth and drives multipart/alternative + attachments. Otherwise assemble
  // the tree from the simpler textBody/htmlBody/attachments form.
  const root: MimeNode = create.bodyStructure
    ? nodeFromBodyStructure(create.bodyStructure, create.bodyValues ?? null, getBlob, hostname)
    : nodeFromSimpleForm(create, getBlob, hostname);

  const setIfPresent = (header: string, value: string | null): void => {
    if (value) root.setHeader(header, value);
  };
  setIfPresent("From", jmapAddrToHeader(create.from));
  setIfPresent("Sender", jmapAddrToHeader(create.sender));
  setIfPresent("To", jmapAddrToHeader(create.to));
  setIfPresent("Cc", jmapAddrToHeader(create.cc));
  setIfPresent("Bcc", jmapAddrToHeader(create.bcc));
  setIfPresent("Reply-To", jmapAddrToHeader(create.replyTo));
  if (create.subject) root.setHeader("Subject", create.subject);

  const date = create.sentAt ? new Date(create.sentAt) : new Date();
  root.setHeader("Date", date.toUTCString().replace(/GMT/, "+0000"));

  if (create.messageId && create.messageId[0]) {
    root.setHeader("Message-ID", `<${create.messageId[0]}>`);
  }
  if (create.inReplyTo && create.inReplyTo.length) {
    root.setHeader("In-Reply-To", create.inReplyTo.map((id) => `<${id}>`).join(" "));
  }
  if (create.references && create.references.length) {
    root.setHeader("References", create.references.map((id) => `<${id}>`).join(" "));
  }

  // Verbatim headers (e.g. List-* additions). Skip headers we already set
  // so the explicit JMAP fields win.
  const reserved = new Set([
    "from",
    "sender",
    "to",
    "cc",
    "bcc",
    "reply-to",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
  ]);
  for (const h of create.headers ?? []) {
    if (!h?.name) continue;
    if (reserved.has(h.name.toLowerCase())) continue;
    root.setHeader(h.name, h.value ?? "");
  }

  return await new Promise<Buffer>((resolve, reject) => {
    root.build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

// Every blobId a create payload references, bodyStructure leaves and simple
// form attachments alike, so the caller can load them before the synchronous
// MIME walk.
export function collectBlobIds(create: JmapEmailCreate): string[] {
  const ids = new Set<string>();
  const walk = (part: BodyStructurePart | null | undefined): void => {
    if (!part) return;
    if (part.blobId) ids.add(part.blobId);
    for (const child of part.subParts ?? []) walk(child);
  };
  walk(create.bodyStructure);
  for (const a of create.attachments ?? []) walk(a);
  return [...ids];
}
