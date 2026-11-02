# B02-A local implementation evidence — 2026-11-01

**Historical first-increment report below.** The subsequent authenticated HTTP/finite lab-bootstrap/actual SIGKILL increment is documented in `output/increment-20261101/origin-report.md` under this package and in the parent output directory. Its final combined suite passed 36 tests, including actual Broker HTTP/PG COMMIT before ACK + sender SIGKILL + stable replay. Neither increment installs/enables an Evolution engine; ownership remains UNPROVEN and B02 remains open.

Baseline Broker HEAD at start: `049a410`. Scope: new files in `integrations/evolution-origin-journal/` only. Design recorded in DESIGN.md before implementation. No commit, engine/bootstrap/infra/workflow edit, image publication, production action or actual WhatsApp/HTTP integration traffic was performed.

## Implemented

Engine-owned PostgreSQL schema `jrc_evolution_origin`, independent of Broker schema/outboxes; encrypted allowlisted individual notify-TEXT capture; atomic identity/content conflict checks; scope-serialized claims; lease recovery/fencing; durable attempt metadata and retained terminal states. Commits explicitly set local synchronous_commit on. Runtime logging does not contain event bodies, addresses, QR or credentials; the runtime modules have no console/logger calls.

Injected integration dispatcher with strict opt-in; stable sourceEventId and matching durable-receipt requirement; binding checks before/after I/O; one total bounded authority/delivery deadline with propagated AbortSignal; bounded429/backoff; retained uncertain outcomes; crash/reclaim attempts bounded before another external call.

Pinned-source preparation checks the full normalized-LF service hash and inserts awaited capture before the actual source's volatile Promise assignment. The real prepared callback control flow is exercised by tests. Missing/disabled capture under an enabled source flag fails closed. No vendor source is written.

## TDD and verification

Native Node tests were written and run RED before their implementation modules existed; those initial RED runs were import/module-not-found failures, not semantic PostgreSQL assertions. Subsequent semantic RED reproduced protocol-bearing text admission, missing pre/post authority deadlines, disabled-hook confirmation, retry budget after crashed claims, protobuf Long rejection and CRLF/LF source portability. These were corrected and retested. Local ignored logs retain RED/GREEN evidence; logs are not part of the intended commit.

The final complete package test run: **25 passed,0failed,0skipped**:9unit/control-flow/guard tests and16real PostgreSQL tests. The suite uses TEST_DATABASE_ADMIN_URL only; dedicated local lab at loopback15439; each invocation creates/drops one isolated random database. The guard rejects URL query/hash overrides, non-PostgreSQL protocols, nonlab/nonloopback targets and NODE_ENV=production before I/O. Cleanup never terminates leaked connections or uses DROP FORCE. It does not modify the supplied lab admin database, Broker schema, roles or tables.

Exact command (set TEST_DATABASE_ADMIN_URL externally):

```sh
node --test --test-concurrency=1 integrations/evolution-origin-journal/tests/unit.test.mjs integrations/evolution-origin-journal/tests/postgres.test.mjs
```

Covered with real PostgreSQL: encrypted acceptance, duplicate identity and all-batch rollback, concurrent claims, expired-lease fencing, receiver commit followed by lost ACK with one unique receiver effect, invalid receipt, terminal4xx retention,429schedule/budget, binding change before/after external outcome, pool/adapter recreation, disabled dispatch, trigger-enforced synchronous_commit even when caller session defaults off, crash/reclaim budget, never-resolving pre/post/delivery ports, and late authority completion without a late external call.

The lab asserts fsync/full_page_writes/synchronous_commit are on. Acceptance/settlement SQL and synthetic receiver commit synchronously. The adapter does not independently guard server fsync/full_page_writes; that verification remains a required caller precondition, explicitly documented. This is SQL-level configuration/transaction evidence; physical storage flush, processSIGKILL, PostgreSQL restart, hardware failure and restored backup have **not** been tested. “Restart” in this suite is explicitly a fresh pool/adapter plus lease recovery.

The source test uses Node24's experimental stripTypeScriptTypes API and emits its standard warning. There is no test skip or hidden fallback when PostgreSQL is unavailable. Package syntax/diff checks and combined-repository gates are reported separately by the executor principal.

## What remains unintegrated

1. The existing Broker QR200 `{status:accepted}` lacks the exact sourceEventId durable receipt and is rejected by this dispatcher. A real authenticated recipient adapter with transactional ID/effect dedupe is required before uncertain-outcome retry can be enabled against an actual service.
2. The overlay is preparation only: no engine bootstrap, binding/key installation, direct-webhook suppression or exclusive delivery ownership is installed/proved. Its ownership declaration is not an attestation. The engine flag must remain disabled.
3. No full engine compilation, derivative Docker image, release/provenance verification, runtime session or source-process crash test was performed.
4. Capture covers notify individual TEXT only. Append/history, wrappers not projected, LID-only, edits/protocol, status, connection, groups and media are outside the guarantee. No replay invokes the legacy Baileys handler or chatbot/send side effects.
5. Caller must impose PostgreSQL pool/acquisition/query/statement/lock timeouts. The external-port deadline starts after claim. Operational retention/key rotation/re-encryption/unblocking/operator controls still need design and tests.

**B02 remains open.** This package is the first executable isolated unit and a safe basis for the next integration gate; it does not authorize enabling an engine, switching a destination, replacing an outbox or publishing an image.
