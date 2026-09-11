// What the ManageSieve server can do, for the Session resource. Extensions
// and limits are per server rather than per user, so one probe per provider
// is shared by every account behind it. The probe needs credentials (the
// greeting is only complete after STARTTLS + AUTHENTICATE on some servers),
// so it rides on whichever account asks first.

import type { Credentials } from "../auth/credentials.js";
import type { ProviderConfig } from "../util/config.js";
import { SieveClient, type SieveServerCapabilities } from "./client.js";
import { log } from "../util/log.js";

interface Entry {
  caps: SieveServerCapabilities;
  at: number;
}
const cache = new Map<string, Entry>();
const TTL_MS = 60 * 60_000;

/** Used when the server cannot be reached: advertise a conservative baseline. */
export const FALLBACK_SIEVE_CAPABILITIES: SieveServerCapabilities = {
  implementation: null,
  extensions: ["fileinto", "reject", "envelope", "vacation", "imap4flags", "relational", "comparator-i;ascii-numeric", "regex", "body", "copy", "variables", "include"],
  notify: [],
  maxRedirects: null,
};

export async function probeSieveCapabilities(
  providerName: string,
  provider: ProviderConfig,
  creds: Credentials,
): Promise<SieveServerCapabilities> {
  if (!provider.sieve) return FALLBACK_SIEVE_CAPABILITIES;
  const hit = cache.get(providerName);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.caps;
  const c = new SieveClient({ ...provider.sieve, creds });
  try {
    await c.connect();
    const caps = c.serverCapabilities();
    cache.set(providerName, { caps, at: Date.now() });
    return caps;
  } catch (e) {
    log.warn({ err: (e as Error).message, provider: providerName }, "sieve capability probe failed");
    return FALLBACK_SIEVE_CAPABILITIES;
  } finally {
    await c.logout().catch(() => undefined);
  }
}

export function resetSieveCapabilityCache(): void {
  cache.clear();
}
