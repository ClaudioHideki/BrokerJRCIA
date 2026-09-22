# 24 — Next PR

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

**Name:** Complete canonical Channel Facade without breaking legacy routes
**Goal:** adicionar PATCH, status, reconnect, disconnect e automation binding sob `/v1/channels/:id/*`, reutilizando services atuais.
**Why now:** é o gap estrutural mais central entre UI canônica e providers; B1 está verde.
**Dependencies:** contratos atuais, ChannelFacade, instance/messaging services.
**Database changes:** nenhuma prevista.
**API/UI:** endpoints/OpenAPI; UI já canônica.
**Tests:** unit, HTTP, PostgreSQL, two-tenant e E2E.
**Security:** RBAC, RLS, idempotência, no-store/redaction.
**Acceptance:** todas as operações alvo passam pela fachada e rotas antigas continuam funcionais.
**Rollback:** remover os adapters novos; nenhum dado migrado.
**Explicitly not included:** providers reais, Destination genérico, novo Studio, deploy.
