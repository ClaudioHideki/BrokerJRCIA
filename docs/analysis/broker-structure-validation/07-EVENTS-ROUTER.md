# 07 — Canonical Events e Event Router

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Files: `packages/contracts/src/messaging`, `modules/messaging/ingest.ts`, `qr-events.ts`, `automations/service.ts`, destinos Chatwoot. Meta e QR normalizam eventos para o mesmo armazenamento/roteamento tenant-aware; event keys únicas garantem idempotência e propagam correlação, binding de automação e destino.

Eventos de mensagem e canal estão canônicos no domínio. Eventos de lifecycle de automação existem no runtime/observabilidade, embora não estejam todos publicados por uma única classe pública denominada EventRouter.

**CODE_STATUS: PARTIAL. TEST_STATUS: PASS.** Gap: consolidar envelope e catálogo público únicos para todos os eventos de canal, mensagem, automação e destino; comportamento essencial já é reutilizável e não deve ser reescrito.
