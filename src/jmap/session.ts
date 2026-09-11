import type { AppConfig, ProviderConfig } from "../util/config.js";
import {
  CALENDARS_CAPABILITY,
  CONTACTS_CAPABILITY,
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SIEVE_CAPABILITY,
  SIEVE_RFC_CAPABILITY,
  SUBMISSION_CAPABILITY,
  VACATION_CAPABILITY,
  calendarsCapabilityProps,
  contactsCapabilityProps,
  coreCapabilityProps,
  mailCapabilityProps,
  sieveCapabilityProps,
  submissionCapabilityProps,
} from "./capabilities.js";
import type { AccountRow } from "../state/store.js";
import type { SieveServerCapabilities } from "../sieve/client.js";
import { FALLBACK_SIEVE_CAPABILITIES } from "../sieve/capabilities.js";

export interface SessionExtras {
  /** What the ManageSieve server announced; drives the RFC 9661 capability. */
  sieve?: SieveServerCapabilities;
}

export function buildSession(cfg: AppConfig, account: AccountRow, provider?: ProviderConfig, extras: SessionExtras = {}) {
  const accountId = String(account.id);
  const hasContacts = provider?.carddav != null;
  const hasCalendars = provider?.caldav != null;
  const hasSieve = provider?.sieve != null;

  const accountCaps: Record<string, unknown> = {
    [MAIL_CAPABILITY]: mailCapabilityProps(),
    [SUBMISSION_CAPABILITY]: submissionCapabilityProps(),
    [VACATION_CAPABILITY]: {},
    [SIEVE_CAPABILITY]: {},
  };
  if (hasContacts) accountCaps[CONTACTS_CAPABILITY] = contactsCapabilityProps();
  if (hasCalendars) accountCaps[CALENDARS_CAPABILITY] = calendarsCapabilityProps();
  if (hasSieve) accountCaps[SIEVE_RFC_CAPABILITY] = sieveCapabilityProps(extras.sieve ?? FALLBACK_SIEVE_CAPABILITIES);

  const primaryAccounts: Record<string, string> = {
    [MAIL_CAPABILITY]: accountId,
    [SUBMISSION_CAPABILITY]: accountId,
    [VACATION_CAPABILITY]: accountId,
    [SIEVE_CAPABILITY]: accountId,
  };
  if (hasContacts) primaryAccounts[CONTACTS_CAPABILITY] = accountId;
  if (hasCalendars) primaryAccounts[CALENDARS_CAPABILITY] = accountId;
  if (hasSieve) primaryAccounts[SIEVE_RFC_CAPABILITY] = accountId;

  // WebSocket capability is held back until we register a /jmap/ws handler.
  // EventSource is fully wired (RFC 8620 §7.3): clients open the
  // `eventSourceUrl` and receive `state` events whenever any account-level
  // counter bumps. PushSubscription/* (§7.2) covers the offline path.
  const capabilities: Record<string, unknown> = {
    [CORE_CAPABILITY]: coreCapabilityProps(cfg),
    [MAIL_CAPABILITY]: mailCapabilityProps(),
    [SUBMISSION_CAPABILITY]: submissionCapabilityProps(),
    [VACATION_CAPABILITY]: {},
    [SIEVE_CAPABILITY]: {},
  };
  if (hasContacts) capabilities[CONTACTS_CAPABILITY] = contactsCapabilityProps();
  if (hasCalendars) capabilities[CALENDARS_CAPABILITY] = calendarsCapabilityProps();
  if (hasSieve) capabilities[SIEVE_RFC_CAPABILITY] = accountCaps[SIEVE_RFC_CAPABILITY];

  return {
    capabilities,
    accounts: {
      [accountId]: {
        name: account.username,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: accountCaps,
      },
    },
    primaryAccounts,
    username: account.username,
    apiUrl: `${cfg.publicUrl}/jmap`,
    downloadUrl: `${cfg.publicUrl}/jmap/download/{accountId}/{blobId}/{type}/{name}`,
    uploadUrl: `${cfg.publicUrl}/jmap/upload/{accountId}`,
    eventSourceUrl: `${cfg.publicUrl}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: `s${account.id}`,
  };
}
