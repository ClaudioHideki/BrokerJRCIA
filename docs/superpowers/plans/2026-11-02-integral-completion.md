# Conclusão integral Broker e LAB2 — execução contínua

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans, TDD, scoped changes and independent review. This is a continuation of the approved specifications, not a replacement for their full scope.

**Goal:** Complete the remaining implementation and verification of Broker JRC and its LAB2 integration, preserving existing data, sessions, contracts and releases.

**Architecture:** Keep the pinned Evolution engine private behind Broker APIs, PostgreSQL durable obligations/outboxes and independent tenant consumers. Extend existing Flow, routing and migration modules; expose real backend capabilities through the existing admin/company interfaces.

**Tech Stack:** Node 24.19 / TypeScript / Fastify / React, PostgreSQL / Redis / MinIO, Rails / Sidekiq / Vue.

**Spec:** Three approved DOCX files, full extracts and requirement matrix in `output/specs-20261102` at workspace root, plus `PROMPT_EXECUCAO_PUBLICACAO_BROKER_JRC_CONVERSAS_20261102.md`. Requirement IDs and incomplete items remain in MATRIZ-DOCUMENTOS-COMPLETA.csv; no removal or reclassification merely to close this plan.

## Baseline confirmed 02/11/2026

- Broker main/production ea7dc741; current implementation starts at PR7 768181b, branch `codex/broker-integral-20261102`.
- LAB2 release/production daae59ec; current implementation starts at PR4 20e56104, branch `codex/lab2-integral-20261102`.
- GitHub PR7 and PR4 remain draft/open, matching local heads. Existing checkouts reused, untracked history and LAB2 CSS/LEGAL changes preserved.
- No redeploy of unchanged releases. New source requires its own review, tests, CI and image evidence before publication.

## Global constraints

- No backup/dump/restore/policies or aggregate commands invoking these routines.
- No real messages, QR pairing, number migration, mass historical replay or production Evolution replacement without the specific authorization/gates applicable to that operation.
- UNKNOWN is an uncertain remote effect, not permission to resend.
- KEEP remains default for media until verified durable custody; ACK is not a substitute for byte integrity.
- Do not discard or overwrite prior work. No reset/clean/force-push.
- Docker memory 3.74 GiB: one heavy lab/build at a time. Synthetic namespaces only; never stop unrelated containers.
- No speculative endpoint, button, capability or proof. Full product completion and external operational acceptance are tracked separately.
- Scoped commits only after tests and diff review. Broker AGENTS requires npm test before commit; do not run ci:verify (out-of-scope restore routine).

## Review focus

1. Crash after a remote effect or COMMIT: correlation survives, no duplicate send and UNKNOWN preserved.
2. Cross-tenant identifier collision/revocation: backend scope enforced even if UI is stale.
3. Untrusted media and HTTP redirects: SSRF restrictions, size/type/checksum/private custody remain enforced.
4. Engine signals and recovery: graceful stop does not lose durable work or attest ownership without proof.
5. Calendar/version/simulation boundaries: no assignment outside policy and no false equivalence of incompatible Flow runtimes.

## Increment 1 — engine artifact/runtime (agent integral_engine_runtime)

