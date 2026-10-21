import type { ImapPool } from "../imap/pool.js";
import type { Store, AccountRow } from "../state/store.js";
import type { AppConfig } from "../util/config.js";
import type { PushDispatcher } from "../push/dispatcher.js";
import { JmapError, invalidArguments } from "../jmap/errors.js";
import {
  mailboxGet,
  mailboxQuery,
  mailboxQueryChanges,
  mailboxChanges,
  mailboxSet,
} from "../jmap/methods/mailbox.js";
import {
  emailGet,
  emailQuery,
  emailSet,
  emailChanges,
  emailQueryChanges,
  emailCopy,
  emailParse,
  emailImport,
  searchSnippetGet,
} from "../jmap/methods/email.js";
import { identityGet, identitySet, identityChanges } from "../jmap/methods/identity.js";
import {
  emailSubmissionChanges,
  emailSubmissionGet,
  emailSubmissionQuery,
  emailSubmissionSet,
} from "../jmap/methods/submission.js";
import { vacationGet, vacationSet, vacationChanges } from "../jmap/methods/vacation.js";
import {
  addressBookGet,
  addressBookSet,
  addressBookChanges,
  contactCardGet,
  contactCardQuery,
  contactCardSet,
  contactCardChanges,
  contactCardQueryChanges,
  contactsAvailable,
} from "../jmap/methods/contacts.js";
import {
  calendarChanges,
  calendarEventChanges,
  calendarEventGet,
  calendarEventParse,
  calendarEventQuery,
  calendarEventQueryChanges,
  calendarEventSet,
  calendarGet,
  calendarSet,
  calendarsAvailable,
  participantIdentityGet,
  participantIdentitySet,
} from "../jmap/methods/calendar.js";
import { sieveScriptChanges, sieveScriptGet, sieveScriptSet, sieveScriptValidate } from "../jmap/methods/sieve.js";
import { threadGet, threadChanges } from "../jmap/methods/threads.js";
import { pushSubscriptionGet, pushSubscriptionSet } from "../jmap/methods/push.js";
import { resolveProvider } from "../auth/providers.js";
import { openCredentials } from "../auth/credentials.js";
import type { MethodTable } from "../jmap/router.js";

export interface LegacyContext {
  cfg: AppConfig;
  pool: ImapPool;
  store: Store;
  account: AccountRow;
  dispatcher: PushDispatcher;
}

type Handler = (args: Record<string, unknown>, ctx: LegacyContext) => Promise<unknown>;

