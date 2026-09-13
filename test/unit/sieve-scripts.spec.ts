// SieveScript/* (RFC 9661) and the wrapper-script manager, exercised against
// an in-memory ManageSieve server on a loopback TCP port. The fake speaks
// the subset Dovecot answers with, including `{N}` literals on NO lines
// (compile errors), so the real client's literal handling is covered too.

import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SieveClient } from "../../src/sieve/client.js";
import { WRAPPER_NAME, buildWrapper, isOurWrapperBody, listScriptsView, ownedScriptsOf, parseWrapper, registerInMaster, retargetMaster, unregisterFromMaster } from "../../src/sieve/manager.js";
import { readVacation, writeVacation } from "../../src/sieve/vacation.js";
import { sieveScriptGet, sieveScriptSet, sieveScriptValidate, scriptId, type SieveCtx } from "../../src/jmap/methods/sieve.js";
import { vacationGet, vacationSet } from "../../src/jmap/methods/vacation.js";
import type { AccountRow, Store } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

// -- fake ManageSieve server ---------------------------------------------------

class FakeSieve {
  scripts = new Map<string, string>();
  active: string | null = null;
  extensions = "fileinto vacation include imap4flags";
  server!: net.Server;
  port = 0;

  async listen(): Promise<void> {
    this.server = net.createServer((sock) => this.session(sock));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  close(): void {
    this.server.close();
  }

  private session(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    const send = (s: string) => sock.write(s);
    send(`"IMPLEMENTATION" "FakeSieve 1.0"\r\n"SIEVE" "${this.extensions}"\r\n"MAXREDIRECTS" "4"\r\n"NOTIFY" "mailto"\r\nOK "ready"\r\n`);
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const literal = (s: string) => `{${Buffer.byteLength(s)}}\r\n${s}`;

    const handle = (line: string, payload: string | null) => {
      const verb = line.split(" ")[0]!.toUpperCase();
      const args = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
      switch (verb) {
        case "AUTHENTICATE": {
          const [, user, pass] = Buffer.from(payload ?? "", "base64").toString("utf8").split("\0");
          send(user === "u" && pass === "p" ? "OK\r\n" : 'NO "auth"\r\n');
          return;
        }
        case "LISTSCRIPTS":
          for (const name of this.scripts.keys()) send(`${q(name)}${this.active === name ? " ACTIVE" : ""}\r\n`);
          send("OK\r\n");
          return;
        case "GETSCRIPT": {
          const body = this.scripts.get(args[0]!);
          if (body === undefined) return send('NO (NONEXISTENT) "There is no script by that name"\r\n');
          send(`${literal(body)}\r\nOK\r\n`);
          return;
        }
        case "PUTSCRIPT":
        case "CHECKSCRIPT": {
          const body = payload ?? "";
          if (/\bbogus\b/.test(body)) return send(`NO ${literal("line 1: error: unknown command 'bogus'.\nerror: validation failed.")}\r\n`);
          if (verb === "PUTSCRIPT") this.scripts.set(args[0]!, body);
          send("OK\r\n");
          return;
        }
        case "SETACTIVE":
          if (args[0] === "") this.active = null;
          else if (!this.scripts.has(args[0]!)) return send('NO (NONEXISTENT) "no such script"\r\n');
          else this.active = args[0]!;
          send("OK\r\n");
          return;
        case "DELETESCRIPT":
          if (!this.scripts.has(args[0]!)) return send('NO (NONEXISTENT) "no such script"\r\n');
          if (this.active === args[0]) return send('NO (ACTIVE) "script is active"\r\n');
          this.scripts.delete(args[0]!);
          send("OK\r\n");
          return;
        case "RENAMESCRIPT": {
          const body = this.scripts.get(args[0]!);
          if (body === undefined) return send('NO (NONEXISTENT) "no such script"\r\n');
          if (this.scripts.has(args[1]!)) return send('NO (ALREADYEXISTS) "exists"\r\n');
          this.scripts.delete(args[0]!);
          this.scripts.set(args[1]!, body);
          if (this.active === args[0]) this.active = args[1]!;
          send("OK\r\n");
          return;
        }
        case "LOGOUT":
          send('OK "bye"\r\n');
          sock.end();
          return;
        default:
          send('NO "unknown"\r\n');
      }
    };

    let pending: { line: string; need: number } | null = null;
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (pending) {
          if (buf.length < pending.need + 2) return;
          const payload = buf.subarray(0, pending.need).toString("utf8");
          buf = buf.subarray(pending.need + 2);
          const { line } = pending;
          pending = null;
          handle(line, payload);
          continue;
        }
        const idx = buf.indexOf("\r\n");
        if (idx < 0) return;
        const line = buf.subarray(0, idx).toString("utf8");
        buf = buf.subarray(idx + 2);
        const lit = /\{(\d+)\+?\}$/.exec(line);
        if (lit) pending = { line, need: Number(lit[1]) };
        else handle(line, null);
      }
    });
  }
}

