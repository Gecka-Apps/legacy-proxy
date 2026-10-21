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

/**
 * Servers that deliver iTIP messages themselves when an organizer or an
 * attendee writes a scheduling object (RFC 6638 implicit scheduling). For
 * those the proxy sends no iMIP of its own and marks a write the client
 * wants silent with `Schedule-Reply: F`, which sabre/dav (Nextcloud) honours
 * on PUT and DELETE and Stalwart on DELETE only.
 */
export const SERVER_SCHEDULING: Record<DavFlavor, boolean> = {
  generic: false,
  radicale: false,
  nextcloud: true,
  stalwart: true,
};
