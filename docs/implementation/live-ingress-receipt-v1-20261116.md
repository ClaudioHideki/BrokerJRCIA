# Native LIVE persistence receipt — repair increment

## Existing defect and scope

The Broker persists a mirror attempt before POSTing a live message. LAB2's generic message POST has no immutable, idempotent receive receipt. A lost response after COMMIT therefore leaves UNKNOWN; an editable content marker cannot prove which POST committed. Groups have the same defect. History V2 is callback-free and must not be used to repair LIVE.

This additive contract implements the already required idempotent inbox/persistence receipt for the controlled LAB2 consumer. Stock Chatwoot remains on its existing conservative generic path. No production deployment, replay, engine change, or existing UNKNOWN release is authorized by this document.

## Routes and authority

Root: `/api/v1/accounts/:account_id/jrc_broker/inboxes/:inbox_id/live-ingress/v1`.

- `POST /capability`: read-only scope validation; no message mutation. Return the exact protocol and scope plus `supports_text`, `supports_media`, `supports_occurred_at`, and `max_media_bytes`.
- `POST /messages`: JSON for text, multipart for one private media file (`envelope` JSON plus `file`). Return a persistence receipt, never a WhatsApp delivery claim.
- `POST /receipts/:broker_message_id`: read-only lookup using exact scope and `request_hash`; return the original immutable receipt or a definite not-found result. It does not resend anything.

All routes require an active administrator API token, active account/API feature, enabled Broker feature, registered API inbox, and the current exact organization/integration/instance/destination revision. Ordinary agents, browser-only authority, cross-account credentials, stale bindings and historical requests are rejected. A present endpoint with missing/stale scope returns a scope conflict/forbidden response, not an endpoint-absent 404 that could trigger downgrade.

The client may select generic compatibility only after capability endpoint 404/405 *before* any native message POST. Once a native operation has been recorded, it never falls back to generic POST after timeout, error, removal of capability, or lost ACK. Read errors do not authorize sends.

## Envelope and deterministic hash

The envelope has these required keys (including explicit null `media` for text), plus the optional source clock described below:

```text
protocol: "jrc-live-ingress/1"
organization_id, integration_id, instance_id: UUID
destination_revision: positive safe integer
broker_message_id: UUID
conversation_id: positive safe integer (Chatwoot display ID)
message_type: "incoming" | "outgoing"
message_origin: "LIVE" | "EXTERNAL_OBSERVED"
content: string, at most 65536 UTF-8 bytes
media: null | { filename, mime_type, byte_size, sha256 }
request_hash: lowercase SHA-256
occurred_at: optional nonnegative safe integer, Unix seconds
```

`request_hash` is SHA-256 of UTF-8 JSON with recursively lexicographically sorted object keys, excluding `request_hash`. Arrays preserve order; no floats, implicit values, caller attributes, or arbitrary URLs. A text message requires nonempty content. `EXTERNAL_OBSERVED` is outgoing only. A file is at most 16 MiB, has a bounded safe filename/MIME, and is checked against descriptor size, SHA-256 and supported actual MIME. Broker normalizes a filename once to at most255 UTF-8 bytes, preserving a bounded extension, before hashing and multipart serialization. Receiver validates that exact filename; it does not renormalize the descriptor differently.

`occurred_at`, when supplied by the authenticated Broker, is part of the immutable hash and is bounded by receiver current time+300seconds. Workers use canonical message creation time, not mirror dispatch time. Absence retains the original envelope/hash and server clock semantics; retry uses the originally pinned field or its original absence. Receiver sets this clock only inside the native MessageBuilder operation, without widening generic message parameters. Conversation activity advances monotonically under the conversation lock and reloads the authoritative database value before callbacks; the first message may replace an empty conversation's default arrival anchor. An older arrival must not move a newer conversation backwards. The caller cannot inject private flags, bots, assignment, arbitrary generic timestamps, or a receipt.

## Durable inbox and custody

The unique receive key is account/inbox/organization/integration/instance/Broker message UUID. Destination revision and exact conversation/body/file descriptor are part of the immutable hash. Repeat of the same key/hash returns the same message/receipt; any differing hash/context conflicts instead of creating a second message. Concurrent requests serialize through a unique constraint and transaction lock.

Normal LIVE MessageBuilder/model callbacks are retained. Message and receipt commit together. Rollback creates neither. Existing messages are never adopted merely because a caller-editable marker matches.

