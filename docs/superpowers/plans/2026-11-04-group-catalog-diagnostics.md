# Safe group catalog failure diagnostics

**Goal:** Attribute catalog refresh failures to CAPTURE, IDENTITY_BEFORE, CATALOG, IDENTITY_AFTER, ENGINE_REVALIDATION or COMMIT without changing refresh behavior.

**Approved scope:** Root task, 2026-11-04: callback/external sink; no DDL/API, raw errors, bodies, JIDs, URLs, tokens or stacks; preserve errors, cooldown, retry and selection. No commit/push/production; focused tests only due memory limits.

**Design:** Emit a failure-only DTO containing phase, allowlisted safeCode, bounded HTTP status (null when absent), monotonic elapsedMs, generated opaque requestId and internal organization/channel UUIDs. An optional observer is isolated from settlement, including synchronous throws and rejected promises. Both concrete app and integration-runtime compositions pass this DTO to the existing redacted logger. Worker uses the integration runtime. Observation starts after claiming the lease; existing early admission/configuration failures retain their current handling.

- [x] RED: service tests for six failure phases, code/field allowlists, cleanup, observer failures and successful refresh silence: 10 expected failures / 1 baseline pass.
- [x] GREEN: optional observer and phase tracking in service, preserving existing error mapping and cleanup: 11/11 pass.
- [x] HTTP status RED: 21 failures / 6 passes; GREEN: 27/27 pass. Workspace/groups non2xx 401/404/429/500 preserve serialized error shape. Unknown/malformed/getter metadata is excluded.
- [x] Wire concrete app/runtime logger sinks; messaging worker consumes runtime refresh without changing scheduling.
- [x] Focused regressions with one worker / heap256: 10 files, 131 tests pass (43.43s). API + references `tsc -b apps/api --pretty false` with heap192 passed in the admin agent's coordinated build window. Source diff check passed. Full/PG suite remains root CI.

New-test command: `node --max-old-space-size=256 node_modules/vitest/vitest.mjs run apps/api/tests/unit/whatsapp-group-catalog-diagnostics.test.ts packages/providers/tests/evolution-http-status-diagnostics.test.ts --maxWorkers=1 --no-file-parallelism`.

Final focused command: `node --max-old-space-size=256 node_modules/vitest/vitest.mjs run apps/api/tests/unit/whatsapp-group-catalog-diagnostics.test.ts packages/providers/tests/evolution-http-status-diagnostics.test.ts packages/providers/tests/evolution-groups.test.ts packages/providers/tests/evolution-workspace.test.ts packages/providers/tests/evolution-provider-adapter.test.ts packages/providers/tests/evolution-messaging.test.ts apps/api/src/modules/whatsapp-groups/central-discovery.test.ts apps/api/src/modules/whatsapp-groups/automatic-refresh.test.ts apps/api/tests/unit/fastify-logger-redaction.test.ts apps/api/tests/unit/integration-runtime.test.ts --maxWorkers=1 --no-file-parallelism`.

Structured log message: `WHATSAPP_GROUP_CATALOG_REFRESH_FAILED`. Fields are exactly `phase`, `safeCode`, `httpStatus`, `elapsedMs`, `requestId`, `organizationId`, `channelId`. This is diagnostic metadata, not proof that a remote operation was absent. No provider settings, bot, message, selection, identity approval, database schema or public response changes.
