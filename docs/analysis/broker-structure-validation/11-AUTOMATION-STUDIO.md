# 11 — Automation Studio

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Rotas alvo existem em `apps/web/src/app/App.tsx`. `pages/AutomationStudio.tsx` implementa lista, editor/canvas, catálogo, conexões, typed inspector, validação, simulação, publicação, versões, execuções, timeline/drawer e tratamento de 409/5xx. Testes de componente e E2E cobrem navegação, erro e comportamento principal.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS.** Acessibilidade por teclado e foco possuem cobertura básica; testes visuais extensivos e edição touch avançada são PARTIAL. O Studio é JRC; Typebot/n8n aparecem somente como formatos de importação, sem runtime externo.