For media, reserve the immutable envelope and private bytea escrow durably as `MEDIA_PENDING`, initially with `message_id:null`. Do not publish a normal LIVE message/callback before the private ActiveStorage bytes are actually read and their hash/size match. A durable pending obligation/worker and scheduled recovery cover COMMIT-to-enqueue, storage outage and crash. Failed verification retains the original blob/staging/receipt; it does not replace bytes or claim success. Bound each file to16MiB and pending escrow to64MiB per account under lock; reject excess before reservation. Only after verified S3 custody may normal MessageBuilder/message identity and `PERSISTED` commit together and release the bytea escrow. The final private object remains KEEP with no expiry/deletion policy added. `PERSISTED` is a receipt of JRC custody, not delivery to WhatsApp.

Receipt fields: protocol, receipt_id UUID, state (`PERSISTED`/`MEDIA_PENDING`), request_hash, all scope fields, account_id, inbox_id, broker_message_id, conversation_id and message_id. Its identity/hash/source fields are immutable. Only custody progress/retry diagnostics can advance. Lookup revalidates the current authorized scope, so a stale credential cannot inspect prior data after remapping.

## Broker recovery

Before native POST, save the selected protocol, exact hash/scope and mirror-attempt identity in the existing PostgreSQL job payload. Validate all response fields. Native timeout/body loss or MEDIA_PENDING may be followed by a bounded **read-only** receipt lookup. Only matching `PERSISTED` evidence can confirm the existing mirror attempt/map. Missing, conflicting or inaccessible evidence stays UNKNOWN; no POST is repeated blindly.

Explicit reconciliation handles individual `SEND_MESSAGE` and `GROUP_SEND_MESSAGE` through this native proof path. Group reconciliation must revalidate its group scope/selection/participation/ownership rather than invoking individual phone validation. Old generic attempts without native proof retain their current conservative behavior.

A definitely rejected native request may retry only from the original `REJECTED` attempt, with no receipt identity, identical hash/context and the original conversation map. Any other DISPATCHED/UNKNOWN attempt for that integration/message blocks another POST. A missing or changed original map is rejected before bootstrap. Dispatch lease and current scope are rechecked before and after HTTP and before confirmation; expiry after POST preserves uncertainty and prevents further receipt I/O by that worker.

LIVE and history share an account/inbox/organization/integration/source-ID lock. A message may be reused across the two protocols only from immutable scoped receipt evidence with matching direction, presentation and physical media hash/size/MIME. Legacy mutable markers or old history rows without immutable origin context are insufficient. Adoption preserves the original message/timestamp and does not emit another callback. Pending media rechecks this rule before publication and keeps its escrow on conflict.

The messaging worker may inspect at most one due **new native** UNKNOWN per organization/tick, using the existing indexed `available_at` budget (15 seconds between inspections). This is bounded receipt lookup only, with a3-second read timeout; it never resends a message. Only an exact immutable `PERSISTED` proof can finish the original obligation. Generic/old UNKNOWN and FAILED records are excluded. Pending/missing/revoked/conflicting receipts remain UNKNOWN and observable; send-attempt counts are not reset. The current organization scanner includes these tenants even without new sends.

## Required RED/GREEN evidence

1. Normal LIVE delivery, lost ACK after COMMIT, crash/restart, duplicate callback, concurrent same key: exactly one JRC message and receipt.
2. Different content/file/conversation/scope under same key: conflict and no mutation; mutable message markers cannot forge lookup evidence.
3. Two independent Accounts/inboxes/tenants, ordinary agent, revoked admin, stale binding/destination: deny and no leakage.
4. Image/audio/PDF, private storage outage/corruption/truncation, lost enqueue: MEDIA_PENDING until bytes prove custody, same receipt after recovery.
5. Individual and group worker recovery never issues another POST; unknown legacy attempt remains unknown.
6. Stock Chatwoot compatibility and history-silent semantics unchanged. No real session or production operation is exercised.

## Migration and release

LAB2 candidate adds `20261116190000_create_jrc_broker_live_receipts.rb`: receive-receipt/escrow table, immutable trigger, indexes/constraints, and nullable immutable `origin_context` on history receipts. Old history rows remain null; they are not retrospectively promoted to proof. Broker reuses its existing attempt/job tables.

The foreign keys intentionally retain evidence with RESTRICT for message/inbox/account/private blob; deleting an active reference through existing hard-delete jobs can consequently fail. This is a release compatibility gate until disconnect/archive and separately authorized expurgo are reconciled; CASCADE is not a substitute. `down` is explicitly irreversible while receipts/escrow/KEEP exist. An authorized binary rollback must pause native admission/recovery, preserve the additive schema, receipts and files, and must not expose pending native jobs to generic replay. No rollback command or backup/dump/restore is executed by this increment. Receiver migration+binary precede enabling Broker native dispatch; CI/image/runtime acceptance remain separate gates.
