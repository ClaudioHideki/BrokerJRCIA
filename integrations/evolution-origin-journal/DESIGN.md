# B02-A origin journal: design and implementation plan

Scope approved by the parent execution task on 2026-11-01. This is an isolated JRC-owned laboratory increment, not a completed engine integration or release.

**Goal:** persist allowlisted individual TEXT facts in an engine-owned PostgreSQL schema before a source hook can enqueue volatile work; replay only the integration delivery, with stable IDs, leases and explicit durable receipts.

**Architecture:** ESM JavaScript uses the existing `pg` dependency and PostgreSQL. One encrypted event row also owns its delivery obligation, with separate attempt records. There is no Redis queue or change to Broker outboxes. Runtime dependencies and binding authority are injected; no default network transport, engine session or auto-start worker exists.

**Spec:** user mission sections8/10 and `output/b02-source-20261101.md`. Pinned upstream commit fa09d37892cdbb1d65a250155d293d92230c5b30. Preserve vendor checkout and notices.

## Decisions

- Disabled unless `JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED` equals the exact string `true`. Enabled but missing capture/bootstrap fails closed.
- Projection admits only individual notify text with stable provider key, direction, valid timestamp and individual address. Excludes append/history batches, groups, QR, creds, media and context/quoted secrets. Unsupported facts are outside this increment's promise, never reported as captured.
- AES-256-GCM encrypts the allowlisted projection at rest; key and bearer are never persisted. Stored metadata contains opaque IDs/hashes/codes. Accepting a whole batch is one transaction; conflicting content for the same logical key rolls it all back.
- Scope freezes instance, source generation, destination identity and binding revision. One live claim per scope; expired leases can be reclaimed, stale tokens cannot settle. Pending facts remain after restart; terminal failures stay BLOCKED for review.
- Dispatcher requires a recipient capability that returns an exact sourceEventId and durable-acceptance receipt. The legacy Broker `{status:accepted}` response does not satisfy that stronger contract. Receiver integration is deliberately not wired here.
- Replay calls only the injected delivery port, never the volatile handler/chatbot/sendMessage. Binding authority is checked before and after the delivery port.2xx without a matching durable receipt stays uncertain/recoverable;429 honors a bounded Retry-After; redirects/permanent4xx are blocked;5xx/timeouts retry the same fact ID.
- Source overlay preparation verifies the exact upstream service SHA256 and inserts an awaited opt-in hook before `eventProcessingQueue`. A host must explicitly supply capture and exclusive delivery ownership. Bootstrap, direct-webhook suppression, compilation and image delivery are outstanding; do not enable this patch in an engine yet.

Alternatives rejected: webhook proxy (too late), Redis queue (competing durable authority), replaying the legacy Baileys handler (would repeat chatbot/send side effects), changing the vendor gitlink (outside scope).

## Files and execution

1. `tests/unit.test.mjs`, `tests/postgres.test.mjs`: native node:test in one process, per parent CI alignment. Write RED for opt-in/projection/hook ordering, actualPG transaction/conflict, concurrency, fencing, retry, ACK loss and client restart. Use TEST_DATABASE_ADMIN_URL only, restricted to loopback and lab_/jrc_test_ database names; create a separate randomly named database and never alter the supplied admin database. No DATABASE_URL fallback.
2. `src/projection.mjs`, `src/hook.mjs`: projection and awaited capture wrapper. RED → minimal implementation → GREEN.
3. `schema/origin-journal.sql`, `src/journal.mjs`: engine-only schema, encrypted atomic append, scope-serialized claims, fenced settlement and durable attempts. RED → implementation → actualPG GREEN.
4. `src/dispatcher.mjs`: injected receipt-based integration dispatch, bounded retries, timeout and binding revalidation. RED → implementation → actualPG GREEN, including a transactional idempotent synthetic receiver whose ACK is lost.
5. `src/overlay.mjs`: pinned-source preparation and test against the actual source callback prefix, without editing/copying third-party source into this folder. Capture adapter is not automatically registered on an engine.
6. `README.md`, `REPORT.md`: exact invocation, verification evidence, provenance/licensing, unsupported boundaries and remaining integration gates. No commit, publish or deployment.

## Review focus

Malicious/unsupported batch parts cannot enter ciphertext; same-key/different-body cannot silently overwrite; claim expiration cannot settle a replacement; a successful HTTP status cannot fake durable responsibility transfer; enabled source without a correctly installed hook must not enqueue volatile work. Tests belong with each respective unit.

## Explicit limits

Tests use real PostgreSQL and a synthetic delivery port/transactional receipt receiver, not the real Broker endpoint, WhatsApp or engine binary. Inserting a source hook is not a working bootstrap, and ownership of direct webhook delivery is not proved by this package alone. B02 remains open until those integration and crash gates pass. No claim is made about events WhatsApp never provided or facts not committed durably.
