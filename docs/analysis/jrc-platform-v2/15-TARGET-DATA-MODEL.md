# 15 — Modelo de dados alvo

## Agregados

| Alvo | Origem atual | Ação |
|---|---|---|
| `organizations`, memberships, roles | identidade/plataforma existentes | REUSE |
| `channels` | provider accounts + instances + Meta assets | NEW |
| `channel_provider_bindings` | configurações Evolution/Meta | EXTEND |
| `destinations` | integrações Chatwoot | MIGRATE |
| `channel_destination_bindings` | vínculos Chatwoot/control | MIGRATE |
| `automation_definitions` | flows | MIGRATE |
| `automation_versions` | flow versions | REUSE |
| `automation_bindings` | flow bindings | EXTEND |
| `automation_executions` | flow runs | MIGRATE |
| `automation_node_executions` | detalhes de runs | NEW |
| `automation_events`, `automation_waits` | sessões/estado parcial | NEW |
| `automation_outbox` | outbox atual/parcial | EXTEND |
| `automation_credentials` | segredos distribuídos | NEW |
| `automation_webhook_triggers`, `automation_schedules` | ausentes | NEW |
| motor `jrc_flows` | tabelas Rails locais | LEGACY |
| `audit_events` | auditoria existente | EXTEND |

`REMOVE_LATER` aplica-se às estruturas antigas apenas depois de uso zero, reconciliação e release posterior; nenhuma é removida nesta etapa.

## Regras

- Todas as tabelas de negócio carregam `organization_id` ou vínculo verificável até ela.
- Índices únicos incorporam tenant e identificadores externos.
- Credenciais guardam ciphertext, key version e metadados; nunca valor em claro.
- Definições publicadas usam JSON validado e checksum, sem mutação posterior.
- Eventos e logs têm política de retenção e partição quando o volume justificar.

## Migrações

Aplicar modelo expand-and-contract: criar novas estruturas, backfill idempotente, dupla leitura controlada, mudança de escrita, verificação e remoção posterior. Cada migração possui checagem prévia, rollback lógico e métrica de reconciliação. As migrações atuais `0024_flows` e `0025_flow_chatwoot` são base, não precisam ser refeitas.
