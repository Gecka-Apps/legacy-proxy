import { describe, expect, it } from "vitest";
import { createClientIpResolver } from "../../src/util/client-ip.js";

const GATEWAY = "172.31.10.1";

describe("client ip", () => {
  it("keeps the socket address when no proxy is trusted", () => {
    const resolve = createClientIpResolver(undefined, "x-real-ip");
    expect(resolve(GATEWAY, { "x-real-ip": "203.0.113.7" })).toBe(GATEWAY);
  });

  it("reads the configured header from a trusted proxy", () => {
    const resolve = createClientIpResolver(GATEWAY, "x-real-ip");
    expect(resolve(GATEWAY, { "x-real-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("ignores the header from an untrusted peer", () => {
    const resolve = createClientIpResolver(GATEWAY, "x-real-ip");
    expect(resolve("198.51.100.4", { "x-real-ip": "203.0.113.7" })).toBe("198.51.100.4");
  });

  it("takes the rightmost untrusted entry of a forwarded chain", () => {
    const resolve = createClientIpResolver(`${GATEWAY},10.0.0.0/8`, "x-forwarded-for");
    const headers = { "x-forwarded-for": "203.0.113.7, 10.0.0.5" };
    expect(resolve(GATEWAY, headers)).toBe("203.0.113.7");
  });

  it("does not believe a chain the client forged itself", () => {
    const resolve = createClientIpResolver(GATEWAY, "x-forwarded-for");
    // nginx appends what it saw, so the caller's own claim stays to its left.
    const headers = { "x-forwarded-for": "1.2.3.4, 198.51.100.4" };
    expect(resolve(GATEWAY, headers)).toBe("198.51.100.4");
  });

  it("matches a trusted proxy given in IPv4-mapped form", () => {
    const resolve = createClientIpResolver(GATEWAY, "x-real-ip");
    expect(resolve(`::ffff:${GATEWAY}`, { "x-real-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("falls back to the socket when the header is missing or empty", () => {
    const resolve = createClientIpResolver(GATEWAY, "x-real-ip");
    expect(resolve(GATEWAY, {})).toBe(GATEWAY);
    expect(resolve(GATEWAY, { "x-real-ip": "  " })).toBe(GATEWAY);
  });

  it("falls back to the socket when the chain holds trusted proxies only", () => {
    const resolve = createClientIpResolver(GATEWAY, "x-forwarded-for");
    expect(resolve(GATEWAY, { "x-forwarded-for": GATEWAY })).toBe(GATEWAY);
  });

  it("defaults to x-forwarded-for when no header is named", () => {
    const resolve = createClientIpResolver(GATEWAY, undefined);
    expect(resolve(GATEWAY, { "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("accepts the keywords proxy-addr defines", () => {
    const resolve = createClientIpResolver("loopback", "x-real-ip");
    expect(resolve("127.0.0.1", { "x-real-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });
});
