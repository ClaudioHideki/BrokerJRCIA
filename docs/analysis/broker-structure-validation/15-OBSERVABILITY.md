# 15 — Observability

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

`/health`, `/ready`, health center, migration/schema status, provider/channel/destination health, heartbeats de workers, filas, outbox age, webhooks, automações FAILED/UNKNOWN e auditoria estão implementados em `modules/observability/service.ts`, migration 0028 e UI `/health`.

Logs estruturados propagam requestId/correlationId. Há métricas operacionais na API/UI; traces distribuídos e alertas externos (Prometheus/OTel/Alertmanager ou equivalente) não estão fechados no repositório.

**CODE_STATUS: PARTIAL. TEST_STATUS: PASS.** Gap P1: exportação padronizada de métricas/traces e alertas no ambiente de homologação.
