// Push relay URLs reach only public addresses: checked when a subscription is
// created and again, through DNS, on every delivery.

import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, postPush, publicOnlyLookup, pushUrlProblem } from "../../src/push/target.js";
import { pushSubscriptionSet, type PushCtx } from "../../src/jmap/methods/push.js";
import type { AccountRow, Store } from "../../src/state/store.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.10.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::7f00:1", "fd00::1", "fe80::1",
    "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1", "ff02::1",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "202.22.232.244", "::ffff:8.8.8.8", "2606:4700::1111", "2407:4a00:10:0:764::44"])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("refuses what is not an address", () => {
    expect(isPublicAddress("relay.example")).toBe(false);
  });
});

describe("pushUrlProblem", () => {
  it("accepts a public relay", () => {
    expect(pushUrlProblem("https://notifications.relay.bulwarkmail.org/api/push/jmap/dev")).toBeNull();
    expect(pushUrlProblem("http://relay.example/x")).toBeNull();
    expect(pushUrlProblem("https://[2606:4700::1111]/x")).toBeNull();
  });

  it.each([
    "http://127.0.0.1:8080/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.31.10.1/",
    "http://localhost:6379/",
    "http://valkey.localhost./",
  ])("refuses %s", (url) => {
    expect(pushUrlProblem(url)).toBe("url points at a non-public address");
  });

  it("refuses other schemes, credentials and overlong URLs", () => {
    expect(pushUrlProblem("ftp://relay.example/")).toBe("url must be an http(s) URL");
    expect(pushUrlProblem("file:///etc/passwd")).toBe("url must be an http(s) URL");
    expect(pushUrlProblem("http://relay.example/", { httpsOnly: true })).toBe("url must be an https URL");
    expect(pushUrlProblem("https://u:p@relay.example/")).toBe("url must not carry credentials");
    expect(pushUrlProblem("https://relay.example/" + "y".repeat(2100))).toMatch(/longer than/);
    expect(pushUrlProblem("not a url")).toBe("url is not a URL");
  });
});

describe("publicOnlyLookup", () => {
  const resolving = (...addresses: string[]) =>
    ((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) =>
      cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))) as never;
  const run = (lookup: ReturnType<typeof publicOnlyLookup>, opts: dns.LookupOptions) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
      lookup("relay.example", opts, (err, address, family) => resolve({ err, address, family })),
    );

  it("hands back the addresses it checked", async () => {
    const lookup = publicOnlyLookup(resolving("8.8.8.8", "2606:4700::1111"));
    expect((await run(lookup, { all: true })).address).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
    expect(await run(lookup, {})).toMatchObject({ err: null, address: "8.8.8.8", family: 4 });
    expect(await run(lookup, { family: 6 })).toMatchObject({ err: null, address: "2606:4700::1111", family: 6 });
  });

  it("fails when any address is not public", async () => {
    const { err } = await run(publicOnlyLookup(resolving("8.8.8.8", "10.0.0.5")), { all: true });
    expect(err).toMatchObject({ code: "EPUSHTARGET" });
  });
});

describe("postPush", () => {
  it("never connects to a host that resolves to loopback", async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) =>
      cb(null, [{ address: "127.0.0.1", family: 4 }])) as never);
    try {
      await expect(
        postPush(`http://rebound.example:${port}/x`, { headers: {}, body: "{}", timeoutMs: 2_000 }),
      ).rejects.toMatchObject({ code: "EPUSHTARGET" });
      await expect(
        postPush(`http://127.0.0.1:${port}/x`, { headers: {}, body: "{}", timeoutMs: 2_000 }),
      ).rejects.toMatchObject({ code: "EPUSHTARGET" });
      expect(hits).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("holds the gmail backend to https", async () => {
    await expect(
      postPush("http://relay.example/x", { headers: {}, body: "{}", timeoutMs: 2_000, httpsOnly: true }),
    ).rejects.toThrow("url must be an https URL");
  });
});

describe("PushSubscription/set", () => {
  it("refuses a subscription aimed at an internal address", async () => {
    const insert = vi.fn();
    const store = {
      listPushSubscriptions: () => [],
      insertPushSubscription: insert,
      getState: () => 0,
      bumpState: () => 1,
    } as unknown as Store;
    const ctx = { account: { id: 1 } as AccountRow, store, dispatcher: { sendVerification: vi.fn(async () => {}) } } as unknown as PushCtx;
    const r = await pushSubscriptionSet({ create: { a: { deviceClientId: "d", url: "http://172.31.10.1:8080/", types: null } } }, ctx);
    expect(r.notCreated?.a).toEqual({ type: "invalidProperties", properties: ["url"], description: "url points at a non-public address" });
    expect(insert).not.toHaveBeenCalled();
  });
});
