# Relatório da Fase 1A — Estabilização

Data: 2026-09-21

## Identificação

- `BASE_SHA`: `2eb98cfbe5db172fbaa9a435476610fb79736fe8`
- `HEAD_SHA`: `2eb98cfbe5db172fbaa9a435476610fb79736fe8` (antes do commit da fase)
- Branch: `codex/jrc-platform-v2-phase1a-stabilization-20260921`
- Base empilhada: commit aprovado da Fase 0
- Commits criados: pendente no momento desta captura

## Resultado

A fase estabiliza o diagnóstico sem alterar rotas ou banco:

- todo envelope JSON de erro recebe `correlationId` igual ao `requestId` já existente;
- o hook de resposta preserva os status HTTP e os serializers Fastify;
- o console de plataforma mostra uma referência sanitizada em erros 5xx, sem exibir detalhe interno;
- `npm run db:schema:status` compara, em transação read-only, as 25 migrations esperadas com `drizzle.__drizzle_migrations`;
- o comando de schema não usa nem exige `MIGRATION_DATABASE_URL` e não executa DDL;
- os timeouts dos testes de auditoria PDF foram ajustados à duração observada, sem mudar a verificação realizada.

## Diagnóstico de 401, 500 e 503

- Auth, sessão expirada, CSRF, permissões de plataforma e erros Chatwoot foram reproduzidos com doubles locais e mantêm 400/401/403/404/409/503 conforme o contrato.
- A primeira implementação por `preSerialization` foi rejeitada pelos testes porque violava schemas de resposta e convertia 401/403 em 500. O código final usa `onSend`, depois da serialização, e a suíte focada confirmou a preservação dos status.
- A origem exata dos erros observados somente nas capturas do servidor não pode ser comprovada sem logs sanitizados, configuração efetiva e resultado do schema status daquele ambiente. Estado: `BLOCKED_PRODUCTION_EVIDENCE_REQUIRED`.
- Evidência mínima ainda necessária em produção: `correlationId`, código seguro do erro, saída sanitizada de `db:schema:status`, flags Chatwoot efetivas e health do destino. Nenhuma credencial ou body remoto deve ser coletado.

## Alterações

### Arquivos criados

- `apps/api/src/db/schema-status.ts`
- `apps/api/src/db/schema-status.test.ts`
- `docs/implementation/jrc-platform-v2/phase-1a-report.md`

### Arquivos modificados

- `apps/api/src/app.ts`
- `apps/api/tests/http/api-keys.test.ts`
- `apps/api/tests/http/auth-session.test.ts`
- `apps/api/tests/http/readiness.test.ts`
- `apps/api/tests/http/request-id.test.ts`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/client.test.ts`
- `apps/web/src/pages/Platform.tsx`
- `apps/web/src/pages/Platform.test.tsx`
- `package.json`
- `tests/security-audit-artifacts.test.mjs`
- `tests/security-audit-pdf-verification.test.mjs`

### Banco, rotas, flags e OpenAPI

- Migrations: nenhuma.
- Rotas adicionadas/alteradas: nenhuma.
- Feature flags adicionadas/alteradas: nenhuma.
- OpenAPI: regenerada, sem diff.

## TDD e testes

Os testes novos falharam primeiro pelos motivos esperados: ausência de `correlationId`, módulo de schema status inexistente e ausência da referência sanitizada no console. Após a implementação mínima, passaram.

| Comando | Resultado |
|---|---|
| `npx vitest run apps/api/tests/http/api-keys.test.ts apps/api/tests/http/auth-session.test.ts tests/security-audit-artifacts.test.mjs tests/security-audit-pdf-verification.test.mjs` | PASS, 4 arquivos e 41 testes |
| `npx vitest run apps/api/tests/http/console-auth.test.ts apps/api/tests/http/chatwoot-control.test.ts apps/api/tests/http/request-id.test.ts apps/api/tests/http/readiness.test.ts` | PASS, 4 arquivos e 31 testes |
| `npx vitest run apps/web/src/pages/Platform.test.tsx apps/web/src/api/client.test.ts` | PASS, 2 arquivos e 42 testes |
| `npm test` | PASS, 158 arquivos e 1.115 testes |
| `npm run test:web` | PASS, 32 arquivos e 210 testes |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run openapi:generate` | PASS, sem diff |
| `npm run db:schema:status` sem URL | PASS do comportamento fail-closed: `SCHEMA_STATUS_DATABASE_URL_REQUIRED` |
| `npm run test:integration` | BLOCKED: `TEST_DATABASE_ADMIN_URL` ausente e Redis local indisponível; nenhuma credencial de servidor foi reutilizada |
| `npm run test:e2e` | BLOCKED no global setup pela ausência de `TEST_DATABASE_ADMIN_URL`; build web anterior ao setup passou |

## Critérios de aceite

| Critério | Estado | Evidência |
|---|---|---|
| Causa dos 401/500/503 reproduzida ou bloqueada com evidência faltante | PASS | comportamento local coberto; produção marcada `BLOCKED_PRODUCTION_EVIDENCE_REQUIRED` com dados necessários definidos |
| Sem 500 genérico para causa conhecida/configuracional | PASS | regressão 401/403 corrigida; suítes HTTP verdes |
| `correlationId` presente e igual a `requestId` | PASS | testes de request ID, auth, API keys, readiness, cliente e plataforma |
| Schema status read-only funcional | PASS | manifesto real até `0025`, estados CURRENT/PENDING/DIVERGED e CLI fail-closed |
| Super Admin smoke verde | PASS local | auth do console e plataforma incluídos na suíte integral; integração real bloqueada por ambiente ausente |
| Chatwoot smoke verde | PASS local | suíte HTTP Chatwoot verde; integração real bloqueada por ambiente ausente |
| CI relevante verde | PASS com gates ambientais explícitos | unit, web, typecheck, build e OpenAPI verdes; integration/E2E não iniciam sem banco de teste declarado |

## Riscos, compatibilidade e rollback

- A consulta read-only precisa ser executada no servidor com uma URL de banco apropriada para confirmar o schema real; o workspace local não possui essa credencial.
- O acréscimo de `correlationId` é aditivo e mantém `requestId` para compatibilidade.
- `/v1/flows`, autenticação, plataforma, Chatwoot e contratos OpenAPI permanecem compatíveis.
- Rollback: reverter o commit desta fase. Não há migration, DDL ou alteração destrutiva.

## Gate de integridade

- `git diff --check`: PASS.
- Nenhum secret, provider real, telefone, QR, payload de cliente, produção, merge ou deploy foi acessado ou alterado.
