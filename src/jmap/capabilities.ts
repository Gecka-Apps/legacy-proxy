import type { AppConfig } from "../util/config.js";
import type { SieveServerCapabilities } from "../sieve/client.js";
import { MAX_SCRIPTS, MAX_SCRIPT_NAME, MAX_SCRIPT_SIZE } from "./methods/sieve.js";

export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
export const VACATION_CAPABILITY = "urn:ietf:params:jmap:vacationresponse";
export const WS_CAPABILITY = "urn:ietf:params:jmap:websocket";
/** Vendor capability that predates the RFC 9661 support; kept for old clients. */
export const SIEVE_CAPABILITY = "urn:bulwark:params:jmap:sieve";
/** JMAP for Sieve Scripts, RFC 9661. */
export const SIEVE_RFC_CAPABILITY = "urn:ietf:params:jmap:sieve";
export const CONTACTS_CAPABILITY = "urn:ietf:params:jmap:contacts";
/** JMAP for Calendars (draft-ietf-jmap-calendars). */
export const CALENDARS_CAPABILITY = "urn:ietf:params:jmap:calendars";

// Every capability the /jmap endpoint accepts in a request's `using` list
// (RFC 8620 §3.6.1). Must cover everything buildSession can advertise —
// contacts was once missing here, so clients that saw it on the session
// object got a 400 unknownCapability back on their first request (issue #3).
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
  VACATION_CAPABILITY,
  SIEVE_CAPABILITY,
  SIEVE_RFC_CAPABILITY,
  CONTACTS_CAPABILITY,
  CALENDARS_CAPABILITY,
]);

export function coreCapabilityProps(cfg: AppConfig) {
  return {
    maxSizeUpload: cfg.limits.maxSizeUpload,
    maxConcurrentUpload: 4,
    maxSizeRequest: cfg.limits.maxSizeRequest,
    maxConcurrentRequests: cfg.limits.maxConcurrentRequests,
    maxCallsInRequest: cfg.limits.maxCallsInRequest,
    maxObjectsInGet: cfg.limits.maxObjectsInGet,
    maxObjectsInSet: cfg.limits.maxObjectsInSet,
    collationAlgorithms: ["i;ascii-numeric", "i;ascii-casemap", "i;unicode-casemap"],
  };
}

export function mailCapabilityProps() {
  return {
    // IMAP messages live in exactly one mailbox; expose the cap as 1 so
    // clients don't try to pin a draft into Inbox + Drafts simultaneously.
    maxMailboxesPerEmail: 1,
    maxMailboxDepth: null,
    maxSizeMailboxName: 490,
    maxSizeAttachmentsPerEmail: 50_000_000,
    // Without IMAP SORT, only UID-order (≈ receivedAt) is cheap. The other
    // properties would require fetching headers for every match before
    // sorting; refuse them up front so clients don't pick something we'll
    // bounce with `unsupportedSort`.
    emailQuerySortOptions: ["receivedAt"],
    mayCreateTopLevelMailbox: true,
  };
}

export function submissionCapabilityProps() {
  return {
    maxDelayedSend: 0,
    submissionExtensions: {},
  };
}

export function contactsCapabilityProps() {
  return {};
}

/** RFC 9661 §1.3 capability object, filled from the ManageSieve greeting. */
export function sieveCapabilityProps(server: SieveServerCapabilities) {
  return {
    implementation: server.implementation ?? "legacy-proxy",
    maxSizeScriptName: MAX_SCRIPT_NAME,
    maxSizeScript: MAX_SCRIPT_SIZE,
    maxNumberScripts: MAX_SCRIPTS,
    maxNumberRedirects: server.maxRedirects,
    sieveExtensions: server.extensions,
    notificationMethods: server.notify.length ? server.notify : null,
    externalLists: null,
  };
}

export function calendarsCapabilityProps() {
  return {
    // Events live in exactly one CalDAV collection.
    maxCalendarsPerEvent: 1,
    minDateTime: "1970-01-01T00:00:00",
    maxDateTime: "2100-01-01T00:00:00",
    maxExpandedQueryDuration: "P1Y",
    maxParticipantsPerEvent: null,
    mayCreateCalendar: true,
  };
}
