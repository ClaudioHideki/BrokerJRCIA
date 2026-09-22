# 16 — Backup / Restore

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

`scripts/operations/backup.mjs`, `restore.mjs`, runbook Dokploy e `restore-drill.mjs` cobrem PostgreSQL Broker/Evolution, configuração e volume de sessão, AES-256-GCM, manifesto/checksums, retenção e restauração. Drill isolado restaurou duas organizações, uma sessão, RLS e papel NOBYPASSRLS: PASS (backup 3.513 ms; restore 5.825 ms).

Redis é efêmero. Rollback de aplicação usa digest anterior; migrations exigem estratégia forward-compatible. Dump no mesmo servidor não é considerado DR.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS.** Destino externo/offsite, retenção real, volume de produção e recuperação regional: BLOCKED_EVIDENCE/UNKNOWN até homologação.
