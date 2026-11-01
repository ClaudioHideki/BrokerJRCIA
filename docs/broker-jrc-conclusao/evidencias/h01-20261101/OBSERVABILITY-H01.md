# H01 - scoped Chatwoot health

Date: 2026-11-01. Local development only. No production queries, sends, queue mutations, migrations of deployed databases, commits, pushes or deployment performed by this work item.

## Change

- `apps/api/src/modules/observability/service.ts`: count active degradation by joining `chatwoot_connections` and `chatwoot_connection_health`, restricted to READY bindings in the authenticated organization.
- READY bindings with missing observations produce UNKNOWN. An approved destination without any READY bindings also produces UNKNOWN (`CHATWOOT_NO_ACTIVE_BINDINGS`).
- Preserve the existing `CHATWOOT.metric` contract: approved destinations, unit `destinations`. Its new `metricScope` and `metricSource` distinguish that number from binding health. `bindingCounts` exposes active, degraded and unobserved counts.
- Add explicit disabled-binding total and health-error metrics, plus disabled PENDING/RUNNING backlog, FAILED and UNKNOWN counts. Missing new repository metrics yield UNKNOWN without a zero metric.
- Keep the existing all-binding FAILED and UNKNOWN totals unchanged. Metadata declares `ALL_RETAINED_HISTORY`; no recent cutoff exists. Snapshot does not mutate jobs.

New component keys: `CHATWOOT_DISABLED_BINDINGS`, `CHATWOOT_DISABLED_HEALTH`, `DISABLED_INTEGRATION_BACKLOG`, `DISABLED_INTEGRATION_FAILURES`, `DISABLED_INTEGRATION_UNCERTAINTY`.

`CHATWOOT_DISABLED_BINDINGS` is an informational count with UP state. Recorded errors/backlog on disabled bindings retain explicit DEGRADED components; they do not change the active `CHATWOOT` component but still affect `overall`. Existing all-history failures and uncertainty also remain DEGRADED. Active destination health is not a claim that retained historical incidents are resolved.

## TDD and validation

All commands used `C:\Program Files\nodejs\node.exe` and repository-local `node_modules/vitest/vitest.mjs`. Tests used an explicitly supplied `TEST_DATABASE_ADMIN_URL` pointing exclusively to the new disposable PostgreSQL at localhost:15439. Existing helpers created a random `jrc_test_*` database, ran the repository's full migrations and read snapshots with a direct `jrc_app` connection and tenant transaction/RLS. Databases were disposed afterward. Fixtures use synthetic tenants and `.example.test` addresses.

1. `run --config vitest.integration.config.ts apps/api/tests/integration/observability.test.ts --maxWorkers=1`: initial RED, 4/4 expected assertion failures. Disabled health produced 1 degraded instead of 0; PENDING/FAILED/UNKNOWN binding health produced 6 instead of 3. Evidence: `observability-pg-red.log`.
2. Unit RED, 3 expected failures / 6 existing passes: missing observation was green; scope/history metadata and disabled diagnostic components absent. Evidence: `observability-unit-red.log`.
3. Follow-up no-active-bindings RED: unit 1 expected failure / 9 passes; PostgreSQL 2 expected failures / 3 passes because active binding count was absent. Evidence: `observability-active-count-unit-red.log`, `observability-active-count-pg-red.log`.
4. Final PostgreSQL GREEN: 5/5 passed, 42.11 seconds, exit 0. Evidence: `observability-pg-green.log`. Covers disabled exclusion; READY error categories; exclusion of non-READY statuses; cross-tenant exclusion; missing observations; no READY binding; 90-day-old failures/UNKNOWN; disabled backlog; unchanged persisted job IDs/statuses.
5. Final unit GREEN: 10/10 passed, exit 0. Evidence: `observability-unit-green.log`. Includes API state/metadata, disabled metric visibility and unavailable metrics not becoming healthy zeroes.
6. `node_modules/typescript/bin/tsc -b --pretty false` passed before the final active-count extension (exit 0, empty log retained as `observability-typecheck-before-active-count.log`). The parent integrates final typecheck/build and full test suite; this earlier run is not claimed as proof for the final combined source.
7. Final scoped `git diff --check -- apps/api/src/modules/observability/service.ts apps/api/tests/unit/observability.test.ts apps/api/tests/integration/observability.test.ts` passed, exit 0.

## Infrastructure failures and limits

Before valid RED assertions, fixture errors were corrected: a UUID/text parameter required an explicit cast; the synthetic tenant's 5-instance quota required a fixture-only increase to 20. The new isolated PostgreSQL initially required SCRAM while the existing integration helper expects an unpassworded `jrc_app` test connection. The parent adjusted only that disposable server's authentication; production was untouched.

One intervening GREEN attempt failed during the 60-second migration setup hook under host memory contention, skipping the assertions. It is not counted as a test pass. A diagnostic 120-second setup allowance was used for the subsequent active-count RED run, then restored to the existing 60-second bound. The final PG GREEN passed under the original bound with serial execution.

This increment does not prove deployed behavior, Chatwoot/WhatsApp reachability, freshness of stored observations, recent incident rates, retention completeness, 900-session capacity, job reconciliation or client homologation. `CURRENT_STATE` describes persisted state collected by the snapshot, not a live remote probe. No arbitrary observation freshness limit or incident cutoff was introduced. Final combined full-suite results belong to the parent run.