// -- fixtures ------------------------------------------------------------------

const fake = new FakeSieve();
let provider: ProviderConfig;
const account = { id: 7, username: "u", kind: "generic", host: "x" } as AccountRow;
const creds = { mech: "PLAIN" as const, username: "u", password: "p" };

// Only what the handlers touch: uploads and the state counter.
function fakeStore() {
  const uploads = new Map<string, Buffer>();
  const states = new Map<string, number>();
  return {
    uploads,
    getUpload: (id: string) => (uploads.has(id) ? { ctype: "application/sieve", body: uploads.get(id)! } : null),
    getState: (_a: number, kind: string) => states.get(kind) ?? 0,
    bumpState: (_a: number, kind: string) => {
      const n = (states.get(kind) ?? 0) + 1;
      states.set(kind, n);
      return n;
    },
  } as unknown as Store & { uploads: Map<string, Buffer> };
}

let store: ReturnType<typeof fakeStore>;
let ctx: SieveCtx;

function upload(body: string): string {
  const id = `U${store.uploads.size + 1}`;
  store.uploads.set(id, Buffer.from(body));
  return id;
}

async function client(): Promise<SieveClient> {
  const c = new SieveClient({ host: "127.0.0.1", port: fake.port, creds });
  await c.connect();
  return c;
}

beforeAll(() => fake.listen());
afterAll(() => fake.close());
beforeEach(() => {
  fake.scripts.clear();
  fake.active = null;
  fake.extensions = "fileinto vacation include imap4flags";
  provider = { imap: { host: "x", port: 1 }, smtp: { host: "x", port: 1 }, sieve: { host: "127.0.0.1", port: fake.port }, carddav: null, auth: { mech: ["PLAIN"] } };
  store = fakeStore();
  ctx = { account, provider, creds, store };
});

// -- tests -----------------------------------------------------------------------

describe("ManageSieve client", () => {
  it("reads capabilities and folds NO literals into the error", async () => {
    const c = await client();
    expect(c.serverCapabilities()).toEqual({ implementation: "FakeSieve 1.0", extensions: ["fileinto", "vacation", "include", "imap4flags"], notify: ["mailto"], maxRedirects: 4 });
    await expect(c.checkScript("bogus;")).rejects.toThrow(/unknown command 'bogus'/);
    await c.checkScript('require ["fileinto"]; fileinto "X";');
    await c.logout();
  });
});

describe("wrapper script", () => {
  it("round-trips its includes", () => {
    const body = buildWrapper("filters");
    expect(parseWrapper(body)).toEqual(["vacation", "filters"]);
    expect(parseWrapper(buildWrapper(null))).toEqual(["vacation"]);
    expect(parseWrapper("# something else\nkeep;")).toEqual([]);
  });

  it("hides itself, shows only the scripts it registers and derives isActive from its includes", async () => {
    fake.scripts.set("filters", "keep;");
    fake.scripts.set("other", "keep;");
    fake.scripts.set("old", "keep;");
    fake.scripts.set(WRAPPER_NAME, registerInMaster(buildWrapper("filters"), "old"));
    fake.active = WRAPPER_NAME;
    const c = await client();
    expect(await listScriptsView(c)).toEqual([
      { name: "filters", isActive: true },
      { name: "old", isActive: false },
    ]);
    await c.logout();
  });

  it("carries a foreign active script untagged and never reports it as ours", () => {
    const body = buildWrapper("filters", "roundcube");
    expect(parseWrapper(body)).toEqual(["vacation", "roundcube", "filters"]);
    expect(ownedScriptsOf(body)).toEqual(["filters"]);
    expect(retargetMaster(body, null)).toContain('include :personal "roundcube";\r\n');
  });
});

