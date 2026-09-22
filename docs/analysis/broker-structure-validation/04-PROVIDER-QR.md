# 04 — Provider QR / Evolution

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Files: `modules/instances/service.ts`, `instances/challenges.ts`, `messaging/qr-service.ts`, `messaging/qr-events.ts`, provider adapter e rotas de instância/canais. Há criação, challenge/TTL, QR no-store, pairing, identidade esperada/observada, status, reconnect/disconnect, webhook, idempotência, lock, mídia e auditoria. Credenciais ficam no servidor e estado de autenticação não é exposto.

Testes simulados cobrem criação, QR, pairing, conectado, desconexão, concorrência, idempotência, identity match/mismatch, expiração e redaction; E2E cobre criação→pair→status→disconnect. Resultado: PASS. Nenhum aparelho ou número real foi usado.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS. DEPLOY_STATUS: UNKNOWN.** Limitação: compatibilidade real e reconexão de longo prazo com aparelho autorizado ainda exigem homologação; a implementação se apoia no Evolution como provider externo, não como núcleo do produto.
