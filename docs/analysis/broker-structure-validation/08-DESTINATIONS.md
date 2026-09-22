# 08 — Destinations

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Files: migrations 0014–0023; `modules/integrations/chatwoot-*`, `chatwoot-safe-http.ts`, rotas control/embed; webhooks de automação. Chatwoot/JRC Conversas possui account/inbox/credential/status, onboarding, API Inbox, Agent Bot, signed events, idempotência/retry, control facade e embed authorization.

Safe HTTP bloqueia localhost, loopback, RFC1918, link-local, metadata, redirect privado e DNS rebinding; impõe timeout e limite de resposta. Control credentials possuem escopo, expiração/revogação; admin token não vai ao browser e postMessage não concede autoridade.

**CODE_STATUS: PARTIAL. TEST_STATUS: PASS.** CHATWOOT/JRC_CONVERSAS está avançado; WEBHOOK existe para automação. Falta um agregado/CRUD genérico `/v1/destinations` que uniformize tipos e capabilities. Integração real externa: UNKNOWN.
