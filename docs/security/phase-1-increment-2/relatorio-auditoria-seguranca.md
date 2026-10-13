# Relatório de Auditoria de Segurança — JRC WhatsApp Broker

- Fase: 1
- Incremento: 2 — Console web operacional JRC
- Referência da fonte: `sha256:70a1bf931ab45a00843dab39cd6c57c5971f9360e391156c0cfdc2fd89bc0f17`
- Data de referência: 2026-09-06

## Resumo executivo

A auditoria registrou 1 achado(s) e 13 ponto(s) forte(s). Somente achados CRITICAL ou HIGH com estado OPEN bloqueiam a entrega.

## Escopo e nota metodológica

O escopo cobre console web operacional, sessão de navegador, backend multicliente, PostgreSQL/RLS, autenticação, RBAC, API keys, instâncias, providers, OpenAPI, dependências, histórico Git JRC, bundles compilados e container. Permanecem fora: Meta real, mensageria, mídia, webhooks completos, billing, WhatsApp Calling, chatbot, filas e deploy.

As cinco categorias de apresentação são:

- CRITICAL: comprometimento amplo ou imediato (P1).
- HIGH: impacto grave e explorável (P2).
- MEDIUM: impacto relevante sob condições adicionais (P3).
- LOW: hardening ou impacto limitado (P4).
- STRENGTH: controle positivo comprovado, sem efeito bloqueante.

A evidência combina revisão estática, inventário derivado do OpenAPI, testes automatizados, varredura sanitizada do histórico Git JRC e bundles compilados. INFO é contexto, não uma sexta categoria de achado. O submódulo Evolution é excluído da varredura histórica e validado apenas por pin, origem e fronteira.

Os cinco eixos obrigatórios são isolamento multitenant, autorização não dependente somente do frontend, IDOR, exposição de segredos e inputs inseguros/XSS. Todos são aplicáveis neste incremento e possuem conclusão rastreável.

## Distribuição por severidade

| CRITICAL | HIGH | MEDIUM | LOW | INFO | STRENGTH |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 1 | 0 | 13 |

O PDF apresenta esta distribuição em uma rosca e as evidências por categoria em barras horizontais.

## Pontos fortes

### JRC-STRENGTH-201 — Troca de tenant invalida requests e estado local

O cliente incrementa a geração, aborta requests e executa os purges registrados antes de publicar a organização seguinte. Evidência: `apps/web/src/api/client.ts:222-606`.

### JRC-STRENGTH-202 — Permissões do frontend são somente UX e o servidor permanece autoritativo

O navegador oculta ações incompatíveis com o papel, enquanto o guard Fastify revalida cada permissão no backend. Evidência: `apps/api/src/http/plugins/authorization.ts:52-79`.

### JRC-STRENGTH-203 — Provider accounts e instâncias são resolvidos no tenant ativo

A organização vem da autenticação, a operação usa transação tenant e RLS, e identificadores de outro tenant não são revelados. Evidência: `apps/api/src/modules/provider-accounts/service.ts:95-106`.

### JRC-STRENGTH-204 — Refresh HttpOnly e segredos voláteis no navegador

O refresh usa cookie host-only; access token fica em closure; QR, pairing e API key emitida são eliminados do estado volátil. Evidência: `packages/security/src/browser/cookies.ts:21-56`.

### JRC-STRENGTH-205 — Conteúdo não confiável não vira HTML ou navegação

React mantém escaping padrão e o QR é aceito somente como PNG base64 estrito, sem URL arbitrária nem dangerouslySetInnerHTML. Evidência: `apps/web/src/connections/safe-png.ts:12-40`.

### JRC-STRENGTH-206 — Sessão de navegador valida Origin, CSRF e rotação

Rotas cookie-auth exigem origem exata e CSRF assinado; restore e switch rotacionam refresh com uso único. Evidência: `apps/api/src/http/routes/console-auth.ts:157-210`.

### JRC-STRENGTH-207 — Rate limit distribuído persiste somente chaves HMAC

IP canônico e identidade normalizada são derivados com segredos distintos antes de entrar no Redis. Evidência: `packages/security/src/api-keys/hmac.ts:29-36`.

### JRC-STRENGTH-208 — Logger e E2E rejeitam canários sensíveis

A redaction estrutural cobre headers, cookies e desafios; o teardown falha se credenciais, QR, pairing ou identidade sintética chegarem aos logs. Evidência: `packages/security/src/redaction/logger.ts:157-235`.

### JRC-STRENGTH-209 — Evolution permanece atrás de contratos JRC

O registry separa provider comum e administrativo; a console usa apenas rotas JRC e o fake é admitido somente no runtime de teste. Evidência: `packages/providers/src/registry.ts:42-56`.

### JRC-STRENGTH-210 — Intenções mutáveis são opacas, voláteis e reutilizadas com segurança

A UI preserva a mesma chave somente para retry incerto e cria outra após nova intenção; leases impedem duplicação concorrente no backend. Evidência: `apps/web/src/connections/use-volatile-intent.ts:11-28`.

### JRC-STRENGTH-211 — Dependências e browser de teste são fixados no lockfile

CI usa npm ci, Node fixo, Playwright fixado, audit bloqueante para vulnerabilidades HIGH ou CRITICAL e um gate que confere os avisos das dependências distribuídas no browser. Evidência: `.github/workflows/ci.yml:55-124`.

### JRC-STRENGTH-212 — Contrato e inventário derivam da composição real

O OpenAPI é gerado deterministicamente pela aplicação e cada operação possui política explícita no inventário de segurança. Evidência: `apps/api/src/http/openapi.ts:178-186`.

### JRC-STRENGTH-213 — Runtime imutável, mínimo e não-root

A imagem fixa Node por tag e digest, separa build/runtime e executa o entrypoint compilado como usuário node. Evidência: `infra/app/Dockerfile:1-45`.

## Pontos fracos

- **JRC-SEC-201 [LOW/OPEN]** — Enforcement final de CSP e Permissions-Policy depende da camada de publicação

## Tabela de achados

| ID | Categoria | Severidade | Estado | Arquivo | Linhas |
| --- | --- | --- | --- | --- | ---: |
| JRC-SEC-201 | INPUTS_XSS | LOW | OPEN | `docs/operations/web-console.md` | 29–45 |

