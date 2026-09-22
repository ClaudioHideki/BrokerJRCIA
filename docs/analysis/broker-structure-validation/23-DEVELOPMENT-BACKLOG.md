# 23 — Backlog comprovado

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

## EPIC: completar Channel Facade (P1, M)
Current: fachada e UI canônica operantes. Gap: PATCH/status/reconnect/disconnect/automation ainda usam serviços equivalentes dispersos. Development: adapters finos, OpenAPI e redirects; sem reescrever providers. Tests: contrato/HTTP/integration/E2E; rollback mantendo rotas legadas.

## EPIC: contrato genérico Destination (P1, L)
Current: Chatwoot/JRC e webhook maduros. Gap: agregado/CRUD uniforme. Development: facade sobre dados existentes; provável migration pequena somente após desenho. Security: SSRF/scopes/redaction.

## EPIC: homologação providers e operação (P1, L)
Meta app/WABA/webhook, Baileys autorizado, Chatwoot público, IA/DB externos, load/soak, alertas e backup offsite. Depende de credenciais/infra. Sem mudança de schema por padrão.

## EPIC: consolidação de credenciais/observabilidade (P1, M)
Migrar stores legados para referências do vault; exportar métricas/traces/alertas. Rollback por leitura dupla e feature flag.

## EPIC: QA Studio (P2, S)
Testes visuais, touch e acessibilidade ampliados; sem alterar runtime.
