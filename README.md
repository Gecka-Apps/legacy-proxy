# legacy-proxy

> Pre-1.0. The wire shapes, storage formats, and config keys can change without
> notice. There is no third-party security audit. Run it for development,
> testing, and self-hosted experiments.

## About

`legacy-proxy` is a translation layer that puts a JMAP server in front of a
classic IMAP / SMTP / ManageSieve / CardDAV / CalDAV stack. It speaks
RFC 8620 + RFC 8621 (mail), RFC 9610 (contacts), RFC 9661 (Sieve scripts)
and draft-ietf-jmap-calendars to clients, and standard mailbox protocols to
whatever server already holds the user's mail. No new mail store, no migration: the
mail keeps living in the existing IMAP server, and a modern JMAP client
sees the account as if it were native.

The motivation is simple. JMAP is a much better fit for modern clients than
IMAP. It batches operations into a single HTTP round-trip, ships diffs
through `*/changes` instead of forcing clients to walk every UID, pushes
state notifications over `EventSource` and Web Push, and exposes contacts
and vacation responders as first-class objects instead of out-of-band Sieve
scripts and CardDAV trees the user has to discover. But almost nobody
operates a JMAP backend. Gmail, Fastmail aside, most hosting providers, ISPs,
and self-hosted setups still ship IMAP only. This proxy lets a JMAP client
target any of them without the operator having to swap their mail server.

What that means concretely:

- A JMAP client (Bulwark webmail, JMAP-enabled mobile apps, custom tooling)
  authenticates against this proxy. The proxy holds an IMAP connection
  open to the real mail server and translates each JMAP method into the
  equivalent IMAP / SMTP / ManageSieve / CardDAV operation.
- State changes get fanned out through both Server-Sent Events and the
  RFC 8620 §7.2 push subscription mechanism. A dedicated IDLE socket per
  active account turns IMAP `EXISTS` / `EXPUNGE` / `FETCH FLAGS`
  notifications into JMAP `EmailDelivery` / `Email` / `Mailbox` state bumps
  in real time.
- Credentials are sealed into an AES-256-GCM vault stored in SQLite, so the
  proxy can keep working with the upstream server across restarts without
  asking the user to log in again.
- Auth on the front accepts either a Bearer token minted by the proxy's
  `/api/login` endpoint or plain HTTP Basic, which is enough to run the
  upstream JMAP compliance suite straight against it.

