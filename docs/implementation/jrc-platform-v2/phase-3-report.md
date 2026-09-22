# Relatório da Fase 3 — Conector para Chatwoot externo

Data: 2026-09-21

## Identificação

- `BASE_SHA`: `c835d9426d6523fd5eea9a087690f8411a605945`
- `HEAD_SHA`: `c835d9426d6523fd5eea9a087690f8411a605945` (antes do commit da fase)
- Branch: `codex/jrc-platform-v2-phase3-external-chatwoot-20260921`
- Base empilhada: commit validado da Fase 2
- Commit da fase: pendente no momento desta captura

## Resultado

A implementação existente já possuía destination por tenant, aprovação por revisão, credencial cifrada, capacidades observadas, Control API servidor a servidor, Dashboard App/portal, QR temporário e uma fronteira HTTP resistente a SSRF. A fase fechou o gap do modo embed: a sessão deixou de ser apenas um segredo opaco e passou a ser um JWT assinado e revogável.

O token de cinco minutos contém e valida:

- issuer e audiência exclusivos do embed;
- tenant e revisão do destination;
- conta e inboxes autorizadas;
- identidade externa vinculada ao usuário que aprovou a sessão;
- somente os escopos `chatwoot:read` e `chatwoot:pair`;
- nonce igual ao ID persistido da sessão;
- emissão e expiração com TTL fixo.

O banco continua guardando somente o hash do token. Cada chamada também revalida sessão, expiração, revogação, versão da credencial, destination, conta, inbox, identidade, grant e revisão. O token do embed não autentica APIs genéricas, administrativas, Meta, mensagens ou Automation Studio.

## Controles existentes auditados e preservados

- Somente origins HTTPS exatas, sem wildcard, porta, caminho, credenciais ou IP literal.
- Bloqueio de loopback, link-local, RFC1918, CGNAT, metadata cloud e faixas IPv4/IPv6 especiais.
- Resolução DNS por requisição, validação de todas as respostas e socket fixado ao IP aprovado.
- TLS validado pelo hostname original, redirects autenticados recusados, timeout e limites de request/response.
- Token de API nunca é enviado para origin de mídia.
- Token Chatwoot é testado no backend e cifrado com AES-GCM.
- Revogação/erro de acesso ou remoção da inbox bloqueia a operação e registra falha de transporte para estado degradado.
- Caminhos API Inbox e Agent Bot permanecem separados; nenhuma regra de duplo envio foi introduzida.

## Alterações

### Segurança e runtime

- `packages/security/src/tokens/embed-session.ts`
- `packages/security/src/index.ts`
- `apps/api/src/modules/integrations/embed/authorization.ts`
- `apps/api/src/modules/integrations/embed/session.ts`
- `apps/api/src/modules/integrations/embed/repository.ts`
- `apps/api/src/http/routes/chatwoot-embed.ts`
- `apps/api/src/app.ts`

### Contrato, testes e documentação

- `packages/contracts/src/integrations/embed.ts`
- `packages/security/tests/embed-session-token.test.ts`
- `apps/api/tests/http/chatwoot-embed.test.ts`
- `apps/api/tests/integration/chatwoot-dashboard-app.test.ts`
- `apps/api/tests/integration/chatwoot-embed-auth.test.ts`
- `apps/web/src/embed/session-client.test.ts`
- `apps/web/tests/e2e/embed-auth-fixture.ts`
- `docs/api/openapi.json`
- `docs/operations/chatwoot-external.md`
- `docs/implementation/jrc-platform-v2/phase-3-report.md`

### Banco, rotas, flags e configuração

- Migrations: nenhuma.
- Tabelas/colunas: nenhuma alteração; a tabela de sessões já comporta ID, hash, grants, expiração e revogação.
- Rotas: nenhuma nova; os caminhos `/v1/embed/*` foram preservados.
- Contrato: o campo `token` do exchange agora exige JWT compacto em vez de base64url opaco.
- OpenAPI: atualizado de `bearerFormat: Opaque` para `bearerFormat: JWT`.
- Feature flags: permanecem `CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED`, `CHATWOOT_CONTROL_ENABLED` e `CHATWOOT_EMBED_ENABLED`.
- Segredo de assinatura: reutiliza `JWT_SECRET` já obrigatório no runtime; nenhuma variável nova.

## TDD e testes

O teste do token foi criado primeiro. A tentativa inicial de execução foi bloqueada pelo sandbox ao iniciar o esbuild (`spawn EPERM`); após execução autorizada fora do sandbox, o teste validou assinatura, claims, expiração, chave incorreta, relógio futuro, inbox duplicada e rejeição de escopos administrativos.

| Comando | Resultado |
|---|---|
| testes focados finais de token, embed, rota, cliente web, destination, SSRF, socket TLS, compatibilidade e autorização | PASS, 9 arquivos e 69 testes |
| testes focados após reforço de nonce/relógio | PASS, 4 arquivos e 30 testes |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS, 160 arquivos e 1.127 testes |
| `npm run openapi:generate` | PASS, diff esperado do JWT |
| integração PostgreSQL de destination/embed/health | `BLOCKED_LOCAL_DEPENDENCY`: 20 testes não executados por ausência de `TEST_DATABASE_ADMIN_URL`; Docker Desktop local indisponível |

## Critérios de aceite

| Critério | Estado | Evidência |
|---|---|---|
| Destination isolado por tenant | PASS | RLS, chave por organização e testes existentes de destination |
| Metadados públicos sem credencial | PASS | DTO e teste HTTP rejeitam/excluem token |
| Credencial cifrada e testada no backend | PASS | `bindAccount`, vault AES-GCM e `verifyAccount` existentes |
| Origin maliciosa/privada bloqueada | PASS | suíte `chatwoot-safe-http` e socket TLS |
| DNS rebinding e redirects bloqueados | PASS | resolução por request, IP pinning e redirect rejection |
| Token expirado, assinatura/audiência/issuer inválidos rejeitados | PASS | módulo e testes do token assinado |
| Token vinculado a tenant/destination/account/inbox/user/nonce | PASS | claims assinados e revalidação no servidor |
| Embed permite somente status e reconnect | PASS | escopos restritos e inexistência de rotas administrativas no embed |
| QR liberado somente por sessão autorizada | PASS | autorização antes e depois da operação e resposta `no-store` |
| Token revogado ou inbox removida bloqueia operação e sinaliza degradação | PASS por implementação; integração local bloqueada | sessão/revisão revalidadas e `access_error` alimenta `DEGRADED`; teste PostgreSQL requer infraestrutura local |
| Nenhum segredo no browser | PASS | resposta pública não contém credencial Chatwoot; JWT fica apenas na memória do cliente |

## Compatibilidade, riscos e rollback

- Sessões opacas emitidas antes da atualização deixam de ser aceitas. Elas tinham TTL máximo de cinco minutos; o usuário autoriza novamente o módulo.
- O payload assinado não contém token Chatwoot, segredo de webhook, QR, telefone completo ou material de prova.
- A assinatura usa audiência distinta do JWT de acesso, e o roteamento aceita o token somente nos dois endpoints do embed.
- A validação com PostgreSQL real deve ser repetida em CI/homologação com `TEST_DATABASE_ADMIN_URL` antes de promover imagens.
- Rollback: reverter o commit desta fase. Não há migration. Sessões JWT ativas expiram em até cinco minutos e precisarão de nova autorização após rollback.

## Gate de integridade

- `git diff --check`: PASS.
- Build e typecheck: PASS.
- Nenhum provider real, segredo, telefone, QR, payload de cliente, produção, merge ou deploy foi acessado ou alterado.