describe("SieveScript/set", () => {
  it("creates, activates through the wrapper, and keeps vacation wired", async () => {
    const blobId = upload('require ["fileinto"];\nif header :contains "subject" "x" { fileinto "X"; }');
    const r = await sieveScriptSet({ accountId: "7", create: { s1: { name: "filters", blobId } }, onSuccessActivateScript: "#s1" }, ctx);
    expect(r.notCreated).toBeNull();
    expect(r.created?.s1).toMatchObject({ id: scriptId("filters"), isActive: true });
    expect(fake.active).toBe(WRAPPER_NAME);
    expect(parseWrapper(fake.scripts.get(WRAPPER_NAME)!)).toEqual(["vacation", "filters"]);

    const g = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g.list).toEqual([{ id: scriptId("filters"), name: "filters", blobId: expect.stringMatching(/^S/), isActive: true }]);

    // Vacation set afterwards must not steal the active slot.
    await vacationSet({ accountId: "7", update: { singleton: { isEnabled: true, subject: "Away", textBody: "Back soon" } } }, ctx);
    expect(fake.active).toBe(WRAPPER_NAME);
    expect(fake.scripts.get("vacation")).toContain("vacation :days 1");
    const v = await vacationGet({ accountId: "7" }, ctx);
    expect(v.list[0]).toMatchObject({ isEnabled: true, subject: "Away" });
    // And the client-facing list keeps hiding the wrapper while showing vacation.
    const g2 = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g2.list.map((s) => s.name).sort()).toEqual(["filters", "vacation"]);
  });

  it("reports compile errors as invalidScript with the server's message", async () => {
    const r = await sieveScriptSet({ accountId: "7", create: { s1: { name: "bad", blobId: upload("bogus;") } } }, ctx);
    expect(r.notCreated?.s1).toMatchObject({ type: "invalidScript", description: expect.stringContaining("unknown command 'bogus'") });
    expect(fake.scripts.has("bad")).toBe(false);
  });

  it("refuses to destroy the active script and reserved names", async () => {
    await sieveScriptSet({ accountId: "7", create: { s1: { name: "filters", blobId: upload("keep;") } }, onSuccessActivateScript: "#s1" }, ctx);
    const d = await sieveScriptSet({ accountId: "7", destroy: [scriptId("filters")] }, ctx);
    expect(d.notDestroyed?.[scriptId("filters")]).toMatchObject({ type: "scriptIsActive" });
    const r = await sieveScriptSet({ accountId: "7", create: { a: { name: WRAPPER_NAME, blobId: upload("keep;") }, b: { name: "vacation", blobId: upload("keep;") } } }, ctx);
    expect(r.notCreated?.a?.type).toBe("invalidProperties");
    expect(r.notCreated?.b?.type).toBe("forbidden");
  });

  it("deactivates with onSuccessActivateScript: null and then allows destroy", async () => {
    await sieveScriptSet({ accountId: "7", create: { s1: { name: "filters", blobId: upload("keep;") } }, onSuccessActivateScript: "#s1" }, ctx);
    const off = await sieveScriptSet({ accountId: "7", onSuccessActivateScript: null }, ctx);
    expect(off.updated?.[scriptId("filters")]).toEqual({ isActive: false });
    expect(parseWrapper(fake.scripts.get(WRAPPER_NAME)!)).toEqual(["vacation"]);
    expect(ownedScriptsOf(fake.scripts.get(WRAPPER_NAME)!)).toEqual(["filters"]);
    const still = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(still.list.map((x) => [x.name, x.isActive])).toEqual([["filters", false]]);
    const d = await sieveScriptSet({ accountId: "7", destroy: [scriptId("filters")] }, ctx);
    expect(d.destroyed).toEqual([scriptId("filters")]);
    expect(ownedScriptsOf(fake.scripts.get(WRAPPER_NAME)!)).toEqual([]);
  });

  it("falls back to plain SETACTIVE when the server lacks include", async () => {
    fake.extensions = "fileinto vacation";
    await sieveScriptSet({ accountId: "7", create: { s1: { name: "filters", blobId: upload("keep;") } }, onSuccessActivateScript: "#s1" }, ctx);
    expect(fake.active).toBe("filters");
    expect(fake.scripts.has(WRAPPER_NAME)).toBe(false);
    const g = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g.list[0]).toMatchObject({ name: "filters", isActive: true });
  });

  it("validates via CHECKSCRIPT", async () => {
    const ok = await sieveScriptValidate({ accountId: "7", blobId: upload("keep;") }, ctx);
    expect(ok.error).toBeNull();
    const bad = await sieveScriptValidate({ accountId: "7", blobId: upload("bogus;") }, ctx);
    expect(bad.error).toMatchObject({ type: "invalidScript" });
  });
});

