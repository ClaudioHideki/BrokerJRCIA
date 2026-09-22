# 01 — Teste do baseline

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

| Comando | Resultado | Contagem/observação |
|---|---|---|
| `npm run typecheck` | PASS | exit 0 |
| `npm run build` | PASS | API/TypeScript e Vite produção |
| `npm test` | PASS | 183 arquivos, 1.203 testes |
| `npm run test:integration -- --maxWorkers=1` | PASS | 41 arquivos, 253 testes, PostgreSQL real e Redis |
| `npm run test:e2e` | PASS | 27 aprovados, 5 skips mobile intencionais |
| `npm run openapi:generate` | PASS | contrato sem diff |
| `npm run security:release` | PASS | 170 rotas, zero achados |
| `npm run security:audit:gate` | PASS | zero CRITICAL/HIGH aberto |
| `npm audit --audit-level=high` | PASS | zero vulnerabilidades |
| `npm run test:restore-drill` | PASS | backup 3.513 ms; restore 5.825 ms |
| build + `npm run test:container` | PASS | health/readiness/migration; UID 1000 |
| `npm run db:schema:status` no banco scratch persistente | BLOCKED/PENDING | banco auxiliar não migrado: 0/29; mecanismo read-only reportou corretamente as 29 pendências |
| `git diff --check` | PASS | sem erro |

Migrations foram aplicadas a bancos efêmeros pela suíte e pelo smoke de container; o banco scratch mantido na porta 55432 não é evidência de release e permaneceu deliberadamente sem migrations. Concorrência/idempotência e schema status possuem testes em `apps/api/tests/integration/migrations.test.ts`. Os tempos são locais e não representam SLA.
