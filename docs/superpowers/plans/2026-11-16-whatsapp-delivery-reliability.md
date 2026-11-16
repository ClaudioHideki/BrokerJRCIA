# WhatsApp delivery reliability — correction plan

> **For agentic workers:** Use systematic debugging and test-driven development. Independent LAB2, group and media scopes may run in parallel; root integrates the shared contracts and reviews the whole diff.

**Goal:** Correct the diagnosed Broker/LAB2 delivery and visibility defects while preserving canonical IDs, message history, private media, tenant boundaries and uncertain outcomes.

**Architecture:** Preserve PostgreSQL journal/outbox/receipts and the existing pinned engine. Extend only proven contracts additively; callback ACK is not provider delivery. Isolate positively authenticated new human intent from an unrelated uncertain mirror without replaying the uncertain operation or admitting legacy replies. A physical media receipt requires reading and checking the stored bytes.

**Spec:** Approved `../specs/2026-11-05-whatsapp-history-sync-design.md`, current history implementation checkpoints, and the diagnostic/correction sequence accepted by the user on 2026-11-16. This is a repair increment, not a replacement architecture or authorization to bypass ownership.

## Constraints and rulings

- Broker base c3bae632; LAB2 base a24adc6d (functional 5c3fb7f). Origin/main fetched and confirmed before editing; existing worktrees reused on `codex/whatsapp-delivery-reliability-20261116`.
- Preserve UNKNOWN and all pending records. No blind resend, SQL state reset, bulk bot clearing, fake source coverage, phone pairing or actual recipient test.
- No production deployment/configuration/credential change in this increment; prepare reviewable code and isolated tests. Backup/dump/restore and aggregate commands invoking them are excluded.
- New human-intent exception, if supported, must require durable intent identity, authenticated observation, exact current map/destination/credential scope, canonical message verification and a different physical contact from EVERY uncertain mirror. Ambiguous, stale, historical, bot, private, same-contact or unmatched context remains fenced. Existing campaign rules remain unchanged.
- Missing storage bytes cannot be reconstructed by changing database status. KEEP and staging remain until physical integrity is proved.
- Missing policy, group scope or bot authority is a legitimate block until proved/configured; diagnostics must identify the predicate, not silently approve it.
- Initial repairs needed no schema migration. The reproduced missing LIVE inbox/receipt requires an additive LAB2 table; reconcile its new timestamp and binary compatibility first, never edit applied migrations. Broker retains its existing tables.

## Review focus

1. Callback ACK/queued cannot look physically sent; delayed status cannot regress READ or replace canonical/provider identity.
2. Multiple UNKNOWNs and physical conversation cycles must not allow a forged or unrelated proof to release old human/bot replies.
3. Readiness must survive lost ACK, missing/corrupt/truncated objects, timeout, restart and revocation, without dropping staged bytes.
4. Minhas remains bounded to membership, supervisor/exclusive policy and ownership; data import does not grant visibility or fire bots.
5. Group diagnostics contain only safe enum codes, and recovery still checks current scope/revisions before any remote operation.

## Task 1 — Broker intent isolation and honest status contract (root)

Files: `apps/api/src/modules/integrations/chatwoot-worker.ts`, `chatwoot-client.ts`, attendance event/store parsing only if required; `apps/api/tests/integration/chatwoot-worker-isolation.test.ts` and focused client/attendance regressions.

- [x] Reproduce blocked new reply with real PostgreSQL, asserting old UNKNOWN unchanged and zero duplicate outbox rows.
- [x] Add the smallest positive-proof eligibility/revalidation path; keep the predicate identical in both claim queries and legacy paths conservative.
- [x] Add optional versioned `broker_delivery` status receipt to the current PATCH; final states require the actual provider identity, never an enqueue ACK.
- [x] RED→GREEN plus negative tenant, inbox, revision, contact/cycle, bot/private/historical, forged proof and concurrent-worker cases.
- [x] Reproduce/fix the canonical GET cursor incompatibility against real LAB2 Rails; exact ID range preserves stock Chatwoot 3.x/4.x compatibility.

## Task 2 — LAB2 durable intent and presentation (LAB2 worker)

Files: native durable webhook obligation, broker status receipt service/controller, MessageMeta/progress helpers and existing specs/components. Preserve API-inbox compatibility.

- [x] Capture PENDING evidence transactionally with the outgoing obligation and stable intent identity. Duplicate capture/rollback cannot create a new send.
- [x] Consume an additive optional receipt only in the bound context; preserve legacy external API behavior and monotonic final status.
- [x] Reproduce visibility filters and keep authoritative bot/exclusive/supervisor controls intact. Do not bulk clear legacy ownership.
- [x] Rails and frontend regression with synthetic records; history imports remain silent.

## Task 3 — Group/policy diagnostics (group worker)

Files: group scope store/helper, group worker and `whatsapp-group-central.test.ts`.

