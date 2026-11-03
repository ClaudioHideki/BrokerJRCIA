# CCLX synthetic receiver: isolated PostgreSQL increment

This standalone laboratory ports the durable-receiver semantics from `docs/broker-jrc-2-redesign-homologacao/evidencias/baseline-20261030/simulador/` to real PostgreSQL. The historical SQLite files remain unchanged. This is a synthetic receiver contract and a test harness, not an installed CCLX/Chatwoot adapter or a Broker route.

## Run

Install the repository's locked dependencies. Supply **only an explicitly disposable local test PostgreSQL** via `TEST_DATABASE_ADMIN_URL`; never source a production environment file. The supplied administrator must be able to create/drop isolated test databases. For example, in PowerShell with an authorized test URL already supplied:

```powershell
node --test labs/cclx-postgres-simulator/receiver.test.mjs
```

There is no `DATABASE_URL` fallback and no skipped-success mode. Missing test configuration fails the run. The admin URL must use PostgreSQL, a literal loopback host (`127.0.0.1`, `localhost` or `[::1]`) and a database beginning `lab_` or `jrc_test_`. URL parameters/fragments are refused to prevent host overrides. Production mode and a missing explicit `labOnly: true` flag are refused.

Each fixture creates `jrc_test_cclx_<random UUID hex>` with only new `cclx_lab_*` tables and a random ownership marker. Receiver reopening requires both that exact database prefix and matching marker. No application migrations, shared tables, production roles or data are used. Cleanup drops only the random database created by the helper, after verifying ownership. It never terminates other connections, uses `DROP FORCE`, or restarts PostgreSQL. Files live in a marked `cclx-pg-lab-*` directory directly under the OS temporary directory; cleanup validates that exact path and token before recursive removal.

## Acceptance and recovery

`openLabReceiver(...).handle(request)` accepts an injected local request object. It creates no HTTP listener, public callback, remote connection or real provider operation. The only network connection is to the guarded local test PostgreSQL. `/lab/cclx/events` is a lab-only path label.

The envelope retains schema version 1, `message.received`, the two fixed synthetic organizations, a synthetic UUID event namespace, `labFixture: true`, a nonnegative sequence and a decimal-string cursor bounded by PostgreSQL BIGINT. Customer data and arbitrary payload fields are refused. The hardcoded key is a public synthetic fixture key, not an authentication design for production.

HMAC-SHA256 authenticates the exact raw bytes using the original `${timestamp}.${eventId}.` prefix and constant-time comparison. The explicit replay window is 300 seconds in either direction. Logical idempotency is `(organizationId,eventId)`; a changed raw-body SHA-256 for an existing logical event returns 409 without changing its original projection. Different tenants may independently use the same event ID. A new signature/timestamp can retry the same unchanged body.

Inbox, envelope/hash and projection commit in one PostgreSQL transaction before 202 is returned. Both event and media receipt transactions explicitly use `SET LOCAL synchronous_commit=on`; opening refuses PostgreSQL with `fsync` or `full_page_writes` disabled. The test changes only its own random database's default to asynchronous commit and uses deferred constraint triggers to reject a projection/receipt commit unless the receiver has explicitly restored synchronous commit. ACK follows PostgreSQL's successful commit response; the harness does not independently audit hardware write-cache behavior.

`afterInboxInsert` rolls back the complete event effect. `lostAckAfterCommit` throws after commit, modeling a lost transport response. Closing/reopening the receiver creates a fresh pool; replay finds the durable inbox and returns `duplicate: true`, preserving one projection. Close immediately rejects new operations and drains admitted operations before ending the pool. This proves reconnect/reopen recovery, not a physical host or PostgreSQL restart drill.

`stats`, `readEvent` and `readMediaReceipt` are local inspection helpers. `stats` intentionally reconciles **both synthetic tenants**; it is not a tenant-authorized application endpoint. This standalone database uses no production RLS or application authorization claims.

## Files and media receipt

Event 202 confirms the event inbox/projection only. It does not claim media custody. Media is a separate injected byte stream after that event has committed. No media URL, arbitrary path, external download, callback or S3 credential is accepted.

`persistMedia` enforces a maximum of 16 MiB, validates the expected SHA-256 and checks PNG/WAV/MP4/PDF signatures. It writes an exclusive temporary file with mode 0600 inside a mode-0700 generated directory, fsyncs it, adopts a final generated per-tenant/event object name without overwriting another file, reads the stored bytes back and compares their hash. Only then does it commit a receipt in PostgreSQL. A previous receipt is not sufficient to hide corrupted bytes: a duplicate copy verifies the file again. Conflicting media metadata is refused.

