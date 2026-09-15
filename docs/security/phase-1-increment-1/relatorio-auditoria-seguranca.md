# Relatório de Auditoria de Segurança — JRC WhatsApp Broker

- Fase: 1
- Incremento: 1 — Backend multicliente e Baileys
- Commit: `e8657c0`
- Data de referência: 2026-09-03

## Resumo executivo

A auditoria registrou 1 achado(s) e 12 ponto(s) forte(s). Somente achados CRITICAL ou HIGH com estado OPEN bloqueiam a entrega.

## Escopo e nota metodológica

O escopo cobre o backend multicliente, PostgreSQL/RLS, autenticação e RBAC, segredos e criptografia, fronteira dos providers, OpenAPI, supply chain e container. Frontend funcional, Meta real, filas e webhooks completos não integram este incremento.

As cinco categorias de apresentação são:

- CRITICAL: comprometimento amplo ou imediato (P1).
- HIGH: impacto grave e explorável (P2).
- MEDIUM: impacto relevante sob condições adicionais (P3).
- LOW: hardening ou impacto limitado (P4).
- STRENGTH: controle positivo comprovado, sem efeito bloqueante.

A evidência combina revisão estática, inventário derivado do OpenAPI, testes automatizados, varredura sanitizada do histórico Git JRC e bundles compilados. INFO é contexto, não uma sexta categoria de achado. O submódulo Evolution é excluído da varredura histórica e validado apenas por pin, origem e fronteira.

## Distribuição por severidade

| CRITICAL | HIGH | MEDIUM | LOW | INFO | STRENGTH |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 0 | 1 | 12 |

O PDF apresenta esta distribuição em uma rosca e as evidências por categoria em barras horizontais.

## Pontos fortes

### JRC-STRENGTH-001 — RLS forçada e contexto local à transação

As tabelas tenant usam FORCE ROW LEVEL SECURITY e o runtime aplica organization_id com set_config local. Evidência: `apps/api/drizzle/migrations/0004_rls_and_grants.sql:30-48`.

### JRC-STRENGTH-002 — RBAC aplicado no backend

A matriz de papéis e permissões é avaliada pelo plugin Fastify antes dos handlers protegidos. Evidência: `apps/api/src/http/plugins/authorization.ts:34-53`.

### JRC-STRENGTH-003 — API keys verificadas com HMAC e comparação constante

O segredo bruto é exibido somente na emissão; autenticação usa HMAC-SHA-256 e timingSafeEqual. Evidência: `packages/security/src/api-keys/hmac.ts:1-103`.

### JRC-STRENGTH-004 — Verificação Argon2id fictícia contra enumeração

Usuários ausentes executam verificação equivalente usando hash fictício inicializado no startup. Evidência: `packages/security/src/passwords/argon2id.ts:39-54`.

### JRC-STRENGTH-005 — Evolution isolada atrás do adapter

O cliente bloqueia redirects e propaga somente contratos e erros canônicos para os casos de uso. Evidência: `packages/providers/src/evolution/client.ts:145-161`.

### JRC-STRENGTH-006 — Ownership verificado antes de chamadas ao provider

Instâncias são buscadas no contexto da organização ativa e acesso cruzado retorna 404 sem invocar o adapter. Evidência: `apps/api/src/modules/instances/service.ts:370-390`.

### JRC-STRENGTH-007 — Rate limit distribuído com chaves HMAC

O runtime usa Redis com TTL e deriva chaves opacas por HMAC para IP e identidade, aceitando encaminhamento somente de proxies confiáveis. Evidência: `apps/api/src/http/routes/auth.ts:54-81`.

### JRC-STRENGTH-008 — Redaction estrutural conectada ao logger e auditoria

Campos e headers sensíveis são removidos por configuração do logger e metadados de auditoria são sanitizados antes da persistência. Evidência: `packages/security/src/redaction/logger.ts:156-201`.

### JRC-STRENGTH-009 — Idempotência tenant-aware com TTL

Operações mutáveis reservam chaves por organização e rota, detectam payload divergente e expiram registros sem serializar desafios. Evidência: `apps/api/src/modules/instances/idempotency.ts:75-113`.

### JRC-STRENGTH-010 — Dependências bloqueadas e auditadas no CI

O pipeline instala o lockfile com npm ci e bloqueia vulnerabilidades HIGH ou CRITICAL com npm audit. Evidência: `.github/workflows/ci.yml:60-97`.

### JRC-STRENGTH-011 — OpenAPI derivado da composição real e versionado

