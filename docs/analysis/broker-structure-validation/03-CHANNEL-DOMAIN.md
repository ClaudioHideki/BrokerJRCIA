# 03 — Channel Domain

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Capability: fachada canônica de canais. File: `packages/contracts/src/channels/schemas.ts`, `apps/api/src/modules/channels/facade.ts`, `apps/api/src/http/routes/channels.ts`. O contrato agrega provider, identity e estados de transporte/provider/automação/destino/health, com autorização tenant e erros normalizados. Testes: unitários, HTTP, integração e E2E de criação/QR/status. Resultado: PASS.

Rotas exatas existentes: GET/POST `/v1/channels`, GET `/v1/channels/:id`, POST `pair`, PUT `destination`. Operações equivalentes de status/reconnect/disconnect continuam em APIs de instância/messaging; PATCH de canal e GET/PUT automation não estão completos na fachada.

**CODE_STATUS: PARTIAL. TEST_STATUS: PASS.** Desenvolvimento: consolidar os endpoints equivalentes na fachada sem remover as rotas legadas durante a migração. UI `/channels` já é canônica; `/providers` e `/conexoes` redirecionam.
