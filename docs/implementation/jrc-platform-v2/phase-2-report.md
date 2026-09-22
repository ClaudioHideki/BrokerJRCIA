# Relatório da Fase 2 — Conector gerenciado JRC Conversas

Data: 2026-09-21

## Identificação

- Broker `BASE_SHA`: `cb6096ff43b9273aca5cf13cae69b7996e33249e`
- Broker `HEAD_SHA`: `cb6096ff43b9273aca5cf13cae69b7996e33249e` (antes do commit da fase)
- Broker branch: `codex/jrc-platform-v2-phase2-managed-connector-20260921`
- JRC Conversas base aprovada: `14e7416b7b49f08f1c6edde454803752feae86c4`
- JRC Conversas branch: `codex/jrc-platform-v2-phase2-managed-connector-jrc-20260921`
- JRC Conversas commit: `3b4db70dab1f1fe40bc31a45ebd3f6bfa8cfe7d1`
- Broker commit: pendente no momento desta captura

## Resultado

O conector gerenciado passou a autorizar consulta de estado e pareamento pelo vínculo real do usuário com a caixa de entrada no JRC Conversas. A autorização não depende mais da concessão manual `JrcBrokerInboxGrant` para essas duas ações.

- membro da inbox pode consultar o estado e iniciar/repetir o pareamento;
- a associação é revalidada antes de liberar o QR, inclusive quando removida durante a chamada;
- membro não recebe ações administrativas, como desconectar, confirmar identidade ou atribuir agentes;
- administrador da conta mantém as operações administrativas;
- o Broker continua aceitando somente a credencial servidor a servidor vinculada à organização e com o escopo exato;
- a credencial operacional `chatwoot:read` + `chatwoot:pair` não pode desconectar nem administrar;
- o QR continua restrito à resposta autorizada e com cache desabilitado.

## Alterações

### JRC Conversas

- `app/services/jrc_broker/access.rb`
- `app/policies/jrc_broker_policy.rb`
- `spec/services/jrc_broker/access_spec.rb`
- `spec/requests/api/v1/accounts/jrc_broker_spec.rb`

### Broker

- `apps/api/tests/unit/chatwoot-control-auth.test.ts`
- `docs/implementation/jrc-platform-v2/phase-2-report.md`

### Banco, runtime, rotas, flags e OpenAPI

- Migrations: nenhuma.
- Persistência nova: nenhuma.
- Rotas: nenhuma rota adicionada ou alterada.
- Feature flags: nenhuma adicionada ou alterada.
- OpenAPI: regenerada, sem diff.
- `JrcBrokerInboxGrant`: mantido para compatibilidade e medição; deixou de ser pré-requisito para `status` e `pair`.

## TDD e testes

Os cenários de autorização foram ajustados primeiro para expressar o vínculo direto com `InboxMember`. A implementação mínima removeu a dependência do grant legado e manteve a separação entre ações operacionais e administrativas.

| Comando | Resultado |
|---|---|
| `bundle exec rspec spec/services/jrc_broker/access_spec.rb spec/requests/api/v1/accounts/jrc_broker_spec.rb` | PASS, 12 exemplos e 0 falhas |
| `npx vitest run apps/api/tests/unit/chatwoot-control-auth.test.ts apps/api/tests/unit/chatwoot-control-delegation.test.ts apps/api/tests/http/chatwoot-control.test.ts` | PASS, 3 arquivos e 7 testes |
| `npm run typecheck` | PASS |
| `npm test` | PASS, 159 arquivos e 1.124 testes |
| `npm run openapi:generate` | PASS, sem diff |
| RuboCop nos quatro arquivos Rails | primeira execução apontou apenas finais de linha CRLF; arquivos normalizados para LF e verificados com `CR=0`; nova execução bloqueada por indisponibilidade do Docker Desktop local |

## Critérios de aceite

| Critério | Estado | Evidência |
|---|---|---|
| Membro da inbox pode consultar e parear | PASS | specs de serviço e request do JRC Conversas |
| Usuário sem vínculo recebe 403 | PASS | request spec com usuário de outra inbox |
| Remoção do membro durante o pareamento impede a entrega do QR | PASS | revalidação no request spec |
| Membro não pode desconectar ou administrar | PASS | política e testes do serviço |
| Administrador mantém ações administrativas | PASS | testes da matriz de acesso |
| Organização e inbox são vinculadas à credencial correta | PASS | autorização existente do Control API e suíte HTTP |
| Credencial de reconexão não ganha escopos administrativos | PASS | teste unitário `chatwoot-control-auth` |
| QR não é armazenado em cache | PASS | comportamento existente coberto pelos request specs |
| Grant legado não bloqueia a operação | PASS | teste sem `JrcBrokerInboxGrant` |
| Fluxo real com providers externos | BLOCKED_EXTERNAL_DEPENDENCY | exige ambiente integrado e instâncias reais; nenhum provider foi acionado nesta fase |

## Riscos, compatibilidade e rollback

- Instalações antigas podem continuar gravando grants; eles permanecem compatíveis, mas não ampliam a autorização operacional.
- O Broker não consulta diretamente a tabela `InboxMember`. O JRC Conversas autentica o usuário, valida a associação e chama o Control API com credencial limitada.
- Rollback: reverter o commit desta fase no Broker e `3b4db70dab1f1fe40bc31a45ebd3f6bfa8cfe7d1` no JRC Conversas. Não há migration nem transformação de dados.

## Gate de integridade

- `git diff --check`: PASS.
- OpenAPI: PASS, sem alteração.
- Lint Rails: `BLOCKED_LOCAL_DOCKER_RUNTIME` na repetição; a única classe de falha observada antes da indisponibilidade era CRLF e foi eliminada.
- Nenhum secret real, provider, telefone, QR, payload de cliente, produção, merge ou deploy foi acessado ou alterado.