describe("ManageSieve client failure modes", () => {
  it("rejects instead of hanging when the server goes silent", async () => {
    const silent = net.createServer(() => {
      /* accept and never speak */
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    const c = new SieveClient({ host: "127.0.0.1", port, creds, timeoutMs: 200 });
    await expect(c.connect()).rejects.toThrow(/timed out/);
    silent.close();
  });

  it("rejects a pending read when the server hangs up mid-command", async () => {
    const rude = net.createServer((sock) => {
      sock.write('"IMPLEMENTATION" "Rude"\r\nOK\r\n');
      sock.on("data", () => sock.destroy());
    });
    await new Promise<void>((r) => rude.listen(0, "127.0.0.1", () => r()));
    const port = (rude.address() as net.AddressInfo).port;
    const c = new SieveClient({ host: "127.0.0.1", port, creds });
    await expect(c.connect()).rejects.toThrow(/closed/);
    rude.close();
  });
});

describe("vacation state", () => {
  it("reports the responder off when another script holds the active slot", async () => {
    fake.scripts.set("vacation", 'require ["vacation"];\n# bulwark-vacation: enabled\nvacation :days 1 "x";');
    fake.scripts.set("handmade", "keep;");
    fake.active = "handmade";
    const c = await client();
    expect((await readVacation(c)).isEnabled).toBe(false);
    // Re-enabling through the proxy wires the wrapper and carries the user's
    // script along, untagged: it keeps running without becoming ours.
    await writeVacation(c, { isEnabled: true, textBody: "x" });
    expect(fake.active).toBe(WRAPPER_NAME);
    expect(parseWrapper(fake.scripts.get(WRAPPER_NAME)!)).toEqual(["vacation", "handmade"]);
    expect(ownedScriptsOf(fake.scripts.get(WRAPPER_NAME)!)).toEqual([]);
    expect(await listScriptsView(c)).toEqual([{ name: "vacation", isActive: false }]);
    expect((await readVacation(c)).isEnabled).toBe(true);
    await c.logout();
  });
});

describe("foreign script named like the wrapper", () => {
  it("is renamed out of the way on activation and keeps running, without becoming ours", async () => {
    fake.scripts.set(WRAPPER_NAME, 'require ["fileinto"];\nfileinto "Old";');
    fake.active = WRAPPER_NAME;
    const g = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g.list).toEqual([]);

    await vacationSet({ accountId: "7", update: { singleton: { isEnabled: true, textBody: "away" } } }, ctx);
    expect(fake.scripts.get(WRAPPER_NAME)).toMatch(/^# main: /);
    expect(fake.scripts.get("main-1")).toContain('fileinto "Old"');
    expect(parseWrapper(fake.scripts.get(WRAPPER_NAME)!)).toEqual(["vacation", "main-1"]);
    const after = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(after.list.map((s) => [s.name, s.isActive])).toEqual([["vacation", false]]);
  });
});

describe("existing include-based master script (Roundcube migration)", () => {
  const MASTER = 'require ["include", "fileinto"];\r\n# site defaults\r\nif header :contains "X-Spam-Flag" "YES" { fileinto "Junk"; }\r\ninclude :global "corporate";\r\ninclude :personal "roundcube";\r\n';
  const ROUNDCUBE = 'require ["fileinto"];\r\n# rule:[Lists]\r\nif header :contains "list-id" "x" { fileinto "Lists"; }\r\n';

  beforeEach(() => {
    fake.scripts.set("default", MASTER);
    fake.scripts.set("roundcube", ROUNDCUBE);
    fake.active = "default";
  });

  it("shows neither the master nor the scripts it includes on its own", async () => {
    const g = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g.list).toEqual([]);
  });

  it("adds only a tagged vacation include to the master when the responder is set", async () => {
    await vacationSet({ accountId: "7", update: { singleton: { isEnabled: true, textBody: "away" } } }, ctx);
    expect(fake.active).toBe("default");
    expect(fake.scripts.has(WRAPPER_NAME)).toBe(false);
    const master = fake.scripts.get("default")!;
    expect(master.startsWith(MASTER.trimEnd())).toBe(true);
    expect(master.trimEnd().split("\r\n").pop()).toBe('include :personal :optional "vacation"; # jmap-legacy-proxy');
    expect((await vacationGet({ accountId: "7" }, ctx)).list[0]).toMatchObject({ isEnabled: true });
  });

  it("adds its own script next to the foreign includes, which keep running", async () => {
    const blobId = upload('require ["fileinto"];\nif header :contains "subject" "x" { fileinto "X"; }');
    const r = await sieveScriptSet({ accountId: "7", create: { s: { name: "filters", blobId } }, onSuccessActivateScript: "#s" }, ctx);
    expect(r.notCreated).toBeNull();
    const master = fake.scripts.get("default")!;
    expect(master.startsWith(MASTER.trimEnd())).toBe(true);
    expect(master).toContain('include :personal "roundcube";\r\n');
    expect(master).toContain('include :personal :optional "vacation"; # jmap-legacy-proxy');
    expect(master).toContain('include :personal "filters"; # jmap-legacy-proxy');
    expect(master).not.toContain("disabled");
    expect(fake.active).toBe("default");
    const g = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g.list.map((x) => [x.name, x.isActive])).toEqual([["filters", true]]);

    // A second owned script: the first is switched off in place, roundcube untouched.
    const r2 = await sieveScriptSet({ accountId: "7", create: { t: { name: "more", blobId: upload("keep;") } }, onSuccessActivateScript: "#t" }, ctx);
    expect(r2.notCreated).toBeNull();
    const two = fake.scripts.get("default")!;
    expect(two).toContain('# jmap-legacy-proxy off: include :personal "filters";');
    expect(two).toContain('include :personal "more"; # jmap-legacy-proxy');
    expect(two).toContain('include :personal "roundcube";\r\n');
    const g2 = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g2.list.map((x) => [x.name, x.isActive]).sort()).toEqual([["filters", false], ["more", true]]);

    // roundcube is out of reach through JMAP even by id, and its name is taken.
    const u = await sieveScriptSet({ accountId: "7", update: { [scriptId("roundcube")]: { blobId: upload("keep;") } } }, ctx);
    expect(u.notUpdated?.[scriptId("roundcube")]).toMatchObject({ type: "notFound" });
    expect(fake.scripts.get("roundcube")).toBe(ROUNDCUBE);
    const dup = await sieveScriptSet({ accountId: "7", create: { d: { name: "roundcube", blobId: upload("keep;") } } }, ctx);
    expect(dup.notCreated?.d).toMatchObject({ type: "alreadyExists" });
    expect(fake.scripts.get("roundcube")).toBe(ROUNDCUBE);
  });

  it("renames an owned script and follows it in the master", async () => {
    await sieveScriptSet({ accountId: "7", create: { s: { name: "filters", blobId: upload("keep;") } }, onSuccessActivateScript: "#s" }, ctx);
    const r = await sieveScriptSet({ accountId: "7", update: { [scriptId("filters")]: { name: "rules" } } }, ctx);
    expect(r.notUpdated).toBeNull();
    const master = fake.scripts.get("default")!;
    expect(master).toContain('include :personal "rules"; # jmap-legacy-proxy');
    expect(master).not.toContain('"filters"');
    expect(fake.scripts.has("rules")).toBe(true);
    const g = await sieveScriptGet({ accountId: "7" }, ctx);
    expect(g.list.map((x) => [x.name, x.isActive])).toEqual([["rules", true]]);
  });

  it("refuses to update, destroy or overwrite the master through JMAP", async () => {
    const d = await sieveScriptSet({ accountId: "7", destroy: [scriptId("default")] }, ctx);
    expect(d.notDestroyed?.[scriptId("default")]).toMatchObject({ type: "notFound" });
    expect(fake.scripts.has("default")).toBe(true);
    const c = await sieveScriptSet({ accountId: "7", create: { m: { name: "default", blobId: upload("keep;") } } }, ctx);
    expect(c.notCreated?.m).toMatchObject({ type: "alreadyExists" });
    expect(fake.scripts.get("default")).toBe(MASTER);
  });
});

