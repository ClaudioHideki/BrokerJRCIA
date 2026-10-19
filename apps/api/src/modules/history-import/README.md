# Private history import

The application now connects the channel panel, administrator-only routes, durable
ledger, a frozen PostgreSQL source and a dedicated historical worker. The source
is optional server configuration; an unconfigured source reports an unavailable
capability and never fabricates an import. Tests use synthetic databases, not a
production WhatsApp session.

The implemented source exports stored individual TEXT messages (conversation and
extendedTextMessage), in both directions. Groups, attachments and messages absent
from the engine cache are outside this source version. This is not certification
of complete phone history or of the rest of the consolidated program.

## Transaction boundary

`start`, `cancel` and `applyPage` use the tenant transaction supplied by the host.
The production host must use the existing direct `jrc_app` transaction helper and
derive the organization and channel from authorized server state. Never accept
source identity or import permissions from the client manifest alone.

`assertCurrentScope` must check the current binding and source revision in that
same transaction. When revocation can race with a commit, its database fence must
remain locked until commit; a remote check or an unlocked read is insufficient.

`persistHistoricalPage` must perform only historical SQL writes through the
transaction it receives. It must not create another transaction, call the provider,
publish messages, schedule bot work, or write a sending outbox. Its imported and
duplicate counts describe actual deduplicated writes. The application connects
the shared `persistQrHistoryPage` writer under the same checkpoint transaction.

The job row lock serializes page commits and cancellation. A page that already
holds the lock may finish before cancellation; subsequent pages are rejected.
Cancellation does not undo historical rows already committed. After a process is
replaced, `get` recovers the durable ordinal and counts. A committed page retry is
idempotent; after snapshot expiration or source revocation it fails closed, and
`get` remains the way to inspect the previously committed checkpoint.

## Database boundary

Migration 0067 adds tenant-scoped jobs and page receipts. Initial jobs start at
ordinal zero. A checkpoint advance requires its matching receipt, while a deferred
receipt constraint requires the checkpoint at transaction commit. The historical
writer, receipt and checkpoint therefore commit or roll back together when used
through this store. The database cannot prove that an arbitrary custom writer
returned truthful counts; the trusted host must supply and verify that writer.

The app role cannot update receipts or delete either ledger table. Channel purge
removes receipts before jobs and existing historical messages. The readiness
probe requires the new relations, RLS, permissions and triggers. A future API
release using this source requires migration 0067; rollback compatibility must be
checked against the actual release pair before deployment.

## Stable source prerequisite

The source must supply the validated immutable v1 manifest and page digests.
Ordinal positions refer to that snapshot, not to an offset in a changing provider
query. Existing Evolution timestamp/offset pagination does not prove snapshot
completeness. The pinned upstream remains immutable. A separate approved JRC
adapter or immutable export is required. The implemented `postgres-source.ts`
uses a REPEATABLE READ / READ ONLY transaction against the assigned Evolution
database, with deterministic timestamp/ID ordering, a verified current owner and
a record budget. It persists immutable pages in the Broker before admitting the
job. The pinned Evolution source and image remain unchanged.

The QR writer resolves LIDs only through confirmed aliases in the current tenant/instance identity scope. It locks instance SHARE before channel NO KEY UPDATE and rejects unresolved identity before any historical write.

## Runtime and operation

`HISTORY_EVOLUTION_DATABASE_URL` selects the legacy engine database with a
dedicated read-only role. `HISTORY_EVOLUTION_DATABASES_JSON` can map fleet engine
IDs to private PostgreSQL URLs, or to private HISTORY_EVOLUTION_* environment
references (those references must also be delivered to the processes by the
deployment). Never put these values into a browser request or repository.

The API and `history-import-worker` receive the source configuration. The worker
uses the same approved API image and its own main-database pool (default 2), plus
at most one source connection per configured engine. `HISTORY_IMPORT_WORKER_INTERVAL_MS`
defaults to 5000; `HISTORY_IMPORT_WORKER_DB_POOL_MAX` defaults to 2. Existing bot
scheduling remains in the separate scheduler process. The worker advances only
already admitted jobs, up to ten per company per scan. It cannot create a job,
activate an automation or send a WhatsApp message.

Every admitted job remembers the authorizing user. Permissions are revalidated
and fenced on each page with the existing `lock_local_attendance_member` function.
Each page receipt retains its actor; an explicitly advancing current administrator
can become the actor for subsequent background work. A failure preserves the
checkpoint, records only a safe error code and backs off for one minute.
Cancellation and viewing remain available to authorized administrators after
disconnect or identity revocation. The panel polls active work every five seconds,
discards late results after tenant/channel changes, and offers cancellation.

