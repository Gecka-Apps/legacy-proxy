import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildRfc822, collectBlobIds, type JmapEmailCreate } from "../../src/mapping/buildMime.js";

const BLOBS: Record<string, { body: Buffer; ctype: string }> = {
  Updf: { body: Buffer.from("%PDF-1.4 fake"), ctype: "application/pdf" },
  Upng: { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), ctype: "image/png" },
};
const getBlob = (id: string) => BLOBS[id] ?? null;

function simple(over: Partial<JmapEmailCreate> = {}): JmapEmailCreate {
  return {
    from: [{ email: "me@x.io" }],
    to: [{ email: "you@x.io" }],
    subject: "hi",
    bodyValues: { t: { value: "plain" }, h: { value: '<p>rich <img src="cid:logo@x"></p>' } },
    textBody: [{ partId: "t" }],
    htmlBody: [{ partId: "h", type: "text/html" }],
    ...over,
  };
}

describe("buildRfc822, simple form", () => {
  it("hangs attachments off a multipart/mixed root, alternative first", async () => {
    const mime = await buildRfc822(
      simple({
        attachments: [{ blobId: "Updf", type: "application/pdf", name: "doc.pdf", disposition: "attachment" }],
      }),
      "x.io",
      getBlob,
    );
    const raw = mime.toString();
    expect(raw).toMatch(/^Content-Type: multipart\/mixed;/m);
    const parsed = await simpleParser(mime);
    expect(parsed.text?.trim()).toBe("plain");
    expect(parsed.html).toContain("rich");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe("doc.pdf");
    expect(parsed.attachments[0]!.contentType).toBe("application/pdf");
    expect(parsed.attachments[0]!.content.toString()).toBe("%PDF-1.4 fake");
    expect(parsed.attachments[0]!.contentDisposition).toBe("attachment");
  });

  it("groups cid-referenced inline parts with the HTML in a multipart/related", async () => {
    const mime = await buildRfc822(
      simple({
        attachments: [
          { blobId: "Upng", type: "image/png", name: "logo.png", disposition: "inline", cid: "logo@x" },
          { blobId: "Updf", type: "application/pdf", name: "doc.pdf" },
        ],
      }),
      "x.io",
      getBlob,
    );
    const raw = mime.toString();
    expect(raw).toMatch(/^Content-Type: multipart\/mixed;/m);
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain('multipart/related; type="text/html"');
    expect(raw).toContain("Content-ID: <logo@x>");
    const parsed = await simpleParser(mime);
    const byName = Object.fromEntries(parsed.attachments.map((a) => [a.filename, a]));
    expect(byName["logo.png"]!.contentDisposition).toBe("inline");
    expect(byName["doc.pdf"]!.contentDisposition).toBe("attachment");
  });

  it("keeps a bare text body single-part when there is nothing to attach", async () => {
    const mime = await buildRfc822(simple({ htmlBody: null, attachments: [] }), "x.io", getBlob);
    expect(mime.toString()).toMatch(/^Content-Type: text\/plain; charset=utf-8/m);
  });

  it("fails the create with blobNotFound for an unknown blob", async () => {
    await expect(
      buildRfc822(simple({ attachments: [{ blobId: "Unope", type: "application/pdf" }] }), "x.io", getBlob),
    ).rejects.toMatchObject({ type: "blobNotFound", properties: { notFound: ["Unope"] } });
  });
});

describe("collectBlobIds", () => {
  it("lists blobs from bodyStructure leaves and simple-form attachments once", () => {
    const ids = collectBlobIds({
      bodyStructure: {
        type: "multipart/mixed",
        subParts: [{ partId: "t", type: "text/plain" }, { blobId: "Updf", type: "application/pdf" }],
      },
      attachments: [{ blobId: "Updf" }, { blobId: "Upng" }],
    });
    expect(ids).toEqual(["Updf", "Upng"]);
  });
});