describe("retargetMaster", () => {
  it("adds a require when the master lacks one, keeps line endings and foreign includes", () => {
    const out = retargetMaster('include :personal "a";\n', "b");
    expect(out).toBe('require ["include"];\ninclude :personal "a";\ninclude :personal :optional "vacation"; # jmap-legacy-proxy\ninclude :personal "b"; # jmap-legacy-proxy\n');
    expect(retargetMaster(out, null)).toBe('require ["include"];\ninclude :personal "a";\ninclude :personal :optional "vacation"; # jmap-legacy-proxy\n# jmap-legacy-proxy off: include :personal "b";\n');
    expect(retargetMaster(retargetMaster(out, null), "b")).toBe(out);
  });

  it("registers and forgets owned scripts without touching the rest", () => {
    const base = 'require ["include"];\ninclude :personal "a";\n';
    const reg = registerInMaster(base, "x");
    expect(reg).toBe(base + '# jmap-legacy-proxy off: include :personal "x";\n');
    expect(registerInMaster(reg, "x")).toBe(reg);
    expect(ownedScriptsOf(reg)).toEqual(["x"]);
    expect(unregisterFromMaster(reg, "x")).toBe(base);
    expect(unregisterFromMaster(retargetMaster(reg, "x"), "x")).toBe('require ["include"];\ninclude :personal "a";\ninclude :personal :optional "vacation"; # jmap-legacy-proxy\n');
  });
});