## Prioridades

- P4 — JRC-SEC-201: Enforcement final de CSP e Permissions-Policy depende da camada de publicação

## Inventário de rotas

| Método | Rota | Autenticação | Permissão | Tenant/RLS | Ownership | Handler |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/hooks/{token}` | OPAQUE_TOKEN_OPTIONAL_HMAC_TIMESTAMP | ACTIVE_BOUND_AUTOMATION | SIM | SECURITY_DEFINER_HASH_LOOKUP_THEN_RLS_ORGANIZATION | `apps/api/src/http/routes/automation-webhooks.ts:17` |
| GET | `/v1/api-keys` | JWT_OR_JRC_API_KEY | api_keys:manage | SIM | RLS_ORGANIZATION_FILTER | `apps/api/src/http/routes/api-keys.ts:136` |
| POST | `/v1/api-keys` | JWT_OR_JRC_API_KEY | api_keys:manage | SIM | ACTIVE_ORGANIZATION_CONTEXT | `apps/api/src/http/routes/api-keys.ts:118` |
| DELETE | `/v1/api-keys/{id}` | JWT_OR_JRC_API_KEY | api_keys:manage | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID | `apps/api/src/http/routes/api-keys.ts:153` |
| POST | `/v1/attendance/conversations/{id}/resume` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_OWNER_CONTROL_BINDING_DESTINATION_CREDENTIAL_REVISIONS_REMOTE_CONFIRMATION | `apps/api/src/http/routes/attendance-resume.ts:28` |
| GET | `/v1/attendance/conversations/{id}/resume-context` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CONVERSATION_OPERATION | `apps/api/src/http/routes/attendance-resume.ts:31` |
| GET | `/v1/attendance/local-channels` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CHANNEL_ACTIVE_NO_CENTRAL_AUTHORITY | `apps/api/src/http/routes/attendance-local.ts:38` |
| GET | `/v1/attendance/local-channels/{channelId}/catalog` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_ACTIVE_LOCAL_IDENTITIES | `apps/api/src/http/routes/attendance-local.ts:52` |
| GET | `/v1/attendance/local-channels/{channelId}/queue` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_CURRENT_ACTOR_LOCAL_CHANNEL_NO_CENTRAL_AUTHORITY | `apps/api/src/http/routes/attendance-local.ts:54` |
| POST | `/v1/attendance/local-conversations/{conversationId}/assignment` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_SELF_CLAIM | SIM | RLS_CURRENT_ACTOR_LOCAL_SESSION_CURRENT_TARGET_NO_RESUME | `apps/api/src/http/routes/attendance-local.ts:56` |
| GET | `/v1/attendance/local-teams` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_ACTIVE_LOCAL_IDENTITIES | `apps/api/src/http/routes/attendance-local.ts:44` |
| POST | `/v1/attendance/local-teams` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_ACTIVE_LOCAL_MEMBER_IDENTITIES | `apps/api/src/http/routes/attendance-local.ts:46` |
| PUT | `/v1/attendance/local-teams/{teamId}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_ACTIVE_LOCAL_MEMBER_IDENTITIES | `apps/api/src/http/routes/attendance-local.ts:48` |
| PUT | `/v1/attendance/local-teams/{teamId}/members` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_ACTIVE_LOCAL_MEMBER_IDENTITIES | `apps/api/src/http/routes/attendance-local.ts:50` |
| GET | `/v1/attendance/resume-operations/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CONVERSATION_OPERATION | `apps/api/src/http/routes/attendance-resume.ts:30` |
| POST | `/v1/auth/login` | NONE | NOT_APPLICABLE_PRE_AUTH | NÃO | NOT_APPLICABLE_PRE_AUTH | `apps/api/src/http/routes/auth.ts:148` |
| POST | `/v1/auth/logout` | REFRESH_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_FAMILY_BOUND | `apps/api/src/http/routes/auth.ts:246` |
| POST | `/v1/auth/refresh` | REFRESH_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_TENANT_BOUND | `apps/api/src/http/routes/auth.ts:223` |
| POST | `/v1/auth/select-organization` | SELECTION_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | SELECTION_TOKEN_MEMBERSHIP_REVALIDATED | `apps/api/src/http/routes/auth.ts:192` |
| POST | `/v1/automation-imports` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMPORT_ARTIFACT | `apps/api/src/http/routes/automation-imports.ts:22` |
| POST | `/v1/automation-imports/preview` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | CURRENT_ORGANIZATION_IMPORT_PREVIEW_ONLY | `apps/api/src/http/routes/automation-imports.ts:21` |
| GET | `/v1/automation-nodes` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | STATIC_EXECUTABLE_NODE_CATALOG | `apps/api/src/http/routes/automations.ts:32` |
| GET | `/v1/automations` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:33` |
| POST | `/v1/automations` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:43` |
| GET | `/v1/automations/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:44` |
| PUT | `/v1/automations/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:51` |
| POST | `/v1/automations/{id}/archive` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_LOCKED_DEFINITION_BINDINGS_EXECUTIONS_AUDIT | `apps/api/src/http/routes/automations.ts:55` |
| GET | `/v1/automations/{id}/bindings` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:57` |
| POST | `/v1/automations/{id}/bindings` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:58` |
| PATCH | `/v1/automations/{id}/bindings/{bindingId}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:59` |
| GET | `/v1/automations/{id}/http-credentials` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTHORIZED_ROOT_ACTIVE_HTTP_METADATA | `apps/api/src/http/routes/automations.ts:45` |
| POST | `/v1/automations/{id}/publish` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:54` |
| POST | `/v1/automations/{id}/simulate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:53` |
| GET | `/v1/automations/{id}/subflow-catalog` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTHORIZED_ROOT_PUBLISHED_VERSION_METADATA | `apps/api/src/http/routes/automations.ts:48` |
| POST | `/v1/automations/{id}/validate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:52` |
| GET | `/v1/automations/{id}/versions` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:56` |
| GET | `/v1/automations/migrations/legacy` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:38` |
| POST | `/v1/automations/migrations/legacy` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:39` |
| POST | `/v1/automations/migrations/legacy/{id}/cutover` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:40` |
| POST | `/v1/automations/migrations/legacy/{id}/rollback` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:41` |
| GET | `/v1/automations/status` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:31` |
| GET | `/v1/channels` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID | `apps/api/src/http/routes/channels.ts:87` |
| POST | `/v1/channels` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_PROVIDER_ACCOUNT_AND_CHANNEL | `apps/api/src/http/routes/channels.ts:110` |
| GET | `/v1/channels/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID | `apps/api/src/http/routes/channels.ts:96` |
| PATCH | `/v1/channels/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID | `apps/api/src/http/routes/channels.ts:102` |
| POST | `/v1/channels/{id}/archive` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_DISCONNECTED_INSTANCE_PENDING_WORK_GUARD_AUDIT | `apps/api/src/http/routes/channels.ts:95` |
| GET | `/v1/channels/{id}/automation` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID | `apps/api/src/http/routes/channels.ts:140` |
| PUT | `/v1/channels/{id}/automation` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_CHANNEL_AUTOMATION_AND_VERSION | `apps/api/src/http/routes/channels.ts:144` |
| GET | `/v1/channels/{id}/central-operation` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_APPROVED_ACCOUNT_DESTINATION_OPERATION_NO_SECRET_RESPONSE | `apps/api/src/http/routes/channels.ts:67` |
| POST | `/v1/channels/{id}/deletion` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | EXACT_NAME_CURRENT_ACTOR_DATABASE_AUTHORIZATION_AND_WORK_FENCE | `apps/api/src/http/routes/channels.ts:78` |
| GET | `/v1/channels/{id}/deletion-preview` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | ORGANIZATION_RESOURCE_OPERATION_SCOPE | `apps/api/src/http/routes/channels.ts:75` |
| GET | `/v1/channels/{id}/deletion/{operationId}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | ORGANIZATION_RESOURCE_OPERATION_SCOPE | `apps/api/src/http/routes/channels.ts:82` |
| POST | `/v1/channels/{id}/deletion/{operationId}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | CURRENT_ACTOR_ORGANIZATION_RESOURCE_OPERATION_EXTERNAL_STATE_RECHECK | `apps/api/src/http/routes/channels.ts:71` |
| PUT | `/v1/channels/{id}/destination` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_CHANNEL_ACCOUNT_AND_INBOX | `apps/api/src/http/routes/channels.ts:148` |
| POST | `/v1/channels/{id}/disconnect` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/channels.ts:133` |
| GET | `/v1/channels/{id}/operation-profile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_CANONICAL_CHANNEL_ORIGIN_ACCOUNT_INBOX_CREDENTIAL_REVISION_OBSERVATION_NOT_AUTHORIZATION | `apps/api/src/http/routes/channels.ts:99` |
| POST | `/v1/channels/{id}/pair` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/channels.ts:117` |
| POST | `/v1/channels/{id}/reconnect` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/channels.ts:125` |
| GET | `/v1/channels/{id}/status` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/channels.ts:106` |
| GET | `/v1/channels/{id}/whatsapp-group-automation` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_CURRENT_ACTOR_CHANNEL_GROUP_IDENTITY_BINDING_VERSION_NO_CLIENT_SCOPE | `apps/api/src/http/routes/whatsapp-groups.ts:94` |
| PUT | `/v1/channels/{id}/whatsapp-group-automation` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_CHANNEL_GROUP_FRESH_NUMBER_SUPPORTED_PUBLISHED_VERSION | `apps/api/src/http/routes/whatsapp-groups.ts:97` |
| POST | `/v1/channels/{id}/whatsapp-group-automation/dispatch-attempts/{attemptId}/abandon` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_CHANNEL_GROUP_STORED_ATTEMPT_UNKNOWN_ONLY | `apps/api/src/http/routes/whatsapp-groups.ts:109` |
| POST | `/v1/channels/{id}/whatsapp-group-automation/observations/{observationId}/abandon` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_CHANNEL_GROUP_STORED_OBSERVATION_NO_ACTIVE_DISPATCH | `apps/api/src/http/routes/whatsapp-groups.ts:114` |
| POST | `/v1/channels/{id}/whatsapp-group-automation/pause` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_CHANNEL_GROUP_CANONICAL_EXECUTION | `apps/api/src/http/routes/whatsapp-groups.ts:101` |
| POST | `/v1/channels/{id}/whatsapp-group-automation/resume` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_CHANNEL_GROUP_SAME_INITIATOR_IMMUTABLE_VERSION | `apps/api/src/http/routes/whatsapp-groups.ts:105` |
| GET | `/v1/channels/{id}/whatsapp-group-events-configuration` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_CURRENT_ACTOR_CHANNEL_INSTANCE_BINDING_IDENTITY_CONFIGURATION_REVISIONS | `apps/api/src/http/routes/whatsapp-groups.ts:120` |
| GET | `/v1/channels/{id}/whatsapp-groups` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_CURRENT_ORGANIZATION_LOCKED_CHANNEL_INSTANCE_ACTIVE_MEMBER | `apps/api/src/http/routes/whatsapp-groups.ts:123` |
| POST | `/v1/channels/{id}/whatsapp-groups/refresh` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CHANNEL_NUMBER_SNAPSHOT_NO_SEND_OR_BOT | `apps/api/src/http/routes/whatsapp-groups.ts:128` |
| PUT | `/v1/channels/{id}/whatsapp-groups/selection` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_LOCKED_CHANNEL_ITEM_AUDITED_NO_SEND_OR_BOT | `apps/api/src/http/routes/whatsapp-groups.ts:131` |
| GET | `/v1/channels/central/inboxes` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_APPROVED_ACCOUNT_DESTINATION_OPERATION_NO_SECRET_RESPONSE | `apps/api/src/http/routes/channels.ts:60` |
| GET | `/v1/channels/central/inboxes/{inboxId}/preview` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_APPROVED_ACCOUNT_DESTINATION_OPERATION_NO_SECRET_RESPONSE | `apps/api/src/http/routes/channels.ts:61` |
| GET | `/v1/channels/central/operations/{operationId}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_APPROVED_ACCOUNT_DESTINATION_OPERATION_NO_SECRET_RESPONSE | `apps/api/src/http/routes/channels.ts:62` |
| POST | `/v1/channels/central/operations/{operationId}/advance` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_OPERATION_ACCOUNT_DESTINATION_CREDENTIAL_REVISIONS_EXACT_REMOTE_IDENTITY | `apps/api/src/http/routes/channels.ts:65` |
| POST | `/v1/channels/central/operations/{operationId}/cancel` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_OPERATION_ACCOUNT_DESTINATION_CREDENTIAL_REVISIONS_EXACT_REMOTE_IDENTITY | `apps/api/src/http/routes/channels.ts:64` |
| POST | `/v1/channels/central/operations/{operationId}/rollback` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_OPERATION_ACCOUNT_DESTINATION_CREDENTIAL_REVISIONS_EXACT_REMOTE_IDENTITY | `apps/api/src/http/routes/channels.ts:66` |
| GET | `/v1/channels/central/operations/by-key/{key}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_APPROVED_ACCOUNT_DESTINATION_OPERATION_NO_SECRET_RESPONSE | `apps/api/src/http/routes/channels.ts:63` |
| POST | `/v1/console/auth/logout` | EXACT_ORIGIN_WITH_OPTIONAL_REFRESH_COOKIE_CSRF | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_FAMILY_WHEN_PRESENT | `apps/api/src/http/routes/console-auth.ts:386` |
| POST | `/v1/console/auth/restore` | REFRESH_COOKIE_CSRF_AND_EXACT_ORIGIN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_TENANT_BOUND | `apps/api/src/http/routes/console-auth.ts:342` |
| POST | `/v1/console/auth/select-organization` | SELECTION_TOKEN_AND_EXACT_ORIGIN | NOT_APPLICABLE_PRE_AUTH | NÃO | SELECTION_TOKEN_MEMBERSHIP_REVALIDATED | `apps/api/src/http/routes/console-auth.ts:319` |
| POST | `/v1/console/auth/switch-organization` | JWT_REFRESH_COOKIE_CSRF_AND_EXACT_ORIGIN | ACTIVE_MEMBERSHIP | NÃO | SOURCE_AND_TARGET_MEMBERSHIPS_REVALIDATED | `apps/api/src/http/routes/console-auth.ts:359` |
| GET | `/v1/credentials` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:17` |
| POST | `/v1/credentials` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:18` |
| DELETE | `/v1/credentials/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:22` |
| GET | `/v1/credentials/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:19` |
| PUT | `/v1/credentials/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:20` |
| PUT | `/v1/credentials/{id}/http-policy` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_ACTIVE_HTTP_CREDENTIAL_POLICY_REVISION | `apps/api/src/http/routes/credentials.ts:21` |
| POST | `/v1/credentials/{id}/test` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:23` |
| GET | `/v1/embed/apps/{id}/policy` | PUBLIC_OPAQUE_APP_ID | APPROVED_ORIGIN_ONLY | SIM | SERVER_LOOKUP_RLS_ACTIVE_APP_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:57` |
| POST | `/v1/embed/authorizations` | PUBLIC_CHALLENGE_RATE_LIMITED | START_WITHOUT_AUTHENTICATION_GRANT | SIM | SERVER_LOOKUP_RLS_ACTIVE_APP_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:59` |
| GET | `/v1/embed/authorizations/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_CONNECTION_GRANTS | SIM | RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS | `apps/api/src/http/routes/chatwoot-embed.ts:66` |
| POST | `/v1/embed/authorizations/{id}/approve` | JWT_CSRF_EXACT_ORIGIN | CURRENT_CONNECTION_GRANTS | SIM | RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS | `apps/api/src/http/routes/chatwoot-embed.ts:68` |
| POST | `/v1/embed/authorizations/{id}/deny` | JWT_CSRF_EXACT_ORIGIN | CURRENT_CONNECTION_GRANTS | SIM | RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS | `apps/api/src/http/routes/chatwoot-embed.ts:71` |
| POST | `/v1/embed/authorizations/{id}/exchange` | SHA256_VERIFIER_TIMING_SAFE_RATE_LIMITED | EXPLICIT_APPROVAL_CURRENT_GRANTS | SIM | RLS_APPROVED_UNEXPIRED_REQUEST_USER_GRANTS_IDENTITY | `apps/api/src/http/routes/chatwoot-embed.ts:74` |
| POST | `/v1/embed/connections/{id}/pair` | OPAQUE_SHORT_SESSION_HASH_LOOKUP | SESSION_PAIR_GRANT_APPROVED_IDENTITY | SIM | RLS_CURRENT_SESSION_GRANT_BEFORE_DISPATCH_AFTER_RESPONSE | `apps/api/src/http/routes/chatwoot-embed.ts:89` |
| GET | `/v1/embed/connections/{id}/status` | OPAQUE_SHORT_SESSION_HASH_LOOKUP | SESSION_READ_GRANT_CURRENT_MEMBERSHIP | SIM | RLS_SESSION_ACCOUNT_DESTINATION_CREDENTIAL_IDENTITY_REVISION | `apps/api/src/http/routes/chatwoot-embed.ts:82` |
| GET | `/v1/executions` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:60` |
| GET | `/v1/executions/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:61` |
| POST | `/v1/executions/{id}/cancel` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:62` |
| POST | `/v1/executions/{id}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:64` |
| POST | `/v1/executions/{id}/resume` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:65` |
| POST | `/v1/executions/{id}/retry` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:63` |
| GET | `/v1/flows` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:57` |
| POST | `/v1/flows` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:65` |
| GET | `/v1/flows/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:68` |
| PUT | `/v1/flows/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:69` |
| POST | `/v1/flows/{id}/bind` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:77` |
| POST | `/v1/flows/{id}/chatwoot/bind` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:39` |
| GET | `/v1/flows/{id}/chatwoot/runs` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:43` |
| GET | `/v1/flows/{id}/export` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:70` |
| POST | `/v1/flows/{id}/publish` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:76` |
| GET | `/v1/flows/{id}/runs` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:79` |
| POST | `/v1/flows/{id}/simulate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:80` |
| POST | `/v1/flows/{id}/unbind` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:78` |
| POST | `/v1/flows/{id}/validate` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:73` |
| GET | `/v1/flows/channels` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:58` |
| POST | `/v1/flows/chatwoot/{id}/disable` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:41` |
| POST | `/v1/flows/chatwoot/{id}/events` | HMAC_TIMESTAMP_RAW_BODY | BOUND_AGENT_BOT | SIM | RLS_ACCOUNT_INBOX_DESTINATION_CREDENTIAL_FEATURE_REVISION | `apps/api/src/http/routes/flows.ts:47` |
| POST | `/v1/flows/chatwoot/{id}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:42` |
| GET | `/v1/flows/chatwoot/inboxes` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:38` |
| POST | `/v1/flows/import-preview` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:62` |
| GET | `/v1/flows/library` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:59` |
| GET | `/v1/flows/status` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:56` |
| GET | `/v1/instances` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_FILTER_AND_TENANT_CURSOR | `apps/api/src/http/routes/instances.ts:152` |
| POST | `/v1/instances` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_PROVIDER_ACCOUNT_AND_ORGANIZATION | `apps/api/src/http/routes/instances.ts:126` |
| GET | `/v1/instances/{id}` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID | `apps/api/src/http/routes/instances.ts:169` |
| POST | `/v1/instances/{id}/connect` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:183` |
| POST | `/v1/instances/{id}/disconnect` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:229` |
| PUT | `/v1/instances/{id}/settings` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_ACTIVE_ORGANIZATION_AUDITED | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instance-workspace.ts:27` |
| GET | `/v1/instances/{id}/status` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:214` |
| GET | `/v1/instances/{id}/workspace` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instance-workspace.ts:23` |
| GET | `/v1/integrations/chatwoot` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ONLY | `apps/api/src/http/routes/integrations.ts:173` |
| POST | `/v1/integrations/chatwoot/{id}/events` | CHATWOOT_HMAC_TIMESTAMP_RAW_BODY | NOT_APPLICABLE_WEBHOOK | SIM | STORED_BINDING_SIGNATURE_ACCOUNT_INBOX_AND_RLS | `apps/api/src/http/routes/integrations.ts:360` |
| PUT | `/v1/integrations/chatwoot/account` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:191` |
| POST | `/v1/integrations/chatwoot/connections` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:225` |
| DELETE | `/v1/integrations/chatwoot/connections/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:275` |
| PATCH | `/v1/integrations/chatwoot/connections/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:276` |
| GET | `/v1/integrations/chatwoot/connections/{id}/agents` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:237` |
| POST | `/v1/integrations/chatwoot/connections/{id}/agents` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:242` |
| GET | `/v1/integrations/chatwoot/connections/{id}/attendance-catalog` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_CHANNEL_ACCOUNT_INBOX_APPROVED_DESTINATION_CREDENTIAL_REVISION_RECHECK | `apps/api/src/http/routes/integrations.ts:115` |
| GET | `/v1/integrations/chatwoot/connections/{id}/operator-grants` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CONNECTION_MEMBERS_PROJECTION | `apps/api/src/http/routes/chatwoot-control.ts:99` |
| PUT | `/v1/integrations/chatwoot/connections/{id}/operator-grants` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ACTIVE_ORGANIZATION_CURRENT_MEMBERSHIP_AND_CONNECTION | `apps/api/src/http/routes/chatwoot-control.ts:102` |
| POST | `/v1/integrations/chatwoot/connections/{id}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:262` |
| POST | `/v1/integrations/chatwoot/connections/{id}/retry` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:127` |
| POST | `/v1/integrations/chatwoot/control-credentials` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ACTIVE_ORGANIZATION_APPROVED_ACCOUNT | `apps/api/src/http/routes/chatwoot-control.ts:96` |
| PUT | `/v1/integrations/chatwoot/control/connections/{integrationId}/agents` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_VALIDATED_ACCOUNT_AGENTS | `apps/api/src/http/routes/chatwoot-control.ts:78` |
| POST | `/v1/integrations/chatwoot/control/connections/{integrationId}/confirm-identity` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_ADMIN_PROVIDER_OBSERVED_IDENTITY | `apps/api/src/http/routes/chatwoot-control.ts:75` |
| POST | `/v1/integrations/chatwoot/control/connections/{integrationId}/disconnect` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_DISCONNECT | SIM | RLS_CURRENT_CONNECTION_ADMIN_OR_SERVICE | `apps/api/src/http/routes/chatwoot-control.ts:68` |
| POST | `/v1/integrations/chatwoot/control/connections/{integrationId}/pair` | JWT_OR_BOUND_CONTROL_KEY | CHATWOOT_PAIR_AND_FIRST_BINDING_ADMIN | SIM | RLS_CURRENT_CONNECTION_GRANT_AND_PROVIDER_IDENTITY | `apps/api/src/http/routes/chatwoot-control.ts:61` |
| GET | `/v1/integrations/chatwoot/control/connections/{integrationId}/pair-operations/{operationId}` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_PAIR | SIM | RLS_CURRENT_CONNECTION_GRANT_OPERATION_AND_PROVIDER_IDENTITY | `apps/api/src/http/routes/chatwoot-control.ts:53` |
| GET | `/v1/integrations/chatwoot/control/connections/{integrationId}/status` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_READ | SIM | RLS_ACCOUNT_REVISION_CONNECTION_GRANT | `apps/api/src/http/routes/chatwoot-control.ts:50` |
| GET | `/v1/integrations/chatwoot/control/context` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_READ | SIM | RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION | `apps/api/src/http/routes/chatwoot-control.ts:36` |
| GET | `/v1/integrations/chatwoot/control/onboarding` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_CURRENT_ACCOUNT_REVISION_OPERATIONS | `apps/api/src/http/routes/chatwoot-control.ts:43` |
| POST | `/v1/integrations/chatwoot/control/onboarding` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION | `apps/api/src/http/routes/chatwoot-control.ts:81` |
| GET | `/v1/integrations/chatwoot/control/onboarding/{operationId}` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_READ | SIM | RLS_ACTIVE_ORGANIZATION_OPERATION_AND_INTEGRATION_GRANT | `apps/api/src/http/routes/chatwoot-control.ts:87` |
| POST | `/v1/integrations/chatwoot/control/onboarding/{operationId}/recover` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION | `apps/api/src/http/routes/chatwoot-control.ts:90` |
| GET | `/v1/integrations/chatwoot/control/resources` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_SANITIZED_AVAILABLE_QR_RESOURCES | `apps/api/src/http/routes/chatwoot-control.ts:40` |
| GET | `/v1/integrations/chatwoot/destination` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ONLY | `apps/api/src/http/routes/integrations.ts:121` |
| PUT | `/v1/integrations/chatwoot/destination` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_AND_DESTINATION_NOT_IN_USE | `apps/api/src/http/routes/integrations.ts:124` |
| POST | `/v1/integrations/chatwoot/embed-apps` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_APPROVED_CURRENT_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:48` |
| GET | `/v1/integrations/chatwoot/embed-apps/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_APPROVED_CURRENT_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:51` |
| POST | `/v1/integrations/chatwoot/embed-apps/{id}/install` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ACCOUNT_DESTINATION_CREDENTIAL_REVISION_BEFORE_POST | `apps/api/src/http/routes/chatwoot-embed.ts:54` |
| GET | `/v1/integrations/chatwoot/inboxes` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:204` |
| GET | `/v1/integrations/chatwoot/jobs` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ONLY | `apps/api/src/http/routes/integrations.ts:295` |
| POST | `/v1/integrations/chatwoot/jobs/{id}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:148` |
| POST | `/v1/integrations/chatwoot/jobs/{id}/retry` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:303` |
| GET | `/v1/integrations/chatwoot/sources` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:168` |
| GET | `/v1/messaging/channels` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_FILTER | `apps/api/src/http/routes/messaging.ts:374` |
| PATCH | `/v1/messaging/channels/{id}/automation` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_CHANNEL_AND_SERVER_ORIGIN_ALLOWLIST | `apps/api/src/http/routes/messaging.ts:491` |
| GET | `/v1/messaging/channels/{id}/conversations` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CHANNEL_ID | `apps/api/src/http/routes/messaging.ts:426` |
| POST | `/v1/messaging/channels/{id}/messages` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_CHANNEL_CONVERSATION_AND_CONTACT_POLICY_BEFORE_OUTBOX | `apps/api/src/http/routes/messaging.ts:461` |
| GET | `/v1/messaging/channels/{id}/templates` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CHANNEL_ID_BEFORE_META | `apps/api/src/http/routes/messaging.ts:385` |
| POST | `/v1/messaging/channels/{id}/templates` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_CHANNEL_AND_WABA_BEFORE_META | `apps/api/src/http/routes/messaging.ts:410` |
| GET | `/v1/messaging/channels/{id}/templates/{templateId}/status` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_CHANNEL_AND_WABA_BEFORE_META | `apps/api/src/http/routes/messaging.ts:398` |
| POST | `/v1/messaging/channels/{id}/text` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_CHANNEL_CONVERSATION_AND_CONTACT_POLICY_BEFORE_OUTBOX | `apps/api/src/http/routes/messaging.ts:339` |
| GET | `/v1/messaging/conversations/{id}` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ACTIVE_ORGANIZATION_CONVERSATION_AND_CHANNEL | `apps/api/src/http/routes/messaging.ts:452` |
| GET | `/v1/messaging/conversations/{id}/messages` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CONVERSATION_ID | `apps/api/src/http/routes/messaging.ts:439` |
| PATCH | `/v1/messaging/conversations/{id}/mode` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_AND_CONVERSATION_ID | `apps/api/src/http/routes/messaging.ts:509` |
| GET | `/v1/messaging/conversations/{id}/qr-dispatch-attempts` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_CURRENT_ORGANIZATION_CONVERSATION_METADATA_ONLY | `apps/api/src/http/routes/messaging.ts:270` |
| GET | `/v1/messaging/conversations/{id}/qr-outbound-observations` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_CURRENT_ORGANIZATION_CONVERSATION_METADATA_ONLY | `apps/api/src/http/routes/messaging.ts:264` |
| POST | `/v1/messaging/instances/{id}/activate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:322` |
| GET | `/v1/messaging/media/{id}` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ENCRYPTED_MEDIA_ATTACHMENT_ONLY | `apps/api/src/http/routes/messaging.ts:312` |
| POST | `/v1/messaging/messages/{id}/retry` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_AND_SAFE_OUTBOX_STATE | `apps/api/src/http/routes/messaging.ts:288` |
| POST | `/v1/messaging/qr-dispatch-attempts/{id}/abandon` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_OWNER_ADMIN_ATTEMPT_CONVERSATION_MESSAGE_UNKNOWN_NO_PROVIDER_ID_NO_OUTBOX | `apps/api/src/http/routes/messaging.ts:276` |
| POST | `/v1/messaging/qr-outbound-observations/{id}/abandon` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ACTOR_OWNER_ADMIN_OBSERVATION_CONVERSATION_EXACT_UNKNOWN_ATTEMPTS_NO_ACTIVE_DISPATCH | `apps/api/src/http/routes/messaging.ts:282` |
| GET | `/v1/meta-onboarding` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:28` |
| POST | `/v1/meta-onboarding/{id}/refresh` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:32` |
| POST | `/v1/meta-onboarding/{id}/register` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:33` |
| POST | `/v1/meta-onboarding/{id}/revoke` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:31` |
| POST | `/v1/meta-onboarding/complete` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:30` |
| POST | `/v1/meta-onboarding/start` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:29` |
| GET | `/v1/operations/health` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_HEALTH_AND_QUEUES | `apps/api/src/http/routes/observability.ts:12` |
| GET | `/v1/organization/operations` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_LIMITS | `apps/api/src/http/routes/tenant-operations.ts:50` |
| GET | `/v1/organization/overview` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AGGREGATES_NO_CONTENT | `apps/api/src/http/routes/tenant-operations.ts:27` |
| GET | `/v1/platform/auth/config` | NONE | NOT_APPLICABLE_PRE_AUTH | NÃO | PUBLIC_MFA_POLICY_ONLY | `apps/api/src/http/routes/platform.ts:189` |
| POST | `/v1/platform/auth/login` | CONFIGURED_PASSWORD_MODE_EXACT_ORIGIN | PLATFORM_IDENTITY | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:196` |
| POST | `/v1/platform/auth/logout` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | PLATFORM_IDENTITY | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:223` |
| GET | `/v1/platform/auth/session` | PLATFORM_SESSION_COOKIE | PLATFORM_IDENTITY | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:211` |
| GET | `/v1/platform/commercial-plans` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:315` |
| POST | `/v1/platform/commercial-plans` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:317` |
| POST | `/v1/platform/commercial-plans/{id}/versions` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:319` |
| GET | `/v1/platform/group-company-removals/{operationId}` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | CURRENT_PLATFORM_ACTOR_PERSISTED_GROUP_OPERATION | `apps/api/src/http/routes/group-removal.ts:18` |
| GET | `/v1/platform/groups` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_OR_SUPPORT | SIM | PLATFORM_ONLY_RLS_NO_TENANT_ACCESS_AUDITED | `apps/api/src/http/routes/platform.ts:313` |
| POST | `/v1/platform/groups` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | PLATFORM_ONLY_RLS_NO_MEMBERSHIP_PROPAGATION_AUDITED | `apps/api/src/http/routes/platform.ts:325` |
| DELETE | `/v1/platform/groups/{id}` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | CURRENT_PLATFORM_ACTOR_EXPLICIT_DETACH_PRESERVED_COMPANIES_ATOMIC_AUDIT | `apps/api/src/http/routes/platform.ts:333` |
| PATCH | `/v1/platform/groups/{id}` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | CURRENT_PLATFORM_ACTOR_GROUP_REVISION_AND_ATOMIC_AUDIT | `apps/api/src/http/routes/platform.ts:329` |
| POST | `/v1/platform/groups/{id}/company-removal-preview` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | EXPLICIT_COMPANY_SELECTION_EXACT_NAMES_PERSISTED_CHILD_OPERATIONS | `apps/api/src/http/routes/group-removal.ts:10` |
| GET | `/v1/platform/groups/{id}/company-removals` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | CURRENT_PLATFORM_ACTOR_PERSISTED_GROUP_OPERATION | `apps/api/src/http/routes/group-removal.ts:20` |
| POST | `/v1/platform/groups/{id}/company-removals` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | EXPLICIT_COMPANY_SELECTION_EXACT_NAMES_PERSISTED_CHILD_OPERATIONS | `apps/api/src/http/routes/group-removal.ts:12` |
| PUT | `/v1/platform/groups/{id}/organizations` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | PLATFORM_ONLY_RLS_UNIQUE_ORGANIZATION_GROUP_NO_MEMBERSHIP_PROPAGATION_AUDITED | `apps/api/src/http/routes/platform.ts:327` |
| GET | `/v1/platform/groups/{id}/removal-preview` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | CURRENT_PLATFORM_ACTOR_GROUP_SCOPE_PRESERVED_COMPANIES | `apps/api/src/http/routes/platform.ts:331` |
| GET | `/v1/platform/organizations` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:335` |
| POST | `/v1/platform/organizations` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:347` |
| PATCH | `/v1/platform/organizations/{id}` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:357` |
| GET | `/v1/platform/organizations/{id}/channels` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:424` |
| POST | `/v1/platform/organizations/{id}/channels/{channelId}/archive` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:432` |
| POST | `/v1/platform/organizations/{id}/channels/{channelId}/deletion` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | EXACT_NAME_CURRENT_ACTOR_DATABASE_AUTHORIZATION_AND_WORK_FENCE | `apps/api/src/http/routes/platform.ts:289` |
| GET | `/v1/platform/organizations/{id}/channels/{channelId}/deletion-preview` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | DEDICATED_PLATFORM_ROLE_RESOURCE_OPERATION_SCOPE | `apps/api/src/http/routes/platform.ts:286` |
| GET | `/v1/platform/organizations/{id}/channels/{channelId}/deletion/{operationId}` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | DEDICATED_PLATFORM_ROLE_RESOURCE_OPERATION_SCOPE | `apps/api/src/http/routes/platform.ts:292` |
| POST | `/v1/platform/organizations/{id}/channels/{channelId}/deletion/{operationId}/reconcile` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | CURRENT_ACTOR_RESOURCE_OPERATION_EXTERNAL_STATE_RECHECK | `apps/api/src/http/routes/platform.ts:272` |
| GET | `/v1/platform/organizations/{id}/chatwoot` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:470` |
| PUT | `/v1/platform/organizations/{id}/chatwoot/account` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:499` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:533` |
| DELETE | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:651` |
| PATCH | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:652` |
| GET | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:555` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:566` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/reconcile` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:634` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/retry` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:590` |
| POST | `/v1/platform/organizations/{id}/chatwoot/destination/approve` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_AND_DESTINATION_REVISION | `apps/api/src/http/routes/platform.ts:460` |
| GET | `/v1/platform/organizations/{id}/chatwoot/inboxes` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:521` |
| GET | `/v1/platform/organizations/{id}/chatwoot/jobs` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:525` |
| POST | `/v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/reconcile` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:613` |
| POST | `/v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/retry` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:671` |
| POST | `/v1/platform/organizations/{id}/chatwoot/provision` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:690` |
| POST | `/v1/platform/organizations/{id}/chatwoot/provision/reconcile` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:731` |
| POST | `/v1/platform/organizations/{id}/chatwoot/provision/resume` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:711` |
| GET | `/v1/platform/organizations/{id}/chatwoot/sources` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:517` |
| GET | `/v1/platform/organizations/{id}/commercial-plan` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:321` |
| PUT | `/v1/platform/organizations/{id}/commercial-plan` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:323` |
| POST | `/v1/platform/organizations/{id}/deletion` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | EXACT_NAME_CURRENT_ACTOR_DATABASE_AUTHORIZATION_AND_WORK_FENCE | `apps/api/src/http/routes/platform.ts:277` |
| GET | `/v1/platform/organizations/{id}/deletion-preview` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | DEDICATED_PLATFORM_ROLE_RESOURCE_OPERATION_SCOPE | `apps/api/src/http/routes/platform.ts:275` |
| GET | `/v1/platform/organizations/{id}/deletion/{operationId}` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | DEDICATED_PLATFORM_ROLE_RESOURCE_OPERATION_SCOPE | `apps/api/src/http/routes/platform.ts:283` |
| POST | `/v1/platform/organizations/{id}/deletion/{operationId}/reconcile` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | CURRENT_ACTOR_RESOURCE_OPERATION_EXTERNAL_STATE_RECHECK | `apps/api/src/http/routes/platform.ts:269` |
| GET | `/v1/platform/organizations/{id}/memberships` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:364` |
| PUT | `/v1/platform/organizations/{id}/memberships` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:385` |
| GET | `/v1/platform/organizations/{id}/monitor` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:396` |
| POST | `/v1/platform/organizations/{id}/support-acknowledgment` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:413` |
| GET | `/v1/platform/support/tickets` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_OR_SUPPORT | SIM | DEDICATED_PLATFORM_ROLE_FORCED_RLS | `apps/api/src/http/routes/support.ts:49` |
| GET | `/v1/platform/support/tickets/{id}` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_OR_SUPPORT | SIM | DEDICATED_PLATFORM_ROLE_FORCED_RLS | `apps/api/src/http/routes/support.ts:50` |
| PATCH | `/v1/platform/support/tickets/{id}` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN_OR_SUPPORT | SIM | DEDICATED_PLATFORM_ROLE_TICKET_LOCK_REVISION_AND_STATUS_ADMISSION | `apps/api/src/http/routes/support.ts:52` |
| POST | `/v1/platform/support/tickets/{id}/replies` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN_OR_SUPPORT | SIM | DEDICATED_PLATFORM_ROLE_TICKET_LOCK_REVISION_AND_STATUS_ADMISSION | `apps/api/src/http/routes/support.ts:51` |
| POST | `/v1/platform/users/{id}/password-reset` | PLATFORM_SESSION_CSRF_EXACT_ORIGIN | SUPER_ADMIN | SIM | CURRENT_PLATFORM_ACTOR_SIGNED_GLOBAL_USER_CONFIRMATION_ATOMIC_PASSWORD_AUTH_REVOCATION_AND_SAFE_AUDIT | `apps/api/src/http/routes/platform.ts:311` |
| GET | `/v1/platform/users/{id}/password-reset-preview` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN | SIM | CURRENT_PLATFORM_ACTOR_GLOBAL_USER_ALL_MEMBERSHIPS_SIGNED_EXPIRING_CONFIRMATION_AUDITED | `apps/api/src/http/routes/platform.ts:309` |
| GET | `/v1/provider-accounts` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_FILTER_AND_TENANT_CURSOR | `apps/api/src/http/routes/provider-accounts.ts:74` |
| GET | `/v1/support/tickets` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_ORGANIZATION_TICKET_AND_MESSAGES | `apps/api/src/http/routes/support.ts:36` |
| POST | `/v1/support/tickets` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_TICKET_AND_MESSAGES_STATUS_ADMISSION | `apps/api/src/http/routes/support.ts:37` |
| GET | `/v1/support/tickets/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_ORGANIZATION_TICKET_AND_MESSAGES | `apps/api/src/http/routes/support.ts:38` |
| PATCH | `/v1/support/tickets/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_TICKET_AND_MESSAGES_STATUS_ADMISSION | `apps/api/src/http/routes/support.ts:40` |
| POST | `/v1/support/tickets/{id}/replies` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_TICKET_AND_MESSAGES_STATUS_ADMISSION | `apps/api/src/http/routes/support.ts:39` |
| GET | `/v1/webhooks` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_BINDING_CREDENTIAL | `apps/api/src/http/routes/automation-webhooks.ts:14` |
| POST | `/v1/webhooks` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_BINDING_CREDENTIAL | `apps/api/src/http/routes/automation-webhooks.ts:15` |
| DELETE | `/v1/webhooks/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_BINDING_CREDENTIAL | `apps/api/src/http/routes/automation-webhooks.ts:16` |
| GET | `/v1/webhooks/meta` | META_VERIFY_TOKEN_QUERY | NOT_APPLICABLE_WEBHOOK | NÃO | SERVER_VERIFY_TOKEN_MATCH | `apps/api/src/http/routes/meta-webhooks.ts:64` |
| POST | `/v1/webhooks/meta` | META_HMAC_SHA256_RAW_BODY | NOT_APPLICABLE_WEBHOOK | SIM | SERVER_ASSET_BINDING_AND_RLS_CHANNEL_MATCH | `apps/api/src/http/routes/meta-webhooks.ts:78` |