- [x] RED for unselected/expired/unverified/webhook scope failures with zero remote calls/maps.
- [x] Preserve normative guard and original error; persist a safe discriminated blocker so recovery can be configured accurately.
- [x] Confirm history V2 never falls back to live. Do not infer a missing historical fallback from an unproved path.
- [x] Receive live group media through the existing private store, preserving participant and full caption; scoped reads, retry, idempotency and unknown POST barrier tested.

## Task 3b — Complete the explicit human GROUP media path

The user requests messages/media in both directions. The approved history/group design requires explicit group identity and media/participant integrity; never route a group through the individual-contact dispatcher. Read-only assessment found TEXT-only barriers in group reply parsing, human authority, group runtime, provider adapter and fleet port.

- [x] Record the narrow additive contract before editing; keep TEXT compatible and require a canonical durable human intent for media attachments.
- [x] Add private/idempotent attachment registration and preparation with current tenant/channel/group/ownership scope before the provider operation.
- [x] Add explicit GROUP media ports in runtime/fleet/provider using the pinned engine's existing media operation; never weaken numeric individual validation or change the productive engine.
- [x] RED→GREEN for all layers, duplicate callbacks/restart, current scope revocation, actual correlated provider ACK, and UNKNOWN without blind replay.
- [x] Independent security/compatibility review and focused integration acceptance. A real WhatsApp group/session remains a separate operational gate.

## Task 4 — Physical media custody (media worker)

Files: `durable-private-media.ts`, corresponding integration tests and narrowly affected storage regressions.

- [x] RED: HTTP PUT ACK with absent/corrupt/truncated/stalled GET must not mark READY or discard staging.
- [x] Reuse the physical inspection path before READY; retry inspection without issuing an uncertain second PUT.
- [x] GREEN with real isolated PG and HTTP/filesystem storage; preserve other tenant, checksum, KEEP, restart and idempotency invariants.

## Task 5 — Integrated verification and handoff (root)

- [ ] Run relevant PostgreSQL/Redis/MinIO/Rails HTTP/Sidekiq E2E harnesses using independent synthetic IDs and byte hashes.
- [ ] Exercise both directions, group/media, lost ACK, duplicate callback, restart/concurrency and exact inbox/Minhas membership.
- [ ] Run typecheck, builds where supported, frontend/Rails regressions and `npm test` excluding the explicitly out-of-scope backup/recovery operational tests; document every failure/skip.
- [ ] Review security/compatibility diff, update checkpoints and record exact RED/GREEN counts, remaining operational blocks and next verifiable step. User requested GitHub Actions verification on16/11: push only the test candidate; no automatic merge/image publication/deploy.

## Execution ledger

- 2026-11-16: Both main refs unchanged relative to preserved bases; isolated branches created. Production diagnostic exists separately and is not committed because it contains internal operational metadata.
- 2026-11-16: Native local PostgreSQL on loopback verified with SELECT 1. All tests must create their own temporary database through the repository fixture, never mutate a preexisting customer database.
- Ruling: do not activate history capture or erase old bot authority merely to make the list match a screenshot. The acceptance inventory remains source-ID based and reports unavailable history explicitly.
- Verification: Broker regular suite4395/577 passed; build/tsc passed; final HTTP/canonical units96/6 passed. Group media30 PG and25 unit passed. Initial PG170/171 exposed a real claim race, then deterministic RED/GREEN and54/54 relevant PG passed. Full suite started before the last deltas; focused later runs cover those deltas, rather than claiming a new complete run.
- Real local HTTP acceptance: live human intent/outbox/provider-stub ACK/receipt across2 Rails Accounts passed; history/private MinIO/real Sidekiq passed with12 messages/8 files and exact source-ID/hash/inbox reconciliation. Host/operational E2E still running at this ledger update.
- No production modifications, credentials, phone sends, replay or migrations. Test-only Ruby3.4.4 compatibility does not replace exact3.4.12 image acceptance.

## Task 6 — Close the reproduced LIVE receive-receipt gap

Contract: `docs/implementation/live-ingress-receipt-v1-20261116.md`. This fulfills the accepted durability/idempotent-inbox requirement; history remains silent and stock Chatwoot retains generic compatibility.

- [x] LAB2 normal LIVE message + immutable scoped receipt in one PostgreSQL transaction; exact repeat returns same identity, conflict rejects.
- [x] Private media custody stays pending until hash-verified physical bytes; durable recovery covers missing enqueue/crash.
- [x] Broker records native protocol/hash before dispatch; exact receipt read can confirm a lost ACK without another POST or editable-marker proof.
- [x] Individual/group reconciliation respects current identity/ownership/credentials; no blind generic fallback after native selection.
- [ ] RED/GREEN and real local Rails/PostgreSQL/MinIO E2E with two Accounts, loss/crash, concurrency, files and negative isolation cases.
