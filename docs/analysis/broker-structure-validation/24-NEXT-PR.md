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

## Execução em 2026-09-22

**Status:** IMPLEMENTADO E VALIDADO LOCALMENTE.

Foram adicionados `PATCH /v1/channels/:id`, `GET /v1/channels/:id/status`,
`POST /v1/channels/:id/reconnect`, `POST /v1/channels/:id/disconnect`,
`GET /v1/channels/:id/automation` e `PUT /v1/channels/:id/automation`. As operações QR
delegam ao serviço de instâncias; a Meta mantém a fronteira do Embedded Signup; o vínculo
de automação resolve o canal interno da organização e grava a troca em uma única transação RLS.
O detalhe do canal agora expõe atualização de status, reconexão, desconexão, renomeação e
seleção de automações publicadas, respeitando o papel somente leitura do cliente.

Evidências executadas: build e typecheck; 1.208 testes padrão; 254 testes de integração;
teste PostgreSQL específico com duas empresas; 27 E2E aprovados e 5 ignorados pela matriz;
OpenAPI reproduzível; inventário de 176 rotas; submódulo Evolution íntegro; auditoria sem
finding CRITICAL/HIGH aberto e PDF de 19 páginas verificado por rasterização.