## Varredura sanitizada de segredos

- JRC_GIT_HISTORY: 0 ocorrência(s); exclusões: upstream/evolution-api/**, scripts/security/secret-canaries.mjs.
- COMPILED_BUNDLE: 0 ocorrência(s); exclusões: **/*.map, node_modules/**, upstream/**.
- VITE_CONFIGURATION: 0 ocorrência(s); exclusões: apps/web/src/**/*.test.*, apps/web/src/**/*.spec.*.

## Issues completas

--- ISSUE 1 ---
# JRC-SEC-201 — Enforcement final de CSP e Permissions-Policy depende da camada de publicação

## Contexto
O Incremento 2 entrega o bundle e a integração local, mas não realiza deploy.

## Evidência
`docs/operations/web-console.md:29-45`: política obrigatória da borda HTTPS.

## Condições de exploração
Publicação futura sem os headers documentados ou fora da origem da API JRC.

## Impacto
Redução da defesa em profundidade contra injeção de conteúdo e recursos desnecessários do navegador.

## Correção
Aplicar CSP e Permissions-Policy na borda antes do go-live.

## Critérios de aceite
- Console e `/v1` na mesma origem HTTPS.
- CSP sem `unsafe-eval`.
- Permissions-Policy restritiva.
- Teste dos headers no ambiente publicado.

## Verificação
Inspecionar os headers e executar o runbook de publicação.

## Labels sugeridas
`security`, `frontend`, `deployment`, `hardening`
--- FIM ISSUE 1 ---
