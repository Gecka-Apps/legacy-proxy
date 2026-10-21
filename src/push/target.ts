// Push relay URLs come from clients, so every POST to one goes over https
// (RFC 8620 §7.2) to a public address only: the URL is checked when a
// subscription is created, and each
// delivery resolves the host, refuses it if any address is not public, and
// connects to exactly the addresses it checked. Redirects are not followed.

import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import https from "node:https";
import net from "node:net";

export const MAX_PUSH_URL = 2048;

// IANA special-purpose ranges. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d)
// match the IPv4 rules.
const NON_PUBLIC = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(prefix, bits, "ipv4");
for (const [prefix, bits] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) NON_PUBLIC.addSubnet(prefix, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Why `raw` cannot be a push target, or null when it can. */
export function pushUrlProblem(raw: string): string | null {
  if (raw.length > MAX_PUSH_URL) return `url longer than ${MAX_PUSH_URL} characters`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url is not a URL";
  }
  if (url.protocol !== "https:") return "url must be an https URL";
  if (url.username || url.password) return "url must not carry credentials";
  const host = bareHost(url);
  if (!host) return "url has no host";
  if (net.isIP(host) !== 0) return isPublicAddress(host) ? null : "url points at a non-public address";
  if (host === "localhost" || host.endsWith(".localhost")) return "url points at a non-public address";
  return null;
}

/** Host name without IPv6 brackets or a trailing dot, lower-cased. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

type Resolve = (host: string, opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `lookup` for http.request that fails unless every address of the host is
 * public, so the socket can only open on an address that passed the check.
 */
export function publicOnlyLookup(resolve: Resolve = dns.lookup as unknown as Resolve) {
  return (
    host: string,
    opts: LookupOptions,
    cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    resolve(host, { all: true }, (err, addresses) => {
      if (err) return cb(err, "");
      const wanted = opts.family === 4 || opts.family === 6 ? addresses.filter((a) => a.family === opts.family) : addresses;
      if (wanted.length === 0) return cb(Object.assign(new Error(`${host}: no address`), { code: "ENOTFOUND" }), "");
      const blocked = addresses.find((a) => !isPublicAddress(a.address));
      if (blocked) {
        return cb(Object.assign(new Error(`${host} resolves to non-public ${blocked.address}`), { code: "EPUSHTARGET" }), "");
      }
      if (opts.all) return cb(null, wanted);
      cb(null, wanted[0]!.address, wanted[0]!.family);
    });
  };
}

/**
 * POST `body` to a push relay. Resolves with the HTTP status; rejects on a
 * refused target, a network error or `timeoutMs`.
 */
export function postPush(
  raw: string,
  opts: { headers: Record<string, string>; body: string; timeoutMs: number },
): Promise<{ status: number }> {
  const problem = pushUrlProblem(raw);
  if (problem) return Promise.reject(Object.assign(new Error(problem), { code: "EPUSHTARGET" }));
  const url = new URL(raw);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: { ...opts.headers, "content-length": String(Buffer.byteLength(opts.body)) },
        lookup: publicOnlyLookup(),
        agent: false,
        signal: AbortSignal.timeout(opts.timeoutMs),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}
