# Generic partner events, version 1

This contract belongs to the Broker tenant. It does not require a Chatwoot account,
domain or token. A client can first receive its Broker URL/API key and register an
HTTPS webhook later. Creating an API key with `messaging:read`, `messaging:send`
or `webhooks:manage`, or creating an active endpoint, opts that tenant into partner
event capture. Existing tenants without that opt-in produce no partner copies.

## Authentication and endpoints

All routes require a current OWNER/ADMIN JWT or a current API key with the explicit
`webhooks:manage` scope. The tenant is derived from authentication. Responses use
`Cache-Control: no-store`; bodies never accept an organization override.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/partner-webhooks` | Register URL and optional `ackMode` (`HTTP` default; receipt mode opt-in) |
| GET | `/v1/partner-webhooks` | List endpoint metadata, without secrets |
| DELETE | `/v1/partner-webhooks/:id` | Revoke endpoint, erase signing secret and cancel queued deliveries |
| GET | `/v1/partner-events?after=0&limit=50` | Read durable retained events by decimal cursor |
| GET | `/v1/partner-webhook-deliveries?limit=50` | Inspect delivery states, ACK mode, nullable receipt evidence and bounded failure codes |

Registration requires `Idempotency-Key` (1–255 characters). The same key and
normalized URL and ACK mode replay the same endpoint and signing secret, with `replayed: true`.
The key is stored as SHA-256; the signing secret remains encrypted in PostgreSQL.
Reusing the key with another URL or ACK mode returns `409 WEBHOOK_IDEMPOTENCY_CONFLICT`.
Replaying a revoked endpoint returns `409 WEBHOOK_REVOKED`. Use a fresh key when
registering its replacement. An organization may have up to five active endpoints.
The URL and ACK mode are immutable: register a replacement and revoke the prior endpoint.

The create response is `{ endpoint, signingSecret, replayed }`. Store the
independent signing secret securely. It is distinct from the Broker API key and
must never be sent as a URL parameter. Authorized exact idempotent replays can
recover this secret; listing endpoints cannot.

Destinations must use public DNS, HTTPS on port 443 and a path without query
parameters, credentials or fragments. Every attempt resolves DNS again, rejects
the entire answer if any address is non-public, pins the validated address to the
TLS socket, validates the certificate and refuses redirects. Each request is
bounded to 10 seconds, a 2 MiB event body and a 64 KiB response.

## Event envelope and signature

```json
{
  "schemaVersion": 1,
  "eventId": "00000000-0000-4000-8000-000000000001",
  "cursor": "123",
  "organizationId": "00000000-0000-4000-8000-000000000002",
  "type": "message.received",
  "occurredAt": "2026-10-22T16:00:00.000Z",
  "data": {
    "messageId": "00000000-0000-4000-8000-000000000003",
    "channelId": "00000000-0000-4000-8000-000000000004",
    "conversationId": "00000000-0000-4000-8000-000000000005",
    "direction": "INCOMING",
    "source": "CONTACT",
    "state": "DELIVERED",
    "upstreamMessageId": "synthetic-upstream-id",
    "content": { "type": "TEXT", "text": "synthetic text" },
    "errorCode": null,
    "contact": { "id": "00000000-0000-4000-8000-000000000006", "externalId": "synthetic-contact", "displayName": null }
  }
}
```

Types: `message.received` for incoming insertion; `message.created` for outgoing
insertion; `message.status` for an actual state change. Identical repeated status
writes create no extra event. Imported historical messages are excluded so that
history cannot appear as a fresh actionable webhook. `connection.status` carries
`{instanceId,provider:"BAILEYS",status}` for QR or
`{connectionId,channelId,provider:"META",status}` for Meta readiness.

Headers:

* `X-JRC-Event-Id`: immutable event UUID.
* `X-JRC-Delivery-Id`: immutable UUID of this endpoint's delivery obligation.
* `X-JRC-Endpoint-Id`: registered endpoint UUID.
* `X-JRC-Ack-Mode`: `HTTP` or `PERSISTENCE_RECEIPT_V1`.
* `X-JRC-Timestamp`: current attempt time, decimal Unix seconds.
* `X-JRC-Signature`: `sha256=` followed by the lowercase HMAC-SHA256 hex digest of
  `timestamp + "." + eventId + "." + exactRawBody`, using the endpoint signing secret.

Validate the signature against the raw request bytes with a constant-time
comparison. Require a timestamp within five minutes of your current clock and
check that the header event ID equals the envelope event ID. Store `eventId`
durably in a unique inbox before returning success; duplicate attempts must return
success without repeating an application effect. A retry signs a fresh timestamp
but preserves `eventId`, cursor and event data. Do not use webhook retry as an
instruction to send a WhatsApp message again.

## Durability, retry and retention

Database triggers save each event and fan out one delivery per active endpoint in
the same transaction as the source message/state write. A separate bounded
publication transaction allocates cursors only after source commits. A source
transaction that commits late receives a later cursor, so polling cannot skip it.
Webhook delivery order is not guaranteed; use message state transitions and
cursor lookup when reconciling. There is no replay fanout of older events when a
new endpoint is registered; use the events API for retained history.

Workers claim in a short PostgreSQL transaction using `SKIP LOCKED`, a UUID lease
and 30-second expiry. External HTTP runs outside transactions. A short transaction
revalidates the active organization, endpoint, encrypted secret and current lease
before dispatch; completion is fenced by the same unexpired lease. A crashed or
expired worker is recovered with the same event ID. Revocation cancels queued or
claimed work; an HTTP request already dispatched can still arrive, and its stale
completion cannot resurrect the cancelled delivery.

### Negotiated ACK semantics (migration 0079)

URL-only registration remains compatible and defaults to `ackMode: "HTTP"`.
HTTP mode accepts any 2xx, including 204 with no body. Its `DELIVERED` means
transport acceptance only. It does not prove receiver processing, WhatsApp
delivery or custody. A body containing HTML has no receipt meaning in this mode.

Opt in at creation with:

```json
{"url":"https://receiver.example/hooks/broker","ackMode":"PERSISTENCE_RECEIPT_V1"}
```

This mode requires a 2xx with `Content-Type: application/json` and exactly the
following eight fields. IDs must match the authenticated request envelope and
delivery/endpoint headers. `receiptId` is the receiver's stable UUID for its
persisted inbox record, and `persistedAt` is its UTC ISO timestamp.

```json
{
  "schemaVersion": 1,
  "contract": "PERSISTENCE_RECEIPT_V1",
  "eventId": "00000000-0000-4000-8000-000000000001",
  "deliveryId": "00000000-0000-4000-8000-000000000007",
  "organizationId": "00000000-0000-4000-8000-000000000002",
  "endpointId": "00000000-0000-4000-8000-000000000008",
  "receiptId": "00000000-0000-4000-8000-000000000009",
  "persistedAt": "2026-11-01T00:00:00.000Z"
}
```

The receiver must commit the inbox and its deduplication identity before replying.
An identical retry returns the same receipt without repeating application effects;
divergent content under the same scoped identity must conflict. This is a receiver
obligation: JSON validation alone cannot prove its database commit or storage
durability. The Broker accepts only correlated evidence, not custody or processing.
The signature format and signed event envelope are unchanged; verify the signature
and event scope before using the additional delivery headers.

204, absent/oversized/stalled bodies, HTML, malformed JSON, unknown fields,
invalid UUID/timestamp or foreign IDs cannot satisfy this receipt mode. Missing or
invalid evidence in a received response yields `PERSISTENCE_RECEIPT_INVALID` and
bounded retries; transport failures (including limits enforced before a response
is returned) remain `DELIVERY_UNAVAILABLE`. Read
time shares the request's 10-second deadline and is capped at 64 KiB, including
injected transports. Never return credentials, payload content or raw exceptions
in receipt fields. The Broker stores only the validated UUID and timestamps;
event/delivery/endpoint/organization correlation is inherited from its delivery row.
An endpoint cannot reuse a receipt UUID for a different delivery.

The lease-fenced settlement writes status and evidence atomically. Expired/replaced
leases and late completions cannot change a terminal receipt. The delivery API
adds `ackMode` and nullable `persistenceReceipt` with `schemaVersion`, `receiptId`,
`persistedAt`, and Broker `acceptedAt`. HTTP deliveries have no persistence evidence.
Asynchronous processing/custody callbacks and status queries are separate contracts
and are not implemented by this ACK increment. No ACK produces another partner event.

Network errors, 5xx, 408, 425 and 429
retry up to ten total claims, with delays of 1, 2, 4, 8, 16, 32, 64, 128 and 256
seconds (capped at 300 seconds). Other responses, including redirects, are
terminal failures. No `Retry-After` value can override these bounds. Diagnostic
states are `PENDING`, `RUNNING`, `DELIVERED`, `FAILED` and `CANCELLED`; remote
response bodies are never stored; receipt mode stores only the evidence described above.

This increment preserves the existing retry policy. It does not introduce jitter,
Retry-After scheduling, UNKNOWN semantics for remote message sends, dead-letter
redrive, callback ordering, or delivery guarantees for events never received by
the Broker. These queues must not be conflated with `integration_jobs` or a new
WhatsApp send. Receivers must handle duplicate transport after a lost ACK or lease.

Partner event copies and their delivery rows are retained for 30 days. The worker
prunes up to 500 expired events per organization maintenance pass, excluding an
unexpired running lease. API reads and publication exclude older records
immediately; physical cleanup depends on the worker continuing to run. Maintenance
also prunes suspended organizations. Broker messages and their ordinary history
are not deleted by this retention rule. Deleting a channel/instance cascades its
event snapshots and deliveries; organization lifecycle purge covers all four
partner tables.

Events responses contain `retentionDays:30`, `earliestCursor` (nullable),
`lastPrunedCursor`, `nextCursor` and `data`. Use the returned cursor exactly; numbers are decimal
strings to avoid JavaScript precision loss. An obsolete nonzero cursor returns
`409 EVENT_CURSOR_EXPIRED` when a higher cursor was pruned, including
`retentionDays`, `earliestCursor`, `lastPrunedCursor` and `resetCursor:"0"`.
The watermark persists even when no retained rows remain and detects expiry of a
higher cursor while a lower cursor is still retained. A cursor already at or above
that watermark can continue normally. Restart at zero and reconcile against the Broker message API.
Channel deletion can also remove retained event history. Never infer delivery or
message success merely from an empty event page.

## Runtime integration

The API and worker share `PARTNER_WEBHOOK_ENCRYPTION_KEY`, a dedicated base64
encoding of 32 random bytes. Keep it stable across restarts; losing it makes
existing endpoint secrets unavailable. It is separate from every client API key
and from each randomly generated endpoint signing secret.

Start the worker with:

```text
node apps/api/dist/commands/partner-events-worker.js --watch
```

It requires a direct `jrc_app` `DATABASE_URL` and uses tenant RLS for all work.
`PARTNER_EVENTS_WORKER_INTERVAL_MS` defaults to 1000 (range 100–60000).
`PARTNER_EVENTS_WORKER_DB_POOL_MAX`, `_CONNECT_TIMEOUT_MS`, `_IDLE_TIMEOUT_MS`
apply the shared process pool budget. Discovery is bounded to 100 organizations
per page and each tenant gets up to 20 claims per pass.

Migration 0070 adds the four RLS/FORCE tables `partner_webhook_endpoints`,
`partner_events`, `partner_event_deliveries`, `partner_event_cursor_state`, sequence `partner_event_order_seq`,
trigger function `partner_capture_event()`, bounded publication/retention function
`partner_publish_events()` and discovery function
`partner_event_worker_organizations(uuid,integer)` and the read-only readiness
function `partner_event_catalogue_ready()`. Only the migrator-owned trigger
and publication functions can insert or mutate event snapshots; app access is
SELECT-only. Payloads are immutable after capture; publication assigns only the
previously absent cursor, and retention removes expired records.

This subsystem dispatches partner events only. It never sends WhatsApp messages
and never needs or stores a receiver's platform administrator token.

Migration 0079 is additive: existing endpoints default to HTTP and existing
deliveries retain null receipt evidence. It adds no table or lifecycle policy.
Apply it before running the new API/worker. Application rollback preserves this
schema and evidence; do not run a down migration. A rollback application candidate
must explicitly support migration 0079 and its grants. The unmodified 0078 API
has exact grant/manifest checks and cannot be called compatible with this schema.
Before using an older worker,
revoke opted-in receipt endpoints (preserving their ledger), then provision any
replacement endpoint under a separately agreed contract. The SQL receipt fence
deliberately rejects an older worker's receipt-free settlement of an opted-in
endpoint, so a mixed old/new worker rollout is not supported for that mode.
Revoking receipt endpoints alone does not make an old API's readiness checks pass.