It is built primarily for [Bulwark Mail](https://bulwarkmail.com)'s webmail,
but the proxy is independent of any one client: anything that speaks
RFC 8621 should work, and the test suite exercises it with the official
`jmapio/jmap-test-suite`.

## What works

JMAP method coverage:

| Type              | Methods                                                              |
| ----------------- | -------------------------------------------------------------------- |
| Core              | `Core/echo`, `Blob/copy` (rejects with `fromAccountNotFound`)        |
| Mailbox           | `get`, `query`, `queryChanges`, `changes`, `set`                     |
| Email             | `get`, `query`, `queryChanges`, `changes`, `set`, `copy`, `import`, `parse` |
| SearchSnippet     | `get` (returns null snippets; IMAP exposes no match offsets)         |
| Thread            | `get`, `changes` (persistent header index in SQLite, updated incrementally per folder) |
| Identity          | `get`, `set`, `changes`                                              |
| EmailSubmission   | `get`, `query`, `changes`, `set` (with `onSuccessUpdateEmail` / `onSuccessDestroyEmail`) |
| VacationResponse  | `get`, `set`, `changes` (full body + dates round-tripped through Sieve)  |
| PushSubscription  | `get`, `set` (verification handshake, relay forwarding, expiry caps) |
| AddressBook       | `get`, `changes`, `set` (extended MKCOL / PROPPATCH / DELETE via CardDAV) |
| ContactCard       | `get`, `query`, `queryChanges`, `changes`, `set` (PUT / DELETE via CardDAV) |
| SieveScript       | `get`, `set` (incl. `onSuccessActivateScript`), `validate`, `changes` via ManageSieve |
| Calendar          | `get`, `changes`, `set` (MKCALENDAR / PROPPATCH / DELETE via CalDAV)  |
| CalendarEvent     | `get`, `query` (time-range REPORT), `queryChanges`, `changes`, `set`, `parse` |
| ParticipantIdentity | `get`, `set` (single identity derived from the login)              |
| CalendarEventNotification | `get`, `query`, `set` (stubs returning empty lists)           |
| Quota             | `get` (stub returning empty list, so probing clients don't error)    |

Capabilities advertised on the Session resource:

- `urn:ietf:params:jmap:core`
- `urn:ietf:params:jmap:mail`
- `urn:ietf:params:jmap:submission`
- `urn:ietf:params:jmap:vacationresponse`
- `urn:ietf:params:jmap:contacts` (only when the active provider has CardDAV)
- `urn:ietf:params:jmap:calendars` (only when the active provider has CalDAV)
- `urn:ietf:params:jmap:sieve` (only when the active provider has ManageSieve;
  the capability object lists the extensions the server announced)
- `urn:bulwark:params:jmap:sieve` (vendor capability used by the vacation handler)

Transport:

- `POST /jmap`, `GET /jmap/session`, `/.well-known/jmap` redirect.
- `GET /jmap/download/{accountId}/{blobId}/{type}/{name}` for both
  IMAP-backed message blobs and previously-uploaded blobs.
- `POST /jmap/upload/{accountId}` with a 24h retention sweep.
- `/dav/cal/{username}/…` and `/dav/card/{username}/…`: authenticated
  pass-through to the CalDAV / CardDAV home set, mirroring Stalwart's paths so
  the Bulwark webmail's own WebDAV proxy (used for `MKCALENDAR` with a
  component set) works unchanged.
- `GET /jmap/eventsource` (RFC 8620 §7.3). Real `state` events on every counter
  bump, with `types`, `closeafter`, and `ping` query params.
- `PushSubscription/set` runs a one-shot `PushVerification` POST against the
  subscriber URL; once verified, every state change is forwarded as a
  `StateChange` POST. 404 / 410 responses retire the subscription; 8
  consecutive non-2xx responses also retire it.
- IMAP IDLE: the proxy keeps a dedicated IMAP socket per account that has at
  least one verified push subscription, watching INBOX. New arrivals bump
  `EmailDelivery` (and `Email`, `Mailbox`); other-device flag changes bump
  `Email`; expunges bump `Email` and `Mailbox`.

Backends:

- IMAP via [imapflow](https://github.com/postalsys/imapflow), one connection
  per account in a request-path pool (separate from the IDLE socket).
- ManageSieve (RFC 5804) for the vacation autoresponder and for RFC 9661
  `SieveScript/*`. ManageSieve servers run one active script, while JMAP for
  Sieve (and the Bulwark filter editor) expect a server-managed `vacation`
  script to run alongside the user's active script. With the `include`
  extension the proxy bridges that through a *master* script, which is also
  the registry of the scripts the proxy owns: the lines it writes there end
  with `# legacy-proxy` (`include :personal :optional "vacation";` and the
  include of the active owned script), an owned script switched off stays
  registered as `# legacy-proxy disabled: include :personal "…";`, and
  nothing else in the master is ever edited. JMAP clients see only the
  scripts registered that way, so a script another webmail manages
  (Roundcube's, RainLoop's, a hand-written one) is neither listed nor
  reachable and keeps running from its own include; its name is still taken.
  When the active script is already such a master (a hand-written `default`
  that includes `roundcube`, say) it is adopted as is; when a plain script is
  active, the proxy writes its own master, named `bulwark`, and carries that
  script along untagged. The master is hidden from clients either way.
  Without `include` it falls back to plain `SETACTIVE`: every script is then
  in reach, and activating a filter script silences the autoresponder and
  vice versa.
- SMTP Submission via nodemailer.
- CardDAV (RFC 6352) for AddressBook and ContactCard. Reads are live
  PROPFIND / `addressbook-multiget`; writes are `PUT` with `If-None-Match: *`
  (create) or `If-Match` (update), `DELETE`, extended `MKCOL` (RFC 5689) and
  `PROPPATCH`. Cards are re-serialised as vCard 4.0 on update; properties the
  JSContact projection doesn't model (PHOTO, IMPP, X-*, …) are carried over
  untouched.
  A CardDAV account with no collections at all (a fresh Radicale user, for
  example) gets a `Contacts` address book created on the first
  `ContactCard/set`.
- CalDAV (RFC 4791) for Calendar and CalendarEvent. Calendars are the
  collections under `calendar-home-set`; events are `.ics` resources, one
  UID per resource, translated to and from JSCalendar (RFC 8984) with
  [ical.js](https://github.com/kewisch/ical.js). Recurrence rules, EXDATE /
  RDATE and RECURRENCE-ID overrides map to `recurrenceRules` /
  `recurrenceOverrides`; ATTENDEE / ORGANIZER to `participants`; VALARM to
  `alerts`. Time-range queries are `calendar-query` REPORTs, so the server
  does the recurrence-aware overlap test and the client expands occurrences
  (`expandRecurrences` is not implemented). Every TZID a resource references
  gets a synthesised VTIMEZONE. Calendar properties CalDAV cannot hold
  (`isVisible`, `sortOrder`, default alerts, …) live in the proxy's SQLite
  database. An account with no calendar gets a `Calendar` collection created
  on the first `CalendarEvent/set`.
- iMIP (RFC 6047) over the SMTP submission backend when a client sets
  `sendSchedulingMessages: true` on `CalendarEvent/set`: as organizer,
  `REQUEST` to the attendees on create / update and `CANCEL` to dropped
  attendees and on destroy; as attendee, `REPLY` to the organizer when the
  user's own `participationStatus` changes. Participants with
  `scheduleAgent: "client"` / `"none"` are skipped. A mail failure is logged
  and never fails the calendar write.

Auth and storage:

- IMAP-side mechanisms: `PLAIN`, `LOGIN`, `XOAUTH2`. Bring-your-own-token works
  for OAuth providers.
- HTTP-side: `Authorization: Bearer <token>` (HMAC-SHA-256 session tokens) and
  `Authorization: Basic ...` (probed against IMAP, then cached for 5 min).
- Credentials sealed with AES-256-GCM and stored in SQLite.
- State, mailboxes, identities, vacation cache, push subscriptions, and the
  upload table all live in a single better-sqlite3 database under `DATA_DIR`.

Sort and filter:

- Server advertises `emailQuerySortOptions: ["receivedAt"]`. A pure
  `receivedAt` sort (what clients send by default) is answered from UID order
  with no per-message FETCH. The handler also accepts `size`, `from`, `to`,
  `subject`, `sentAt`, and `hasKeyword` (those pay a per-match FETCH).
- `hasAttachment` filter is rejected: IMAP without a server-side flag for it
  cannot answer cheaply.
- `*/changes` and `Email/queryChanges` use a real change log seeded by
  IDLE / `Email/set` / `Mailbox/set`, so a client with a recent `sinceState`
  gets a precise diff. When the log has rotated past the requested state, the
  proxy returns `cannotCalculateChanges`.

## Not implemented

- Scheduling beyond iMIP: `Principal/*`, free/busy and the scheduling inbox
  are not exposed. Incoming iMIP mail is not applied to the calendar
  automatically; the client parses it (`CalendarEvent/parse`) and saves it.
- `CalendarEvent/query` `expandRecurrences`. The client is expected to expand
  recurring events itself; the probe Bulwark uses to detect server-side
  expansion is answered with `invalidProperties` so it keeps doing so.
- Sieve scripts can only be activated one at a time on top of `vacation`;
  the master script handling covers exactly that pair. Scripts the proxy did
  not create are invisible to JMAP by design; an expert user edits them from
  the tool that owns them.

- WebSocket transport (`@fastify/websocket` is in the deps tree but no `/jmap/ws`
  handler is registered, so the capability is not advertised).
- CardDAV cards live in exactly one collection, so `ContactCard/set` rejects
  `addressBookIds` changes (moving a card between books) with
  `invalidProperties`. `AddressBook/set` only persists `name` and
  `description`; `isDefault`, `sortOrder`, `isSubscribed` and `color` have no
  CardDAV equivalent and are accepted but ignored. No sharing (`shareWith`).
- The JSContact ⇄ vCard translation covers name, nicknames, emails, phones,
  organisations, titles, addresses, notes, links, anniversaries, kind and
  group members. Other JSContact properties sent on create (media,
  onlineServices, …) are dropped; on update the corresponding vCard lines
  are preserved as-is.
- Multi-mailbox membership: an Email lives in exactly one IMAP folder. JMAP
  operations that try to add or remove a mailbox membership treat the move as
  a copy + expunge, which produces a new id rather than preserving the old
  one. The compliance allowlist documents the affected upstream tests.
- `Thread/changes` for the case where the last email of a thread is destroyed
  (the index has no live thread to look up; allow-listed).
- Cross-account `Blob/copy` (no shared blob namespace between IMAP accounts).
- Web Push payload encryption (`keys` on PushSubscription is accepted but
  ignored; the Bulwark relay re-encrypts with its own VAPID key).

## Quickstart

You need Docker.

### Pull the published image

```bash
mkdir legacy-proxy && cd legacy-proxy

cat > .env <<EOF
VAULT_KEY=$(openssl rand -base64 32)
SESSION_HMAC_KEY=$(openssl rand -base64 32)
EOF
chmod 600 .env

curl -fsSLo providers.json   https://raw.githubusercontent.com/bulwarkmail/legacy-proxy/main/providers.example.json
curl -fsSLo compose.prod.yml https://raw.githubusercontent.com/bulwarkmail/legacy-proxy/main/compose.prod.yml

$EDITOR providers.json   # point the `generic` entry at your IMAP/SMTP/Sieve/CardDAV hosts

docker compose -f compose.prod.yml up -d
```

`curl http://localhost:8080/healthz` returns `{"ok":true}` once the server is
up. Clients connect via `http://localhost:8080/.well-known/jmap`.

### Build from source

```bash
git clone https://github.com/bulwarkmail/legacy-proxy.git
cd legacy-proxy
npm run setup
docker compose up -d
```

`npm run setup` writes `.env` with fresh keys and copies `providers.example.json`
to `providers.json`. It refuses to clobber existing files; pass `-- --force`
to overwrite both.

For local development without Docker:

```bash
npm install
npm run setup
npm run dev          # tsx watch, reads .env automatically
```

## Logging in

Two flows are supported.

### Trade IMAP credentials for a Bearer token

```bash
curl -s http://localhost:8080/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"you@example.com","password":"...","provider":"generic"}'
```

The response carries `{ token, accountId, apiUrl }`. Use the token as
`Authorization: Bearer <token>` on subsequent JMAP requests. The login endpoint
opens a probe IMAP session with the supplied credentials, seals them into the
vault, and only mints a token if IMAP accepts.

`provider` is the key into `providers.json`. When omitted, the proxy picks it
from the email domain of `username` (see [Provider selection](#provider-selection)),
falling back to `DEFAULT_PROVIDER`. For OAuth providers, pass `accessToken`
instead of `password` and the proxy will use `XOAUTH2`.

### HTTP Basic

`Authorization: Basic <base64(user:pass)>` works on every JMAP endpoint.
The first request in a 5 minute window costs one IMAP probe; subsequent
requests reuse the cached account. Useful for compliance suite runs and
servers that already terminate auth at a reverse proxy.

Basic auth carries no explicit provider, so the proxy selects one from the
email domain of the username (see [Provider selection](#provider-selection)).
This is what lets a JMAP client like the Bulwark webmail front several IMAP
backends through one proxy without any client-side change: the user just types
their email, and the domain routes them to the right provider.

### Provider selection

Every login resolves to exactly one provider key from `providers.json`, in this
order:

1. an explicit `provider` in the `/api/login` body, if present;
2. the provider whose `domains` list contains the username's email domain
   (case-insensitive). This mirrors RFC 8620 §2.2, which uses the email domain
   as the routing key for service autodiscovery;
3. `DEFAULT_PROVIDER` otherwise.

Give each provider a `domains` array to enable step 2:

```json
{
  "posteo":      { "domains": ["posteo.de", "posteo.net"], "imap": { ... }, ... },
  "mailbox-org": { "domains": ["mailbox.org"],             "imap": { ... }, ... }
}
```

See `providers.two-servers.example.json` for a full two-provider catalogue.
If two backends share one email domain, that domain can only map to a single
provider. Use the explicit `/api/login` `provider` field for the exception.

### Gmail

Gmail wants an [App Password](https://support.google.com/accounts/answer/185833)
(2FA must be on). Use `"provider": "gmail"`. XOAUTH2 also works if you bring
your own access token.

### TLS

The proxy only speaks plain HTTP. Put Caddy, Traefik, or nginx in front of it
and set `PUBLIC_URL` to whatever URL clients see. The Session resource bakes
URLs from `PUBLIC_URL` into `apiUrl`, `downloadUrl`, `uploadUrl`, and
`eventSourceUrl`, so a wrong value silently breaks every client.

## Configuration

| env var                    | default                            | notes                                                |
| -------------------------- | ---------------------------------- | ---------------------------------------------------- |
| `PORT`                     | `8080`                             | HTTP listen port                                     |
| `PUBLIC_URL`               | `http://localhost:$PORT`           | URL clients see; baked into the Session resource     |
| `DATA_DIR`                 | `./data` (or `/data` in Docker)    | SQLite database, vault entries, upload bodies        |
| `VAULT_KEY`                | required                           | base64 of 32 bytes; AES-256-GCM credential vault     |
| `SESSION_HMAC_KEY`         | required                           | base64 of 32 bytes; HMAC-SHA-256 over session tokens |
| `DEFAULT_PROVIDER`         | `generic`                          | provider key when `/api/login` omits one             |
| `PROVIDERS_FILE`           | `/etc/legacy-proxy/providers.json` | provider catalogue                                   |
| `LOG_LEVEL`                | `info`                             | pino level                                           |
| `MAX_CONCURRENT_REQUESTS`  | `10`                               | advertised on `coreCapabilityProps`                  |
| `MAX_OBJECTS_IN_GET`       | `500`                              | advertised on `coreCapabilityProps`                  |
| `MAX_OBJECTS_IN_SET`       | `500`                              | advertised on `coreCapabilityProps`                  |
| `MAX_SIZE_UPLOAD`          | `50_000_000` (50 MB)               | upload endpoint body limit, advertised in caps       |
| `MAX_SIZE_REQUEST`         | `10_000_000` (10 MB)               | JMAP POST body limit, advertised in caps             |
| `MAX_CALLS_IN_REQUEST`     | `64`                               | per-envelope method-call cap                         |
| `JMAP_DEBUG`               | unset                              | set to `1` to log every request/response shape       |

`providers.example.json` ships entries for Gmail and a generic
`$IMAP_HOST` / `$SMTP_HOST` / `$SIEVE_HOST` / `$CARDDAV_HOST` / `$CALDAV_HOST`
template. A `null` (or absent) `sieve`, `carddav` or `caldav` is allowed; the
corresponding capability is then not advertised and the JMAP methods either
return empty results or, for vacation, reject with the underlying ManageSieve
error. `carddav` and `caldav` share the same shape (`host`, `port`, `secure`,
`basePath`, optional `principalPath`) and usually point at the same server —
Radicale, Baïkal, SOGo, Nextcloud, Stalwart… The DAV backend must accept the
user's IMAP credentials: the proxy replays them (Radicale's
`[auth] type = dovecot` or `imap` does exactly that). An optional `domains` array on a provider
opts it into domain-based [provider selection](#provider-selection);
`providers.two-servers.example.json` shows two providers wired up that way.

## Tests

```bash
npm test                  # unit tests (vitest)
npm run test:integration  # vitest, gated by RUN_INTEGRATION=1; requires compose.test.yml
npm run test:compliance   # jmapio/jmap-test-suite against a live proxy
npm run test:all
```

The integration compose stack runs Stalwart locally on non-default ports and
points the proxy at it.

`test:compliance` clones [jmap-test-suite](https://github.com/jmapio/jmap-test-suite)
into `vendor/jmap-test-suite/`, generates a `config.local.json` from
`PROXY_URL` + `JMAP_USER_PRIMARY` / `JMAP_PASS_PRIMARY` (and an optional
secondary user), runs it, then triages the report against
`test/compliance/known-failures.txt`. Anything failing outside the allowlist
is treated as a regression.

## Architecture

```
src/
  server.ts        fastify bootstrap, auth, upload/download/eventsource routes
  jmap/            session, router, capabilities, errors, refs, eventsource hub
    methods/       per-type handlers (mailbox, email, threads, identity,
                   submission, vacation, sieve, contacts, calendar, push)
  imap/            imapflow client/pool, fetcher, search compiler, header parsing
  smtp/            nodemailer submission
  sieve/           ManageSieve client, capability probe, wrapper-script manager,
                   vacation script generator
  carddav/         CardDAV client + vCard / JSContact translation
  caldav/          CalDAV client, iCalendar / JSCalendar translation, Intl-based
                   time-zone arithmetic + VTIMEZONE synthesis, iMIP planner
  push/            PushDispatcher (SSE + relay fan-out), PushIdleManager
  auth/            session tokens, AES-256-GCM credential vault, providers
  mapping/         IMAP <-> JMAP id/blobId codecs, flag map, body structure,
                   MIME builder
  state/           SQLite store, opaque state strings, change log
  util/            config loader, pino log
```

## License

AGPL-3.0
