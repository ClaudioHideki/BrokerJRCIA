# 19 — Data Model Gap

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

| Target aggregate | Current tables | Reuse | Migration needed | Risk |
|---|---|---|---|---|
| Platform | organizations/users/memberships/platform_*/limits/api_keys/audit | alta | não imediata | baixo |
| Channel | provider_accounts/instances/messaging_channels/meta_connections | alta | consolidação gradual | médio |
| Messaging | messaging_contacts/conversations/messages/status_events/outbox/media | total | não | baixo |
| Destination | chatwoot_*/integration_jobs | alta | agregado genérico futuro | médio |
| Automation | flow_* legado + automation_* V2 | V2 total | cutover legado 0029 | médio controlado |
| Credential | automation_credentials + stores legados | alta | migração gradual | médio |
| Audit | audit_logs/security_audit/platform_audit/integration_audit | alta | visão consolidada opcional | baixo |

Tabelas tenant possuem organization_id, RLS forçada, chaves/FKs/indexes e unicidade tenant-aware. Versões de automação são imutáveis; metadata de cifra/key version existe. **CODE_STATUS global: IMPLEMENTED com consolidações PARTIAL. TEST_STATUS: PASS.**