The receipt remains `COPY_PERSISTED_UNVALIDATED`, with `validation: SIGNATURE_ONLY_NO_CODEC_VALIDATION` and `sourceEligibleForDeletion: false`. It never authorizes deleting a source. Mode bits are effective on POSIX; Windows inherits the current user's temporary-directory ACL, and an independent Windows ACL audit is not part of this proof. Directory fsync is attempted; the receipt records `directorySync: UNAVAILABLE_ON_PLATFORM` where the OS refuses it. That platform does not receive a power-loss guarantee for the directory entry.

`afterFileSync` leaves verified final bytes but no receipt; retry after reopening adopts those bytes and commits the receipt. `afterReceiptCommit` loses only the receipt response; retry after reopening returns the existing receipt. Partial/oversized streams, a wrong hash, wrong MIME signature, missing event, changed media identity and stored-file corruption do not issue a successful new receipt. Existing durable records are preserved for diagnosis; no queue or orphan cleanup is used to make counts pass.

## Evidence and remaining work

- `red.log`: semantic RED after minimal module scaffolding, 6 missing-behavior assertion failures and 1 guard pass against a real isolated PostgreSQL setup. An earlier missing-module import error was corrected before this RED run and is not counted as a behavioral proof.
- `durability-red.log`: asynchronous default exposed a missing explicit synchronous commit, 1 expected failure / 7 passes.
- `close-red.log`: close admitted a new request, 1 expected failure / 8 passes.
- `green.log`: final serial Node test output; exact result is recorded there.

The suite covers HMAC raw bytes/timestamp/event binding; test-only configuration/marker guards; atomic rollback and independently visible committed rows; concurrent duplicates; payload conflicts; tenant separation; lost event ACK/reopening; synchronous event/receipt commits; draining close; real PDF-like fixture bytes; interrupted/oversized/hash/MIME failures; file-sync and receipt-ACK failure points; duplicate media, conflicts and physical corruption. Fixtures are deliberately tiny, synthetic bytes and contain no codec-validation claim.

**Historical baseline limits:** the original receiver-only increment did not cover S3/MinIO, Redis, Evolution, an installed Chatwoot adapter, process termination or capacity. The dated increments below and `docs/release-integrada-jrc/MIDIA-WORKER-S3-20261102.md` supersede those limits only for their explicitly tested paths. Genuine media codec/streaming interoperability, host/power-loss durability, production transport, real WhatsApp sessions and client homologation are not established by this laboratory. Backup, dump and restore activities are outside this increment's scope.

## Increment 2026-11-02: source and receiver process termination

`worker-integration.test.mjs` now exercises the compiled Broker media worker against real isolated PostgreSQL and a dedicated loopback MinIO. `media-source-process.mjs` admits only the owned disposable database and fixed synthetic tenant/event scope; it does not inherit production environment configuration.

The source child performs one encrypted object PUT and is terminated after that PUT but before SQL settlement. A separate child waits for natural lease expiry and recovers by inspecting and reading back the existing object, without another provider download or PUT. The receiver is independently terminated after its PostgreSQL receipt COMMIT but before returning the ACK, then restarted. The test reconciles one event, projection and custody receipt, unchanged identities, both physical byte hashes and `KEEP` retention.

The local 2026-11-02 combined run passed 8/8 tests (four boundary guards and four worker scenarios), with no skips. Its detailed process IDs, object/SQL assertions and limitations are recorded in the media evidence document. On Windows, the test proves termination of the recorded Node child processes and subsequent recovery; it does not prove a POSIX signal path, physical host crash, storage power-loss survival or real WhatsApp delivery. No source object is made eligible for deletion by this proof.

## Finite synthetic event measurement

`node labs/cclx-postgres-simulator/benchmark.mjs --lab-only` performs exactly four finite stages of **50, 100, 200 and 400 synthetic events**, with at most four concurrent injected requests and exactly 10% extra duplicate requests for those default stage sizes. These numbers are event counts, never WhatsApp sessions. The program has no external target option, interval or indefinite loop. Programmatic test counts remain bounded to 400 per stage, four stages and 750 total unique events; concurrency above four is refused. The duplicate count for tiny tests is `floor(uniqueEvents / 10)`.

