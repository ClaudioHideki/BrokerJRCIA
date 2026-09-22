# Relatório da Fase 1B — Contratos canônicos iniciais

Data: 2026-09-21

## Identificação

- `BASE_SHA`: `7f7680b598cb62d52cd2850705bd0e67e2100529`
- `HEAD_SHA`: `7f7680b598cb62d52cd2850705bd0e67e2100529` (antes do commit da fase)
- Branch: `codex/jrc-platform-v2-phase1b-contracts-20260921`
- Base empilhada: commit validado da Fase 1A
- Commits criados: pendente no momento desta captura

## Resultado

Foram adicionados contratos Zod versionados em `@jrc/contracts`, sem persistência ou mudança de runtime:

- `ChannelV1` representa QR e Meta com referência interna ao provider e identidade mascarada;
- transporte, provider, automação e atendimento humano possuem estados independentes;
- `AutomationDefinitionV1` representa rascunho, revisão e versão ativa;
- `AutomationPublishedVersionV1` fixa grafo, número da versão, checksum e publicação;
- `AutomationBindingV1` representa o vínculo versionado entre automação, canal e destino humano;
- `AutomationExecutionSummaryV1` publica somente estado resumido e correlação, sem input/output sensível;
- `adaptLegacyFlowRecordToAutomationV1` preserva grafo, revisão, nome, versão publicada e data de atualização do Flow atual;
- DTOs são estritos e o grafo canônico rejeita chaves de segredo.

## Alterações

### Arquivos criados

- `packages/contracts/src/channels-v1.ts`
- `packages/contracts/src/automations-v1.ts`
- `packages/contracts/tests/channel-automation-v1.test.ts`
- `docs/implementation/jrc-platform-v2/phase-1b-report.md`

### Arquivos modificados

- `packages/contracts/src/index.ts`

### Banco, runtime, rotas, flags e OpenAPI

- Migrations: nenhuma.
- Persistência nova: nenhuma.
- Runtime do Flow: sem alteração.
- Rotas adicionadas/alteradas: nenhuma; `/v1/flows` permanece intacta.
- Feature flags adicionadas/alteradas: nenhuma.
- OpenAPI: regenerada, sem diff.

## TDD e testes

O teste alvo foi criado antes dos schemas e falhou nos oito casos pela ausência dos exports e do adaptador. Depois da implementação mínima, passou integralmente.

| Comando | Resultado |
|---|---|
| `npx vitest run packages/contracts/tests/channel-automation-v1.test.ts` antes da implementação | FAIL esperado, 8/8 por contratos ausentes |
| `npx vitest run packages/contracts/tests/channel-automation-v1.test.ts` depois da implementação | PASS, 8/8 |
| `npx vitest run packages/contracts/tests` | PASS, 5 arquivos e 27 testes |
| `npx vitest run apps/api/tests/unit/flows-engine.test.ts apps/api/tests/http/flows.test.ts apps/api/tests/unit/flow-chatwoot-events.test.ts` | PASS, 3 arquivos e 19 testes |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS, 159 arquivos e 1.123 testes |
| `npm run openapi:generate` | PASS, sem diff |

## Critérios de aceite

| Critério | Estado | Evidência |
|---|---|---|
| Schemas Zod versionados | PASS | `schemaVersion: 1` em Channel e Automation |
| Parse/serialize cobertos | PASS | round-trip de Channel e parse dos quatro DTOs Automation |
| Nenhum segredo em DTO | PASS | strict objects e rejeição recursiva de chaves secretas no grafo |
| Nenhuma mudança de banco | PASS | nenhuma migration ou schema de persistência alterado |
| OpenAPI sem regressão | PASS | geração determinística sem diff |
| Flow atual continua funcionando | PASS | 19 testes de engine/eventos/rotas e suíte integral verdes |
| Sem perda de semântica na adaptação | PASS | grafo, revisão e versão publicada preservados por teste |

## Riscos, compatibilidade e rollback

- Estes contratos ainda não substituem os DTOs das rotas antigas; a adoção ocorrerá nas fases seguintes por adaptadores.
- Os status são deliberadamente independentes. Consumidores não devem inferir estado de automação ou atendimento apenas por `transportStatus`.
- O contrato exige identidade mascarada e referências UUID internas; identificadores brutos de provider não são publicados por ele.
- Rollback: reverter o commit desta fase. Não há dado para migrar ou restaurar.

## Gate de integridade

- `git diff --check`: PASS.
- Nenhum secret, provider real, telefone, QR, payload de cliente, produção, merge ou deploy foi acessado ou alterado.
