import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { KNOWN_CAPABILITIES } from "../../src/jmap/capabilities.js";
import { buildSession } from "../../src/jmap/session.js";
import type { AppConfig, ProviderConfig } from "../../src/util/config.js";
import type { AccountRow } from "../../src/state/store.js";

const cfg: AppConfig = {
  port: 8080,
  publicUrl: "http://localhost:8080",
  dataDir: "/tmp",
  vaultKey: Buffer.alloc(32),
  sessionHmacKey: Buffer.alloc(32),
  defaultProvider: "generic",
  providers: {},
  limits: {
    maxConcurrentRequests: 10,
    maxObjectsInGet: 500,
    maxObjectsInSet: 500,
    maxSizeUpload: 50_000_000,
    maxSizeRequest: 10_000_000,
    maxCallsInRequest: 64,
  },
};

const account = { id: 1, username: "bob@x.io" } as AccountRow;

const providerWithContacts: ProviderConfig = {
  imap: { host: "imap.x.io", port: 993 },
  smtp: { host: "smtp.x.io", port: 465 },
  sieve: null,
  carddav: { host: "radicale.x.io", port: 443, secure: true, basePath: "/" },
  auth: { mech: ["PLAIN"] },
};

describe("capability allowlist", () => {
  // Regression for issue #3: the session advertised jmap:contacts when a
  // carddav backend was configured, but /jmap rejected any request `using`
  // it with 400 unknownCapability, so nothing ever reached the DAV server.
  it("accepts every capability the session can advertise", () => {
    const everything: ProviderConfig = {
      ...providerWithContacts,
      sieve: { host: "imap.x.io", port: 4190, starttls: true },
      caldav: { host: "radicale.x.io", port: 443, secure: true, basePath: "/" },
    };
    const session = buildSession(cfg, account, everything);
    for (const cap of Object.keys(session.capabilities)) {
      expect(KNOWN_CAPABILITIES.has(cap), `KNOWN_CAPABILITIES is missing ${cap}`).toBe(true);
    }
    expect(Object.keys(session.capabilities)).toEqual(
      expect.arrayContaining(["urn:ietf:params:jmap:sieve", "urn:ietf:params:jmap:calendars", "urn:ietf:params:jmap:contacts"]),
    );
  });

  it("advertises RFC 9661 sieve and calendars only when their backends are configured", () => {
    const bare = buildSession(cfg, account, providerWithContacts);
    expect(Object.keys(bare.capabilities)).not.toContain("urn:ietf:params:jmap:sieve");
    expect(Object.keys(bare.capabilities)).not.toContain("urn:ietf:params:jmap:calendars");

    const full = buildSession(
      cfg,
      account,
      { ...providerWithContacts, sieve: { host: "imap.x.io", port: 4190 }, caldav: { host: "radicale.x.io", port: 443 } },
      { sieve: { implementation: "Dovecot Pigeonhole", extensions: ["fileinto", "include"], notify: [], maxRedirects: 4 } },
    );
    const acct = full.accounts["1"]!.accountCapabilities as Record<string, Record<string, unknown>>;
    expect(acct["urn:ietf:params:jmap:sieve"]).toMatchObject({ implementation: "Dovecot Pigeonhole", sieveExtensions: ["fileinto", "include"], maxNumberRedirects: 4 });
    expect(full.primaryAccounts["urn:ietf:params:jmap:calendars"]).toBe("1");
    expect(full.primaryAccounts["urn:ietf:params:jmap:sieve"]).toBe("1");
  });

  it("advertises contacts only when carddav is configured", () => {
    const withoutContacts = buildSession(cfg, account, { ...providerWithContacts, carddav: null });
    expect(Object.keys(withoutContacts.capabilities)).not.toContain("urn:ietf:params:jmap:contacts");
    const withContacts = buildSession(cfg, account, providerWithContacts);
    expect(Object.keys(withContacts.capabilities)).toContain("urn:ietf:params:jmap:contacts");
  });
});