O documento é gerado pela aplicação Fastify, normalizado deterministicamente e comparado no CI com o contrato versionado. Evidência: `apps/api/src/http/openapi.ts:105-129`.

### JRC-STRENGTH-012 — Imagem imutável e runtime não-root

A imagem fixa Node por versão e digest, separa build do runtime e executa o entrypoint compilado como usuário node. Evidência: `infra/app/Dockerfile:1-37`.

## Pontos fracos

Nenhum ponto fraco aplicável.


## Tabela de achados

| ID | Categoria | Severidade | Estado | Arquivo | Linhas |
| --- | --- | --- | --- | --- | ---: |
| JRC-SEC-001 | INPUTS_XSS | INFO | NOT_APPLICABLE | `apps/web/README.md` | 3–3 |

## Prioridades

Nenhuma prioridade aplicável.

## Inventário de rotas

| Método | Rota | Autenticação | Permissão | Tenant/RLS | Ownership | Handler |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/v1/api-keys` | JWT_OR_JRC_API_KEY | api_keys:manage | SIM | RLS_ORGANIZATION_FILTER | `apps/api/src/http/routes/api-keys.ts:133` |
| POST | `/v1/api-keys` | JWT_OR_JRC_API_KEY | api_keys:manage | SIM | ACTIVE_ORGANIZATION_CONTEXT | `apps/api/src/http/routes/api-keys.ts:115` |
| DELETE | `/v1/api-keys/{id}` | JWT_OR_JRC_API_KEY | api_keys:manage | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID | `apps/api/src/http/routes/api-keys.ts:150` |
| POST | `/v1/auth/login` | NONE | NOT_APPLICABLE_PRE_AUTH | NÃO | NOT_APPLICABLE_PRE_AUTH | `apps/api/src/http/routes/auth.ts:148` |
| POST | `/v1/auth/logout` | REFRESH_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_FAMILY_BOUND | `apps/api/src/http/routes/auth.ts:246` |
| POST | `/v1/auth/refresh` | REFRESH_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | REFRESH_TOKEN_TENANT_BOUND | `apps/api/src/http/routes/auth.ts:223` |
| POST | `/v1/auth/select-organization` | SELECTION_TOKEN | NOT_APPLICABLE_PRE_AUTH | NÃO | SELECTION_TOKEN_MEMBERSHIP_REVALIDATED | `apps/api/src/http/routes/auth.ts:192` |
| GET | `/v1/instances` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_FILTER_AND_TENANT_CURSOR | `apps/api/src/http/routes/instances.ts:152` |
| POST | `/v1/instances` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_PROVIDER_ACCOUNT_AND_ORGANIZATION | `apps/api/src/http/routes/instances.ts:126` |
| GET | `/v1/instances/{id}` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID | `apps/api/src/http/routes/instances.ts:169` |
| POST | `/v1/instances/{id}/connect` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:183` |
| POST | `/v1/instances/{id}/disconnect` | JWT_OR_JRC_API_KEY | instances:connect | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:226` |
| GET | `/v1/instances/{id}/status` | JWT_OR_JRC_API_KEY | instances:read | SIM | RLS_ORGANIZATION_AND_RESOURCE_ID_BEFORE_PROVIDER | `apps/api/src/http/routes/instances.ts:211` |

## Varredura sanitizada de segredos

- JRC_GIT_HISTORY: 0 ocorrência(s); exclusões: upstream/evolution-api/**, scripts/security/secret-canaries.mjs.
- COMPILED_BUNDLE: 0 ocorrência(s); exclusões: **/*.map, node_modules/**, upstream/**.

## Issues completas

--- ISSUE 1 ---
# JRC-SEC-001 — Verificações exclusivas de XSS no frontend não se aplicam ao Incremento 1

## Contexto
O Incremento 1 entrega somente backend e não contém superfície HTML/JavaScript funcional.

## Evidência
`apps/web/README.md:3`: `O Incremento 1 não contém implementação funcional de frontend.`

## Condições de exploração
A verificação passa a ser aplicável quando o painel web ou qualquer resposta HTML funcional entrar no produto.

## Impacto
Nenhum impacto aplicável ao runtime atual; inputs da API continuam no escopo.

## Correção
Criar especificação e testes próprios de XSS antes do Incremento 2.

## Critérios de aceite
- Manter o diretório web sem implementação funcional neste incremento.
- Auditar o frontend antes de sua publicação.

## Verificação
Inspecionar a composição HTTP e o conteúdo de `apps/web`.

## Labels sugeridas
`security`, `not-applicable`, `frontend`
--- FIM ISSUE 1 ---
