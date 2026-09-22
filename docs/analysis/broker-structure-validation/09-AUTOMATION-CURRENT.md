# 09 — Automation atual (legado)

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Migration 0024/0025 e `modules/flows` implementam definitions, versions, sessions, runs, outputs, bindings diretos/Chatwoot, simulator, validator, import/export, library e publish. Nodes: start, message, input, menu, condition, variable, handoff e end possuem contrato, executor e testes.

O runtime legado permanece atrás de flag e rota `/legacy/flows`; `/flows` redireciona ao Studio V2 quando habilitado. Migration 0029 e `automations/legacy-migration.ts` oferecem conversão, drain, cutover e rollback com testes.

**CODE_STATUS: LEGACY. TEST_STATUS: PASS.** Reutilizar importador e dados durante a migração; não adicionar novas capacidades ao legado.
