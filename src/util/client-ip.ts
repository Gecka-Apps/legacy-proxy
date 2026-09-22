import type { IncomingHttpHeaders } from "node:http";
import proxyaddr from "@fastify/proxy-addr";

const DEFAULT_HEADER = "x-forwarded-for";

/**
 * Resolves the address of the client behind a reverse proxy. Takes the peer of
 * the TCP connection and the request headers, and returns the peer itself when
 * no forwarding header may be believed.
 */
export type ClientIpResolver = (
  socketAddress: string | undefined,
  headers: IncomingHttpHeaders,
) => string | undefined;

/**
 * Builds a resolver from a trusted-proxy list and a header name.
 *
 * `trustedProxies` accepts addresses, CIDR blocks and the `loopback`,
 * `linklocal` and `uniquelocal` keywords, comma separated. An empty list trusts
 * nothing and the header is never read: a header alone must not let a caller
 * choose the address it is logged and rate limited under.
 *
 * `header` names the header to read. It may carry a single address (X-Real-IP)
 * or a chain (X-Forwarded-For). The chain is walked from the right, trusted
 * proxies are skipped, and the first remaining entry is the client: a proxy
 * appends what it observed, so everything further left is the caller's own
 * claim.
 */
export function createClientIpResolver(
  trustedProxies: string | undefined,
  header: string | undefined,
): ClientIpResolver {
  const list = splitList(trustedProxies);
  const headerName = (header?.trim() || DEFAULT_HEADER).toLowerCase();
  if (list.length === 0) return (socketAddress) => socketAddress;

  const trusted = proxyaddr.compile(list);
  return (socketAddress, headers) => {
    if (!socketAddress || !trusted(socketAddress, 0)) return socketAddress;
    const raw = headers[headerName];
    const chain = splitList(Array.isArray(raw) ? raw.join(",") : raw);
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i];
      if (entry && !trusted(entry, chain.length - i)) return entry;
    }
    return socketAddress;
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Resolver of the running process, read once from the environment. */
export const clientIp = createClientIpResolver(
  process.env.TRUSTED_PROXIES,
  process.env.CLIENT_IP_HEADER,
);
