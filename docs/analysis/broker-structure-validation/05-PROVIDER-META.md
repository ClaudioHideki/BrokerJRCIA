# 05 — Provider Meta

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Files: `modules/meta-onboarding/service.ts`, `graph.ts`, `webhook.ts`, `routes/meta-onboarding.ts`, `meta-webhooks.ts`, `messaging/ingest.ts`, `dispatcher.ts`. Embedded Signup possui state, troca de code, ativos WABA/Phone Number ID, token cifrado, registro/revogação, verificação de webhook, HMAC, ingestão, outbound, mídia e status.

Inbound testado: text, image, audio, video, document, sticker, button, interactive button/list, contacts, location e delivery/read. Templates: listar/sincronizar e envio aprovado com BODY, HEADER texto/mídia e buttons possuem preflight. Criar/editar/submeter template para análise não é uma capacidade completa do Broker.

**CODE_STATUS: PARTIAL. TEST_STATUS: PASS. DEPLOY_STATUS: UNKNOWN.** O core e fixtures passam; falta homologação com app Meta da JRC, ativos autorizados e webhooks públicos, além do ciclo autoral completo de templates se permanecer no escopo do produto.