Source snapshots expire after 24 hours and are purged by the dedicated worker or
the next snapshot admission for that company. Admission is serialized per company,
limited to twenty active snapshots and a 64 MiB temporary budget; each snapshot
has an additional 15 MB serialized budget and 10,000-record limit. Before loading
provider rows, an aggregate in the same read-only snapshot admits at most 14 MB;
the source admits at most two concurrent exports per API process. These bounds
are not a load-test result. Ordinary stored messages and their receipts remain
subject to their existing retention policy. Page reads select only the requested
page, not the entire frozen payload.

## Read-only source role for a future deployment

In the Evolution database, an administrator must provision a dedicated LOGIN role,
set its password interactively outside Git, grant CONNECT/USAGE and only these
column privileges (plus any existing server connection policy):

```sql
GRANT SELECT (id, name, "ownerJid", "connectionStatus") ON "Instance" TO jrc_history_reader;
GRANT SELECT (id, "instanceId", key, "messageTimestamp", message, "pushName", status) ON "Message" TO jrc_history_reader;
ALTER ROLE jrc_history_reader SET default_transaction_read_only = on;
```

Do not grant writes, schema creation, engine tokens, session tables or Baileys auth
state. Use one matching read-only credential per engine database. Configuring a
source does not approve a job or activate a bot: an authorized administrator still
chooses a range and starts an idempotent import. No server configuration was
changed during development.

Migration 0067 remains unpublished in the inspected remote main (1560c181, whose
baseline is 0065). Its candidate now contains three tenant tables, immutable source
pages, job/receipt actors and retry metadata. A populated installation of an older
local candidate 0067 must not be silently treated as this schema. Final migration,
production integration and consolidated release checks remain required.

## Historical central projection

Historical messages carry `is_historical=true`; the mirror ledger uses a separate
`HISTORY_PENDING` lane. An older worker polling ordinary `PENDING` must not consume
these records as new messages during an application rollback. Current workers
give live messages priority. Failed historical retries retain their lane.

The candidate JRC offers `jrc-history-import/1`, using its existing API token,
current administrator authority, confirmed organization/inbox binding and tenant
locks. Its historical insert follows the callback-free native Intercom importer
pattern. It preserves original dates/directions and accepts monotonic delivery
acknowledgements without reopening, changing assignment/SLA or scheduling a send,
bot, notification or live message event. Receipts are keyed by immutable Broker
message identity and body; replay cannot create a second historical message.

The Broker probes this capability before remote mutations. An older JRC or stock
Chatwoot without it reports `CHATWOOT_HISTORY_UNSUPPORTED`; it never falls back to
ordinary message creation. Local import completion therefore means persistence in
the Broker. The integration queue separately reports central projection results.
No adapter or behavior is asserted to exist on an external installation that has
not been configured and tested.

For an unmapped contact/conversation the capability must also explicitly advertise
`supports_silent_bootstrap=true`. The dedicated bootstrap endpoint uses bounded,
validated, callback-free inserts and deterministic conversation identity. It never
calls ordinary contact or conversation creation: their callbacks may run central
automation even when greetings, auto-assignment and an inbox bot are disabled.
An ambiguous bootstrap response retries only this idempotent endpoint. A concurrent
live mapping wins over an uncommitted historical mapping; the worker reads the
persisted map and verifies contact/source identity before importing messages.

Future release order: install the tested JRC candidate adapter and adopt the
existing inbox binding first; migrate the Broker to this 0067 and deploy API and
all workers from the same reviewed image; then configure a dedicated read-only
source and explicitly approve a synthetic import. In a fleet, provide the same
private fleet descriptor and referenced engine credentials to API and the history
worker through a reviewed Compose override; the base Compose remains a single
legacy engine. This work did not change server settings or enable a bot.

Local upgrade tests cover populated 0065 and 0066 installations and preserve every
preexisting message field. The rollback lane test checks that an older worker's
ordinary-PENDING selection excludes newly imported history. An actual server
rollback, group/media historical import and phone-cache coverage remain separate
acceptance evidence, not consequences of a passing readiness endpoint.

## Identity epoch coverage

Evolution v2.3.7 logout clears authentication/session state but retains Message
cache; deleting the instance is a different operation. A current owner HMAC alone
cannot authorize cache records from an earlier number. The application therefore
exports only selections starting at or after the verified identity scope's
updated_at. The capability exposes availableFrom (UTC), the panel shows it, and
both service and source refuse an older range with HISTORY_SOURCE_IDENTITY_RANGE.
The fingerprint also pins this boundary. No silent truncation or historical
message replay as new inbound work is allowed. Pre-verification phone history
requires a separate owner-attested source and is not covered by this adapter.
