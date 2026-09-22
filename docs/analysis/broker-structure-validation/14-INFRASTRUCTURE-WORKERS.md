# 14 — Infrastructure / Workers

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Dokploy define web, api, messaging-worker, automation-worker, automation-io-worker, scheduler-worker, automation-sandbox, migrate, postgres, redis e evolution. Aplicações usam imagens por digest; Postgres/Redis também estão pinados. Há non-root, cap drop, read-only FS onde compatível, healthchecks, resource limits, restart, networks e migration job único.

Workers paginam organizações, aplicam shard determinístico e orçamento por rodada. PostgreSQL é source of truth; Redis atende rate limit/cache/locks/dispatch efêmero, sem estado durável único identificado.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS. DEPLOY_STATUS: UNKNOWN.** Falta ensaio de capacidade no servidor alvo e verificação efetiva das políticas de rede do Dokploy.
