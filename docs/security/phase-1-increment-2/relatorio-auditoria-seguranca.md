# Relatório de Auditoria de Segurança — JRC WhatsApp Broker

- Fase: 1
- Incremento: 2 — Console web operacional JRC
- Referência da fonte: `sha256:fd9222cf52b93bb00f5437c7a56f2a637ea9e8bc9f9bad1762a311df5bdd8dde`
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
| POST | `/v1/auth/login` | NONE | NOT_APPLICABLE_PRE_AUTH | NÃO | NOT_APPLICABLE_PRE_AUTH | `apps/api/src/http/routes/auth.ts:148` |
| POST | `/v1/auth/logout` | REFRESH_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_FAMILY_BOUND | `apps/api/src/http/routes/auth.ts:246` |
| POST | `/v1/auth/refresh` | REFRESH_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_TENANT_BOUND | `apps/api/src/http/routes/auth.ts:223` |
| POST | `/v1/auth/select-organization` | SELECTION_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | SELECTION_TOKEN_MEMBERSHIP_REVALIDATED | `apps/api/src/http/routes/auth.ts:192` |
| POST | `/v1/automation-imports` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMPORT_ARTIFACT | `apps/api/src/http/routes/automation-imports.ts:12` |
| GET | `/v1/automation-nodes` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | STATIC_EXECUTABLE_NODE_CATALOG | `apps/api/src/http/routes/automations.ts:27` |
| GET | `/v1/automations` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:28` |
| POST | `/v1/automations` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:35` |
| GET | `/v1/automations/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:36` |
| PUT | `/v1/automations/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:37` |
| GET | `/v1/automations/{id}/bindings` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:42` |
| POST | `/v1/automations/{id}/bindings` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:43` |
| PATCH | `/v1/automations/{id}/bindings/{bindingId}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:44` |
| POST | `/v1/automations/{id}/publish` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:40` |
| POST | `/v1/automations/{id}/simulate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:39` |
| POST | `/v1/automations/{id}/validate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:38` |
| GET | `/v1/automations/{id}/versions` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:41` |
| GET | `/v1/automations/migrations/legacy` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:30` |
| POST | `/v1/automations/migrations/legacy` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:31` |
| POST | `/v1/automations/migrations/legacy/{id}/cutover` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:32` |
| POST | `/v1/automations/migrations/legacy/{id}/rollback` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:33` |
| GET | `/v1/automations/status` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:26` |
| GET | `/v1/channels` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID | `apps/api/src/http/routes/channels.ts:52` |
| POST | `/v1/channels` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_PROVIDER_ACCOUNT_AND_CHANNEL | `apps/api/src/http/routes/channels.ts:57` |
| GET | `/v1/channels/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID | `apps/api/src/http/routes/channels.ts:54` |
| PUT | `/v1/channels/{id}/destination` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_CHANNEL_ACCOUNT_AND_INBOX | `apps/api/src/http/routes/channels.ts:72` |
| POST | `/v1/channels/{id}/pair` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_AND_CANONICAL_CHANNEL_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/channels.ts:64` |
| POST | `/v1/console/auth/logout` | EXACT_ORIGIN_WITH_OPTIONAL_REFRESH_COOKIE_CSRF | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_FAMILY_WHEN_PRESENT | `apps/api/src/http/routes/console-auth.ts:380` |
| POST | `/v1/console/auth/restore` | REFRESH_COOKIE_CSRF_AND_EXACT_ORIGIN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_TENANT_BOUND | `apps/api/src/http/routes/console-auth.ts:336` |
| POST | `/v1/console/auth/select-organization` | SELECTION_TOKEN_AND_EXACT_ORIGIN | NOT_APPLICABLE_PRE_AUTH | NÃO | SELECTION_TOKEN_MEMBERSHIP_REVALIDATED | `apps/api/src/http/routes/console-auth.ts:313` |
| POST | `/v1/console/auth/switch-organization` | JWT_REFRESH_COOKIE_CSRF_AND_EXACT_ORIGIN | ACTIVE_MEMBERSHIP | NÃO | SOURCE_AND_TARGET_MEMBERSHIPS_REVALIDATED | `apps/api/src/http/routes/console-auth.ts:353` |
| GET | `/v1/credentials` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:17` |
| POST | `/v1/credentials` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:18` |
| DELETE | `/v1/credentials/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:21` |
| GET | `/v1/credentials/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:19` |
| PUT | `/v1/credentials/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:20` |
| POST | `/v1/credentials/{id}/test` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CREDENTIAL | `apps/api/src/http/routes/credentials.ts:22` |
| GET | `/v1/embed/apps/{id}/policy` | PUBLIC_OPAQUE_APP_ID | APPROVED_ORIGIN_ONLY | SIM | SERVER_LOOKUP_RLS_ACTIVE_APP_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:57` |
| POST | `/v1/embed/authorizations` | PUBLIC_CHALLENGE_RATE_LIMITED | START_WITHOUT_AUTHENTICATION_GRANT | SIM | SERVER_LOOKUP_RLS_ACTIVE_APP_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:59` |
| GET | `/v1/embed/authorizations/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_CONNECTION_GRANTS | SIM | RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS | `apps/api/src/http/routes/chatwoot-embed.ts:66` |
| POST | `/v1/embed/authorizations/{id}/approve` | JWT_CSRF_EXACT_ORIGIN | CURRENT_CONNECTION_GRANTS | SIM | RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS | `apps/api/src/http/routes/chatwoot-embed.ts:68` |
| POST | `/v1/embed/authorizations/{id}/deny` | JWT_CSRF_EXACT_ORIGIN | CURRENT_CONNECTION_GRANTS | SIM | RLS_PENDING_REQUEST_CURRENT_ACCOUNT_DESTINATION_GRANTS | `apps/api/src/http/routes/chatwoot-embed.ts:71` |
| POST | `/v1/embed/authorizations/{id}/exchange` | SHA256_VERIFIER_TIMING_SAFE_RATE_LIMITED | EXPLICIT_APPROVAL_CURRENT_GRANTS | SIM | RLS_APPROVED_UNEXPIRED_REQUEST_USER_GRANTS_IDENTITY | `apps/api/src/http/routes/chatwoot-embed.ts:74` |
| POST | `/v1/embed/connections/{id}/pair` | OPAQUE_SHORT_SESSION_HASH_LOOKUP | SESSION_PAIR_GRANT_APPROVED_IDENTITY | SIM | RLS_CURRENT_SESSION_GRANT_BEFORE_DISPATCH_AFTER_RESPONSE | `apps/api/src/http/routes/chatwoot-embed.ts:89` |
| GET | `/v1/embed/connections/{id}/status` | OPAQUE_SHORT_SESSION_HASH_LOOKUP | SESSION_READ_GRANT_CURRENT_MEMBERSHIP | SIM | RLS_SESSION_ACCOUNT_DESTINATION_CREDENTIAL_IDENTITY_REVISION | `apps/api/src/http/routes/chatwoot-embed.ts:82` |
| GET | `/v1/executions` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:45` |
| GET | `/v1/executions/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_AUTOMATION_VERSION_BINDING_EXECUTION | `apps/api/src/http/routes/automations.ts:46` |
| POST | `/v1/executions/{id}/cancel` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:47` |
| POST | `/v1/executions/{id}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:49` |
| POST | `/v1/executions/{id}/resume` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:50` |
| POST | `/v1/executions/{id}/retry` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_IMMUTABLE_VERSION_DURABLE_EXECUTION_OUTBOX | `apps/api/src/http/routes/automations.ts:48` |
| GET | `/v1/flows` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:54` |
| POST | `/v1/flows` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:62` |
| GET | `/v1/flows/{id}` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:65` |
| PUT | `/v1/flows/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:66` |
| POST | `/v1/flows/{id}/bind` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:74` |
| POST | `/v1/flows/{id}/chatwoot/bind` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:38` |
| GET | `/v1/flows/{id}/chatwoot/runs` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:40` |
| GET | `/v1/flows/{id}/export` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:67` |
| POST | `/v1/flows/{id}/publish` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:73` |
| GET | `/v1/flows/{id}/runs` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:76` |
| POST | `/v1/flows/{id}/simulate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:77` |
| POST | `/v1/flows/{id}/unbind` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:75` |
| POST | `/v1/flows/{id}/validate` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:70` |
| GET | `/v1/flows/channels` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:55` |
| POST | `/v1/flows/chatwoot/{id}/disable` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:39` |
| POST | `/v1/flows/chatwoot/{id}/events` | HMAC_TIMESTAMP_RAW_BODY | BOUND_AGENT_BOT | SIM | RLS_ACCOUNT_INBOX_DESTINATION_CREDENTIAL_FEATURE_REVISION | `apps/api/src/http/routes/flows.ts:44` |
| GET | `/v1/flows/chatwoot/inboxes` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:37` |
| POST | `/v1/flows/import-preview` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_BINDING | `apps/api/src/http/routes/flows.ts:59` |
| GET | `/v1/flows/library` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:56` |
| GET | `/v1/flows/status` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_FEATURE_AND_APPROVED_REMOTE_DESTINATION | `apps/api/src/http/routes/flows.ts:53` |
| GET | `/v1/instances` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_FILTER_AND_TENANT_CURSOR | `apps/api/src/http/routes/instances.ts:152` |
| POST | `/v1/instances` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_PROVIDER_ACCOUNT_AND_ORGANIZATION | `apps/api/src/http/routes/instances.ts:126` |
| GET | `/v1/instances/{id}` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID | `apps/api/src/http/routes/instances.ts:169` |
| POST | `/v1/instances/{id}/connect` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:183` |
| POST | `/v1/instances/{id}/disconnect` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:229` |
| PUT | `/v1/instances/{id}/settings` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_ACTIVE_ORGANIZATION_AUDITED | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instance-workspace.ts:27` |
| GET | `/v1/instances/{id}/status` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:214` |
| GET | `/v1/instances/{id}/workspace` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instance-workspace.ts:23` |
| GET | `/v1/integrations/chatwoot` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ONLY | `apps/api/src/http/routes/integrations.ts:166` |
| POST | `/v1/integrations/chatwoot/{id}/events` | CHATWOOT_HMAC_TIMESTAMP_RAW_BODY | NOT_APPLICABLE_WEBHOOK | SIM | STORED_BINDING_SIGNATURE_ACCOUNT_INBOX_AND_RLS | `apps/api/src/http/routes/integrations.ts:352` |
| PUT | `/v1/integrations/chatwoot/account` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:184` |
| POST | `/v1/integrations/chatwoot/connections` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:218` |
| PATCH | `/v1/integrations/chatwoot/connections/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:268` |
| GET | `/v1/integrations/chatwoot/connections/{id}/agents` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:230` |
| POST | `/v1/integrations/chatwoot/connections/{id}/agents` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:235` |
| GET | `/v1/integrations/chatwoot/connections/{id}/operator-grants` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_CURRENT_ORGANIZATION_CONNECTION_MEMBERS_PROJECTION | `apps/api/src/http/routes/chatwoot-control.ts:91` |
| PUT | `/v1/integrations/chatwoot/connections/{id}/operator-grants` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ACTIVE_ORGANIZATION_CURRENT_MEMBERSHIP_AND_CONNECTION | `apps/api/src/http/routes/chatwoot-control.ts:94` |
| POST | `/v1/integrations/chatwoot/connections/{id}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:255` |
| POST | `/v1/integrations/chatwoot/connections/{id}/retry` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:120` |
| POST | `/v1/integrations/chatwoot/control-credentials` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ACTIVE_ORGANIZATION_APPROVED_ACCOUNT | `apps/api/src/http/routes/chatwoot-control.ts:88` |
| PUT | `/v1/integrations/chatwoot/control/connections/{integrationId}/agents` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_VALIDATED_ACCOUNT_AGENTS | `apps/api/src/http/routes/chatwoot-control.ts:70` |
| POST | `/v1/integrations/chatwoot/control/connections/{integrationId}/confirm-identity` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_ADMIN_PROVIDER_OBSERVED_IDENTITY | `apps/api/src/http/routes/chatwoot-control.ts:67` |
| POST | `/v1/integrations/chatwoot/control/connections/{integrationId}/disconnect` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_DISCONNECT | SIM | RLS_CURRENT_CONNECTION_ADMIN_OR_SERVICE | `apps/api/src/http/routes/chatwoot-control.ts:60` |
| POST | `/v1/integrations/chatwoot/control/connections/{integrationId}/pair` | JWT_OR_BOUND_CONTROL_KEY | CHATWOOT_PAIR_AND_FIRST_BINDING_ADMIN | SIM | RLS_CURRENT_CONNECTION_GRANT_AND_PROVIDER_IDENTITY | `apps/api/src/http/routes/chatwoot-control.ts:53` |
| GET | `/v1/integrations/chatwoot/control/connections/{integrationId}/status` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_READ | SIM | RLS_ACCOUNT_REVISION_CONNECTION_GRANT | `apps/api/src/http/routes/chatwoot-control.ts:50` |
| GET | `/v1/integrations/chatwoot/control/context` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_READ | SIM | RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION | `apps/api/src/http/routes/chatwoot-control.ts:36` |
| GET | `/v1/integrations/chatwoot/control/onboarding` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_CURRENT_ACCOUNT_REVISION_OPERATIONS | `apps/api/src/http/routes/chatwoot-control.ts:43` |
| POST | `/v1/integrations/chatwoot/control/onboarding` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION | `apps/api/src/http/routes/chatwoot-control.ts:73` |
| GET | `/v1/integrations/chatwoot/control/onboarding/{operationId}` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_READ | SIM | RLS_ACTIVE_ORGANIZATION_OPERATION_AND_INTEGRATION_GRANT | `apps/api/src/http/routes/chatwoot-control.ts:79` |
| POST | `/v1/integrations/chatwoot/control/onboarding/{operationId}/recover` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_ACTIVE_ORGANIZATION_ACCOUNT_AND_DESTINATION_REVISION | `apps/api/src/http/routes/chatwoot-control.ts:82` |
| GET | `/v1/integrations/chatwoot/control/resources` | JWT_OR_BOUND_CONTROL_KEY | CURRENT_MEMBERSHIP_OR_CHATWOOT_MANAGE | SIM | RLS_SANITIZED_AVAILABLE_QR_RESOURCES | `apps/api/src/http/routes/chatwoot-control.ts:40` |
| GET | `/v1/integrations/chatwoot/destination` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ONLY | `apps/api/src/http/routes/integrations.ts:114` |
| PUT | `/v1/integrations/chatwoot/destination` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_AND_DESTINATION_NOT_IN_USE | `apps/api/src/http/routes/integrations.ts:117` |
| POST | `/v1/integrations/chatwoot/embed-apps` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_APPROVED_CURRENT_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:48` |
| GET | `/v1/integrations/chatwoot/embed-apps/{id}` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_APPROVED_CURRENT_ACCOUNT_DESTINATION | `apps/api/src/http/routes/chatwoot-embed.ts:51` |
| POST | `/v1/integrations/chatwoot/embed-apps/{id}/install` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ACCOUNT_DESTINATION_CREDENTIAL_REVISION_BEFORE_POST | `apps/api/src/http/routes/chatwoot-embed.ts:54` |
| GET | `/v1/integrations/chatwoot/inboxes` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:197` |
| GET | `/v1/integrations/chatwoot/jobs` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ONLY | `apps/api/src/http/routes/integrations.ts:287` |
| POST | `/v1/integrations/chatwoot/jobs/{id}/reconcile` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:141` |
| POST | `/v1/integrations/chatwoot/jobs/{id}/retry` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:295` |
| GET | `/v1/integrations/chatwoot/sources` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:161` |
| GET | `/v1/messaging/channels` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_FILTER | `apps/api/src/http/routes/messaging.ts:312` |
| PATCH | `/v1/messaging/channels/{id}/automation` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_CHANNEL_AND_SERVER_ORIGIN_ALLOWLIST | `apps/api/src/http/routes/messaging.ts:392` |
| GET | `/v1/messaging/channels/{id}/conversations` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CHANNEL_ID | `apps/api/src/http/routes/messaging.ts:336` |
| POST | `/v1/messaging/channels/{id}/messages` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_CHANNEL_CONVERSATION_AND_CONTACT_POLICY_BEFORE_OUTBOX | `apps/api/src/http/routes/messaging.ts:362` |
| GET | `/v1/messaging/channels/{id}/templates` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CHANNEL_ID_BEFORE_META | `apps/api/src/http/routes/messaging.ts:323` |
| POST | `/v1/messaging/channels/{id}/text` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_CHANNEL_CONVERSATION_AND_CONTACT_POLICY_BEFORE_OUTBOX | `apps/api/src/http/routes/messaging.ts:277` |
| GET | `/v1/messaging/conversations/{id}/messages` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AND_CONVERSATION_ID | `apps/api/src/http/routes/messaging.ts:349` |
| PATCH | `/v1/messaging/conversations/{id}/mode` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR | SIM | RLS_ORGANIZATION_AND_CONVERSATION_ID | `apps/api/src/http/routes/messaging.ts:410` |
| POST | `/v1/messaging/instances/{id}/activate` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ACCOUNT_INBOX_AND_CHANNEL_VERIFIED | `apps/api/src/http/routes/integrations.ts:314` |
| GET | `/v1/messaging/media/{id}` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_ENCRYPTED_MEDIA_ATTACHMENT_ONLY | `apps/api/src/http/routes/messaging.ts:256` |
| POST | `/v1/messaging/messages/{id}/retry` | JWT_WITH_ACTIVE_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_AND_SAFE_OUTBOX_STATE | `apps/api/src/http/routes/messaging.ts:232` |
| GET | `/v1/meta-onboarding` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:28` |
| POST | `/v1/meta-onboarding/{id}/refresh` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:32` |
| POST | `/v1/meta-onboarding/{id}/register` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:33` |
| POST | `/v1/meta-onboarding/{id}/revoke` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:31` |
| POST | `/v1/meta-onboarding/complete` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:30` |
| POST | `/v1/meta-onboarding/start` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN | SIM | RLS_ORGANIZATION_ASSETS_VERIFIED_BY_META | `apps/api/src/http/routes/meta-onboarding.ts:29` |
| GET | `/v1/operations/health` | JWT_CURRENT_MEMBERSHIP | CURRENT_MEMBER | SIM | RLS_CURRENT_ORGANIZATION_HEALTH_AND_QUEUES | `apps/api/src/http/routes/observability.ts:12` |
| GET | `/v1/organization/operations` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_LIMITS | `apps/api/src/http/routes/tenant-operations.ts:50` |
| GET | `/v1/organization/overview` | JWT_CURRENT_MEMBERSHIP | OWNER_ADMIN_OPERATOR_VIEWER | SIM | RLS_ORGANIZATION_AGGREGATES_NO_CONTENT | `apps/api/src/http/routes/tenant-operations.ts:27` |
| GET | `/v1/platform/auth/config` | NONE | NOT_APPLICABLE_PRE_AUTH | NÃO | PUBLIC_MFA_POLICY_ONLY | `apps/api/src/http/routes/platform.ts:176` |
| POST | `/v1/platform/auth/login` | CONFIGURED_PASSWORD_MODE_EXACT_ORIGIN | PLATFORM_IDENTITY | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:183` |
| POST | `/v1/platform/auth/logout` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | PLATFORM_IDENTITY | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:210` |
| GET | `/v1/platform/auth/session` | PLATFORM_SESSION_COOKIE | PLATFORM_IDENTITY | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:198` |
| GET | `/v1/platform/organizations` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:243` |
| POST | `/v1/platform/organizations` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:254` |
| PATCH | `/v1/platform/organizations/{id}` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:264` |
| GET | `/v1/platform/organizations/{id}/chatwoot` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:363` |
| PUT | `/v1/platform/organizations/{id}/chatwoot/account` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:392` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:426` |
| PATCH | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:544` |
| GET | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:448` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:459` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/reconcile` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:527` |
| POST | `/v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/retry` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:483` |
| POST | `/v1/platform/organizations/{id}/chatwoot/destination/approve` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_AND_DESTINATION_REVISION | `apps/api/src/http/routes/platform.ts:353` |
| GET | `/v1/platform/organizations/{id}/chatwoot/inboxes` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:414` |
| GET | `/v1/platform/organizations/{id}/chatwoot/jobs` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:418` |
| POST | `/v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/reconcile` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:506` |
| POST | `/v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/retry` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:563` |
| POST | `/v1/platform/organizations/{id}/chatwoot/provision` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:582` |
| POST | `/v1/platform/organizations/{id}/chatwoot/provision/reconcile` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:623` |
| POST | `/v1/platform/organizations/{id}/chatwoot/provision/resume` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:603` |
| GET | `/v1/platform/organizations/{id}/chatwoot/sources` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_AUTHORIZATION_THEN_TENANT_RLS | `apps/api/src/http/routes/platform.ts:410` |
| GET | `/v1/platform/organizations/{id}/memberships` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:271` |
| PUT | `/v1/platform/organizations/{id}/memberships` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:292` |
| GET | `/v1/platform/organizations/{id}/monitor` | PLATFORM_SESSION_COOKIE | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:303` |
| POST | `/v1/platform/organizations/{id}/support-acknowledgment` | PLATFORM_COOKIE_CSRF_EXACT_ORIGIN | SUPER_ADMIN_SUPPORT_AUDITED | SIM | DEDICATED_PLATFORM_ROLE_EXPLICIT_RLS_NO_CONTENT | `apps/api/src/http/routes/platform.ts:320` |
| GET | `/v1/provider-accounts` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_FILTER_AND_TENANT_CURSOR | `apps/api/src/http/routes/provider-accounts.ts:74` |
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
