# Offline SQL pool inventory preflight

This fills a specific declaration gap in `scripts/operations/capacity-report.mjs`. That report correctly sums **supplied** pools and already accounts for reserves and rollout replicas. An API-only row of 10 can therefore show headroom while one web process also owns its auth pool and, when enabled, its platform pool. This preflight requires explicit process/profile declarations, then delegates all aggregate arithmetic to the existing reporter. No SQL connection, environment lookup, network request, load generator, quota update or runtime configuration write occurs.

```powershell
node --test labs/capacity-pool-budget/preflight.test.mjs
node labs/capacity-pool-budget/example.mjs
```

The example is fixed and wholly synthetic. With maxConnections=30 and reserve=10, the incomplete API-only declaration has +10 headroom. Explicit WEB pools 10+10+4 instead produce -4 and `OVER_BUDGET`. These are planning integers, not measured sockets, hardware capacity or an approved pilot configuration. The example's 50 organizations/connections are labels for a proposed pilot workload; no sessions are started. `capacityValidated` and `sloValidated` remain false.

## Programmatic input

Import `assessPoolInventory(input)` from `preflight.mjs`. Root keys are exactly `schemaVersion: 1`, `maxConnections`, `reservedConnections`, and `processes`. The first two connection dimensions have the same bounded arithmetic limits as capacity-report (max 1,000,000; reserve 0..max). Every following group must occur exactly once, including disabled groups:

| Group | Required pool keys for each enabled replica |
|---|---|
| WEB | API_APP, API_AUTH, API_PLATFORM |
| MESSAGING | MESSAGING_WORKER, MESSAGING_AUTH |
| AUTOMATION | AUTOMATION_WORKER |
| AUTOMATION_IO | AUTOMATION_IO_WORKER |
| SCHEDULER | SCHEDULER_WORKER |
| LIFECYCLE | LIFECYCLE_WORKER |
| PARTNER_EVENTS | PARTNER_EVENTS_WORKER |
| HISTORY_IMPORT | HISTORY_IMPORT_WORKER |
| HISTORY_SOURCE | HISTORY_SOURCE |
| MIGRATOR | MIGRATOR |
| EVOLUTION | EVOLUTION |

Each entry has exactly `{name, replicas, rolloutReplicas, pools}`. Enabled replicas are 1..10,000 and rollout replicas 0..10,000. `rolloutReplicas` means **extra concurrently alive replicas**, not the desired replacement count. A disabled group must explicitly declare `{name, replicas:0, rolloutReplicas:0, pools:{}}`; omitting a group fails with `POOL_INVENTORY_INCOMPLETE`. At least one group must be enabled.

For WEB and MESSAGING, conditional pools API_PLATFORM and MESSAGING_AUTH respectively may explicitly be `null`. Missing keys fail; mandatory pools cannot be null. Pool maxima must be supplied as positive safe integers, never inferred from environment. Runtime-profile guards follow the inspected loader: <=100, except history-import <=8. History-source pools and the migrator client are fixed at 1. Evolution's maximum is a supplied declaration bounded at 1,000,000 for arithmetic; this does not assert or change an engine default. Fractions, unsafe integers, duplicates, unknown/free labels and credential fields are rejected with static errors. The function returns a sanitized copy of declarations and never mutates input.

HISTORY_SOURCE is a **pool group**, not another executable worker. Count every source pool opened by all relevant web/history-worker replicas against the selected PostgreSQL server, using replicas to represent that aggregate count (each pool max=1). EVOLUTION likewise represents all engine database consumers on that server. If they use a separate server, explicitly disable them in this server's report and assess that server separately. MIGRATOR accounts for concurrent migration clients. Reserve connections separately for administration, maintenance commands, PostgreSQL reserved slots and consumers outside this model. Operators must reconcile actual process/source inventory before using the declaration; the preflight cannot discover omitted executables or a false disabled assertion.

## Evidence boundary

`WITHIN_DECLARED_BUDGET` says only that the complete declared model fits max minus reserve during the declared rollout. `OVER_BUDGET` is never silently converted to positive headroom. This library does not approve a deployment or change pool limits. The executable is a finite example, not an arbitrary-input CLI. Its regression suite now runs in CI and the image workflow; that is a code gate, not validation of a real server inventory or release capacity.

No proposed latency/throughput/RAM-per-session/30-day stability SLO is measured here. Pilot50 still requires live inventory, progressive authorized sessions, per-boundary p95/p99, backlog/age/drain, unknown/duplicate/reconnect measurements, disk/WAL/IOPS and recovery gates. Existing runtime quotas and scheduler fairness are separate mechanisms.

Baseline inspected: `apps/api/src/db/pool-budget.ts`, `apps/api/src/db/pools.ts`, worker entrypoints, `apps/api/src/modules/history-import/runtime.ts` (max=1 per source), `apps/api/src/db/migrate.ts` (one Client), capacity-report and its existing tests. Keep the mapping synchronized when new SQL consumers are introduced.