Files: integrations/evolution-origin-journal/**, infra/evolution/**, docs/release-integrada-jrc/ENGINE-BUILD-LAB.md.
- [ ] Reproduce missing signal shutdown and startup verification cost on the current artifact.
- [ ] Correct bounded runtime behavior through JRC overlay, preserve source pin and full artifact verification.
- [ ] Explicit isolated schema provisioning, healthy boot, crash/restart and ownership/ACK tests on the final built artifact.
- [ ] Record real Docker outputs and residual production/session gates separately.
Expected: regression RED then GREEN, no capture enabled by unproven receipt/ENV, no production engine alteration.

## Increment 2 — LAB2 connection/distribution journeys (agent integral_lab2_connections)

Files: existing jrc_broker controllers/services/components, jrc_human_assignment, scoped migrations/specs.
- [ ] Calendar/availability/waiting/capacity settings from doc1 connected to actual dispatch and UI.
- [ ] Full connection history with account scope, cursor pagination, filters and append-only auditing.
- [ ] Real connection metadata and permission-aware editing, without replacing unknown values with fabricated suffixes/timestamps.
- [ ] Rails/Vue regressions, two-account scope and responsive/E2E checks.
Expected: configured routing governs future unassigned conversations, existing assigned conversations preserved.

## Increment 3 — complete Flow contracts/runtime/UI (agent integral_broker_flow)

Files: contracts automation*, API automations, web flows/automations and related tests.
- [ ] Reproduce and resolve simulation/event budget versus configured menu attempts.
- [ ] Typed input validation, actual triggers, reentry/concurrency, immutable version execution and equivalent simulation.
- [ ] Execution history/metrics, CRM events and remaining P2/P3 features from the matrix, each with real backend contracts.
- [ ] Preserve legacy runtime compatibility; expose unavailable capabilities honestly until implemented.
Expected: negative and positive contract/runtime/UI regressions; no unsafe code/SQL execution or SSRF relaxation.

## Increment 4 — messaging/media and incident diagnosis (root)

Files: integrations/chatwoot-client/worker, messaging private media, media-custody, contracts and schema/tests as needed.
- [ ] Fresh authorized server read if browser access works; only typed metadata, no payloads/secrets, no replay.
- [ ] Persist bounded stage/HTTP-status/scope metadata for future failures; preserve legacy unknown diagnostics.
- [ ] Close image/text path, signed private URLs, receipt/readback/checksum, unavailability and idempotent recovery using actual isolated components.
- [ ] Campaign source inbox/list selection and delivery-state contract tests without real recipients.
Expected: no false sent/custody status, distinct rejection/unavailable/uncertain outcomes, isolation and no silent deletion.

## Increment 5 — migration Central and NICO eligibility

- [ ] Implement approved staging/mapping/versioning/preview/lots/deduplication/rejections/reprocessing/provenance/delta APIs and UI using existing models.
- [ ] Domain adapters and attachment integrity; reconcile actual identifiers and eligibility of migrated data for NICO.
- [ ] Synthetic full workflows with RBAC/two accounts; real source inventories and acceptance remain explicitly external.

## Increment 6 — complete product journeys, common API and CCLX adapter

- [ ] Reconcile actual router with all admin/company journeys and backend permissions.
- [ ] Complete accessibility/responsiveness/error/empty states, operational health/queues/retry/reconnection dashboards.
- [ ] Common Broker-Chatwoot contracts, standalone authenticated module for external consumers, two independent Chatwoot consumers.
- [ ] OpenAPI/Postman/PDF agree with implemented paths; real CCLX extension/version requires access and permission.

## Increment 7 — full regression/capacity/release

- [ ] Unit, Rails, API/security/OpenAPI, PostgreSQL/Redis/MinIO, failure/concurrency/E2E suites at new exact SHAs.
- [ ] Independent ID reconciliation and measured synthetic stages 50/100/200/400; plan 900 and 50-real-number/30-day pilot separately.
- [ ] Independent review, scoped fixes, CI, compatibility/migrations and approved candidate releases.
- [ ] Evidence matrix/checkpoints/packages updated; do not mark externally unrun acceptance complete.

## Execution ledger

- 02/11: created scoped continuation branches from preserved PR7/PR4 heads; remote main/release/PR heads confirmed unchanged.
- 02/11: current browser tabs enumerated but health reload and tab binding failed with browser.user unavailable. Server incident snapshot is not refreshed; user recovery requested while local implementation continues.
- 02/11, subsequent increment: browser recovered. Read-only production inspection reconfirmed API/web release digests, 436 FAILED/4 UNKNOWN at 22:37 UTC and later 282 group-scope failures. Four UNKNOWN reached SEND_MESSAGE without remote IDs; bounded GET correlation is inconclusive. No replay or production mutation. See SERVIDOR-LEITURA-20261102.md.
- 02/11: real PostgreSQL + MinIO + compiled worker media suite passed 4/4, including private encrypted source, custody, receiver ACK loss, GET outage, retry and KEEP byte readback. This is not a process-crash proof or real WhatsApp homologation. See MIDIA-WORKER-S3-20261102.md.
- 02/11: supervisor candidate engine image built as sha256:9e93d4d51d4e737cba8b55a80e3a42a44bf5835e5ed887f8abde82354a2fbe1f; Linux/provisioned-main gates remain pending. No production engine replacement.
