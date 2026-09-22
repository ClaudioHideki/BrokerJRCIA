# 06 — Messaging Core

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Files: migration 0009/0013/0016; `modules/messaging/{repository,service,ingest,dispatcher,worker,media-store}.ts`. Persistem contatos, conversas, mensagens, eventos de status, outbox, jobs de bot e mídia privada. Estados: ACCEPTED, SENDING, SENT, DELIVERED, READ, FAILED e UNKNOWN; transições são monotônicas e side effect incerto não recebe retry cego.

Autorização/RLS, idempotência, ordering, retry, policy/consent, BOT/HUMAN, anexos, failures e reconciliação têm testes unitários e de integração. O contrato inclui organization/channel/conversation/direction/type/payload/provider reference/status/timestamps/correlation.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS.** Limitação: throughput de produção e retenção de mídia precisam ser calibrados em homologação.