describe("vacation migration", () => {
  it("renames the legacy bulwark-vacation script and reads its state from the body", async () => {
    fake.scripts.set("bulwark-vacation", 'require ["vacation"];\n# bulwark-vacation: enabled\n# bulwark.subject=' + Buffer.from("Hi").toString("base64") + '\nvacation :days 1 "x";');
    fake.active = "bulwark-vacation";
    const c = await client();
    const v = await readVacation(c);
    expect(v).toMatchObject({ isEnabled: true, subject: "Hi" });
    expect(fake.scripts.has("vacation")).toBe(true);
    expect(fake.scripts.has("bulwark-vacation")).toBe(false);
    // Disabling keeps the wrapper (and thus any user script) active.
    await writeVacation(c, { isEnabled: false, subject: "Hi" });
    expect(fake.active).toBe(WRAPPER_NAME);
    expect((await readVacation(c)).isEnabled).toBe(false);
    await c.logout();
  });
});

describe("masters written before the convention", () => {
  const legacy =
    "# Managed by legacy-proxy: activates the user's scripts via include.\n" +
    'require ["include"];\n' +
    'include :personal "roundcube";\n' +
    'include :personal :optional "vacation"; # legacy-proxy\n' +
    'include :personal "filters"; # legacy-proxy\n' +
    '# legacy-proxy disabled: include :personal "old";\n';

  it("are read as ours, tag and header alike", () => {
    expect(isOurWrapperBody(legacy)).toBe(true);
    expect(parseWrapper(legacy)).toEqual(["roundcube", "vacation", "filters"]);
    expect(ownedScriptsOf(legacy)).toEqual(["filters", "old"]);
  });

  it("come out in the current form once a line changes, foreign lines untouched", () => {
    const out = retargetMaster(legacy, "old");
    expect(out.startsWith("# main: ")).toBe(true);
    expect(out).not.toContain("legacy-proxy:");
    expect(out).not.toContain("# legacy-proxy\n");
    expect(out).toContain('include :personal "roundcube";\n');
    expect(out).toContain('include :personal :optional "vacation"; # jmap-legacy-proxy\n');
    expect(out).toContain('# jmap-legacy-proxy off: include :personal "filters";\n');
    expect(out).toContain('include :personal "old"; # jmap-legacy-proxy\n');
    expect(ownedScriptsOf(out)).toEqual(["old", "filters"]);
  });
});