function makeMethodTable(): Record<string, Handler> {
  return {
    "Core/echo": async (a) => a,
    // RFC 8620 §6.3: Blob/copy. The proxy doesn't (yet) cross account
    // boundaries — IMAP namespaces don't share — so we surface that limitation
    // as the spec-defined error. Same-account copies are also forbidden by
    // §6.3 and must return invalidArguments.
    "Blob/copy": async (a) => {
      const args = a as { fromAccountId?: string; accountId?: string };
      if (!args.fromAccountId || !args.accountId) {
        throw invalidArguments("fromAccountId and accountId are required");
      }
      if (args.fromAccountId === args.accountId) {
        throw invalidArguments("fromAccountId must differ from accountId");
      }
      throw new JmapError(
        "fromAccountNotFound",
        "cross-account Blob/copy is not supported by the IMAP backend",
      );
    },
    // Stubs for capabilities we don't advertise but the UI may probe anyway.
    // Returning an empty result is more graceful than `unknownMethod`, which
    // some clients treat as a fatal protocol error.
    "Quota/get": async (a) => ({
      accountId: (a as { accountId?: string }).accountId ?? "",
      state: "0",
      list: [],
      notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
    }),
    "AddressBook/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          state: "0",
          list: [],
          notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookGet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "AddressBook/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookSet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "AddressBook/changes": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookChanges(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "ContactCard/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          state: "0",
          list: [],
          notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardGet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "ContactCard/query": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          queryState: "0",
          canCalculateChanges: false,
          position: 0,
          total: 0,
          ids: [],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardQuery(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "ContactCard/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardSet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "ContactCard/changes": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardChanges(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "ContactCard/queryChanges": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardQueryChanges(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "Mailbox/get": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxGet(a as never, { account: c.account, client, store: c.store }),
      ),
    "Mailbox/query": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxQuery(a as never, { account: c.account, client, store: c.store }),
      ),
    "Mailbox/queryChanges": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxQueryChanges(a as never, { account: c.account, client, store: c.store }),
      ),
    "Mailbox/changes": async (a, c) =>
      mailboxChanges(a as never, { account: c.account, store: c.store }),
    "Mailbox/set": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        mailboxSet(a as never, { account: c.account, client, store: c.store }),
      ),
    "Email/query": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailQuery(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "Email/get": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailGet(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "Email/set": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailSet(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "Email/changes": async (a, c) =>
      emailChanges(a as never, { account: c.account, store: c.store }),
    "Email/queryChanges": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailQueryChanges(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "Email/copy": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailCopy(a as never, { account: c.account, client, store: c.store }),
      ),
    "Email/import": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailImport(a as never, { account: c.account, client, store: c.store }),
      ),
    "Email/parse": async (a, c) =>
      emailParse(a as never, { account: c.account, store: c.store }),
    "SearchSnippet/get": async (a, c) =>
      searchSnippetGet(a as never, { account: c.account }),
    "Thread/get": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        threadGet(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "Thread/changes": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        threadChanges(a as never, { account: c.account, client, store: c.store, pool: c.pool }),
      ),
    "PushSubscription/get": async (a, c) =>
      pushSubscriptionGet(a as never, { account: c.account, store: c.store, dispatcher: c.dispatcher }),
    "PushSubscription/set": async (a, c) =>
      pushSubscriptionSet(a as never, { account: c.account, store: c.store, dispatcher: c.dispatcher }),
    "EmailSubmission/get": async (a, c) =>
      emailSubmissionGet(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/query": async (a, c) =>
      emailSubmissionQuery(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/changes": async (a, c) =>
      emailSubmissionChanges(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/set": async (a, c) =>
      c.pool.withConnection(c.account, "interactive", (client) =>
        emailSubmissionSet(a as never, {
          cfg: c.cfg,
          account: c.account,
          client,
          store: c.store,
        }),
      ),
    "Identity/get": async (a, c) =>
      identityGet(a as never, { account: c.account, store: c.store }),
    "Identity/set": async (a, c) =>
      identitySet(a as never, { account: c.account, store: c.store }),
    "Identity/changes": async (a, c) =>
      identityChanges(a as never, { account: c.account, store: c.store }),
    "VacationResponse/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationGet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "VacationResponse/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationSet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "VacationResponse/changes": async (a, c) =>
      vacationChanges(a as never, { account: c.account, store: c.store }),
    "SieveScript/get": async (a, c) => sieveScriptGet(a as never, await sieveCtx(c)),
    "SieveScript/set": async (a, c) => sieveScriptSet(a as never, await sieveCtx(c)),
    "SieveScript/validate": async (a, c) => sieveScriptValidate(a as never, await sieveCtx(c)),
    "SieveScript/changes": async (a, c) => sieveScriptChanges(a as never, { account: c.account, store: c.store }),
    "Calendar/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!calendarsAvailable(provider)) return emptyGet(a, c);
      return calendarGet(a as never, await calendarCtx(c, provider));
    },
    "Calendar/set": async (a, c) => calendarSet(a as never, await calendarCtx(c)),
    "Calendar/changes": async (a, c) => calendarChanges(a as never, await calendarCtx(c)),
    "CalendarEvent/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!calendarsAvailable(provider)) return emptyGet(a, c);
      return calendarEventGet(a as never, await calendarCtx(c, provider));
    },
    "CalendarEvent/query": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!calendarsAvailable(provider)) return emptyQuery(a, c);
      return calendarEventQuery(a as never, await calendarCtx(c, provider));
    },
    "CalendarEvent/set": async (a, c) => calendarEventSet(a as never, await calendarCtx(c)),
    "CalendarEvent/changes": async (a, c) => calendarEventChanges(a as never, await calendarCtx(c)),
    "CalendarEvent/queryChanges": async (a, c) => calendarEventQueryChanges(a as never, await calendarCtx(c)),
    "CalendarEvent/parse": async (a, c) => calendarEventParse(a as never, await calendarCtx(c)),
    "ParticipantIdentity/get": async (a, c) => participantIdentityGet(a as never, { account: c.account, store: c.store }),
    "ParticipantIdentity/set": async (a, c) => participantIdentitySet(a as never, { account: c.account, store: c.store }),
    // Scheduling inbox notifications need server-side iTIP processing, which
    // a CalDAV store without scheduling support (Radicale) cannot provide.
    // Empty answers let a client that always asks (Bulwark) carry on.
    "CalendarEventNotification/get": async (a, c) => emptyGet(a, c),
    "CalendarEventNotification/query": async (a, c) => emptyQuery(a, c),
    "CalendarEventNotification/set": async (a, c) => ({
      accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
      oldState: "0",
      newState: "0",
      created: null,
      updated: null,
      destroyed: ((a as { destroy?: string[] | null }).destroy ?? []) as string[],
      notCreated: null,
      notUpdated: null,
      notDestroyed: null,
    }),
  };
}

function emptyGet(a: Record<string, unknown>, c: LegacyContext) {
  return {
    accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
    state: "0",
    list: [],
    notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
  };
}

function emptyQuery(a: Record<string, unknown>, c: LegacyContext) {
  return {
    accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
    queryState: "0",
    canCalculateChanges: false,
    position: 0,
    total: 0,
    ids: [],
  };
}

async function sieveCtx(c: LegacyContext) {
  const provider = resolveProvider(c.cfg, c.account.kind);
  const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
  return { account: c.account, provider, creds, store: c.store };
}

async function calendarCtx(c: LegacyContext, provider = resolveProvider(c.cfg, c.account.kind)) {
  const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
  return { account: c.account, provider, creds, store: c.store, pool: c.pool };
}

const TABLE = makeMethodTable();

/** Bind the legacy transports to the authenticated account for one request. */
export function makeLegacyMethods(ctx: LegacyContext): MethodTable {
  return Object.fromEntries(
    Object.entries(TABLE).map(([name, handler]) => [name, (args: Record<string, unknown>) => handler(args, ctx)]),
  );
}
