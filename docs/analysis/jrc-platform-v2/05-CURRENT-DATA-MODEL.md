# 05 — Modelo de dados atual

| Migração | Entidades | Observação |
| --- | --- | --- |
| 0002 | organizations, users, memberships, sessions, api_keys, audit | identidade tenant e auditoria |
| 0003 | provider_accounts, instances, operations, challenges, idempotency | transporte QR/provider |
| 0009 | messaging_channels/contacts/conversations/messages/events/outbox/bot_jobs | núcleo durável de mensageria |
| 0010–0011 | platform_*, organization_limits/usage | SaaS/Super Admin |
| 0012 | meta_signup_states, meta_connections | onboarding Meta cifrado |
| 0014–0023 | chatwoot_accounts/connections/conversations/messages/jobs/audit/provisioning/media/destinations/control/grants/health/embed | integração humana e controle |
| 0024 | flow_features, flows, flow_versions, flow_sessions, flow_runs, flow_outputs | runtime Flow v1 |
| 0025 | flow_chatwoot_bindings/sessions/events/outbox | transporte Agent Bot |

RLS é aplicada em ondas pelas próprias migrações; as operações tenant usam `withOrganizationTransaction` e papéis dedicados `jrc_app`, `jrc_auth`, `jrc_platform`, `jrc_migrator`.

## Mapa para o alvo

| Atual | Entidade alvo | Ação |
| --- | --- | --- |
| flows | automation_definitions | MIGRATE/compat view |
| flow_versions | automation_versions | MIGRATE |
| flow_sessions | automation_executions/waits | EXTEND |
| flow_runs | automation_node_executions | MIGRATE |
| flow_outputs + messaging_outbox | automation_outbox | REUSE/EXTEND |
| flow_chatwoot_bindings | automation_bindings | MIGRATE |
| flow_chatwoot_events | automation_events | REUSE/EXTEND |
| provider_accounts/instances/meta_connections/messaging_channels | Channel facade | REUSE; sem duplicação |
| integration secrets + control credentials | automation_credentials | EXTEND com vault genérico |

Não criar tabelas na Fase 0. O desenho físico deve manter `organization_id`, RLS, índices de claim e chaves de idempotência.
