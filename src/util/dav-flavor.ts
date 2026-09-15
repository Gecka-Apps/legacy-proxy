import type { DavFlavor } from "./config.js";

/**
 * Path segment of the address book and calendar a server sets up for a new
 * account, which the proxy treats as the default collection while the
 * account has not chosen one. `generic` matches what the proxy creates
 * itself on an empty account.
 */
export const DEFAULT_COLLECTION: Record<DavFlavor, { addressBook: string; calendar: string }> = {
  generic: { addressBook: "contacts", calendar: "calendar" },
  radicale: { addressBook: "contacts", calendar: "calendar" },
  nextcloud: { addressBook: "contacts", calendar: "personal" },
  stalwart: { addressBook: "default", calendar: "default" },
};

export function davFlavor(block: { flavor?: DavFlavor } | null | undefined): DavFlavor {
  return block?.flavor ?? "generic";
}