The JSON reports per-stage and per-tenant p50/p95/max/request latency, stage duration, accepted/duplicate/error counts and cumulative PostgreSQL row counts. The independent verifier compares the pre-send manifest against SQL rows by `(organizationId,eventId)`, original-body SHA-256, cursor, sequence, complete envelope and projection. Both synthetic tenants deliberately reuse event IDs; count agreement alone cannot pass reconciliation. `latencySamples: 0` identifies an unmeasured tenant, not a zero-latency measurement. `endingBacklog` is null with `NO_QUEUE_IN_THIS_LAB`; there is no worker queue from which a real backlog could be measured. Host Node/OS/CPU/RAM and PostgreSQL version/durability settings are collected in the JSON; PostgreSQL container limits and resource contention are explicitly not measured. Stage timing excludes database setup and cleanup; total timing includes setup and stops before cleanup.

The 2026-11-01 run (`benchmark-20261101.json`, command/exit record in `benchmark-run.log`) reconciled **750 unique events, 825 requests, 750 accepted, 75 duplicates, zero errors, 750 inbox rows and 750 projections**. It completed the measured setup/stages in 3055.064 ms on the recorded local machine. This is a tiny functional event measurement; it excludes media performance, engine/WhatsApp sessions, external transport, 250,000 messages/day and SLO validation, and supplies no GO/capacity decision.

`benchmark-red.log` records two expected missing-behavior failures; `benchmark-green.log` records two passes, including three real PostgreSQL events and guard checks. An explicit `TEST_DATABASE_ADMIN_URL` remains mandatory. CI can run both isolated suites serially:

```text
node --test --test-concurrency=1 labs/cclx-postgres-simulator/receiver.test.mjs labs/cclx-postgres-simulator/benchmark.test.mjs
```

## Increment 2026-11-01: optional S3 custody

`openLabReceiver({ labOnly:true, database, mediaState, s3:{endpoint,bucket,accessKeyId,secretAccessKey} })` selects the S3 branch. The endpoint must be loopback and the bucket must be a new `cclx-lab-<UUID>` lab bucket. Unknown transport/config overrides are rejected. No production environment defaults are read. Build the API first (`npm run build`); the lab reuses its compiled private S3 adapter without another SDK/package.

The receiver validates bounded incoming bytes, SHA-256 and MIME signature in its private temporary file, then conditionally uploads to the deterministic organization/event object. The existing adapter checks private-bucket controls. Actual GET bytes must match the length and SHA-256 before a synchronous PostgreSQL receipt COMMIT. Repeated deliveries verify the physical object again and return the existing SQL receipt. A conflicting object is never overwritten. A changed storage mode/destination cannot reuse an earlier receipt. `retention: KEEP` and `sourceEligibleForDeletion: false` remain unconditional.

A successful upload followed by failed SQL commit/crash can leave an object without a receipt. Keep that orphan; retry adopts only verified identical bytes. SQL and S3 are separate systems, without a distributed transaction or automatic orphan deletion. `afterObjectUpload` and `afterReceiptCommit` simulate interrupted acknowledgement paths; the integration suite also uses a real deferred SQL COMMIT rejection and corrupts actual stored object bytes. These are synthetic local failures, not process-kill/crash or power-loss proofs.

Run `node --test --test-concurrency=1 labs/cclx-postgres-simulator/media-s3.test.mjs` with the same explicit test PG URL and a dedicated disposable MinIO. The suite accepts `TEST_CCLX_S3_ENDPOINT`, `TEST_CCLX_S3_ACCESS_KEY_ID`, `TEST_CCLX_S3_SECRET_ACCESS_KEY`, or the existing pinned storage runner's `TEST_STORAGE_*` equivalent variables. Local synthetic defaults target loopback15440 only. Each test creates a fresh bucket; objects/buckets are deliberately retained until their dedicated container is explicitly disposed.

For the cached `jrc-broker-minio-lab:release-20250907` image, explicitly execute `/usr/bin/minio`: the image PATH contains an older `minio`. Verify `/usr/bin/minio --version` and its SHA-256 against `scripts/ci/storage-minio.mjs`. The corruption test catches a backend that silently ignores conditional PUT. Never reuse `campaign-minio` or any shared bucket.

This branch is an unencrypted synthetic byte-custody laboratory. It does not validate codecs, real partner acceptance, real Chatwoot/CCLX, a production worker, key custody, backup/restore, or a WhatsApp session. Those B03 gates remain open.

Concurrent cross-mode coverage additionally gates a filesystem INSERT on a real PG advisory lock while an independent S3 receiver commits first. The losing filesystem caller must reject the winning receipt's incompatible storage mode; the symmetric final SQL-winner check covers this even when both receivers initially saw no receipt. Review regression: semantic RED then 9/9 S3 GREEN (`media-s3-race-*.log`).
