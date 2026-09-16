# Execução local — Broker JRC + Chatwoot

## Autorização e limites

O usuário autorizou expressamente a execução local dos planos 01, 02 e 03 em 16/09/2026.
Não há autorização nesta entrega para push, merge, publicação de imagens, deploy,
mensagens reais, troca de webhook remoto ou desconexão de números.
O pacote original, com hashes conferidos, está em `docs/reference/broker-chatwoot-20260916/`.
Na cópia versionada foi removido um espaço ao final de linha do plano 02 para passar
`git diff --check`, e o manifest da cópia foi recalculado. O ZIP e a extração original
ignorada permanecem intactos.
As instruções Superpowers mencionadas pelo pacote não estão instaladas neste ambiente;
o fluxo de trabalho é executado diretamente com worktrees, TDD e gates por tarefa.

## Preflight

| Repositório | Baseline do pacote | HEAD encontrado/origem do trabalho | Situação |
|---|---|---|---|
| BrokerJRCIA | `9e530170cdda90ee8b9b673a28723180e0b2e1a3` | mesmo HEAD, `main` limpa | Sem divergência |
| JRC Conversas | `62c14af884c7f45fa640345556f2ffecc22113d8` | `f38fe020057277cf5d2733460915e67451898165` | Cinco commits posteriores preservados |

Também existe o checkout JRC Conversas em `1409f1c` com `db/schema.rb` modificado.
Esse checkout e sua alteração local foram preservados. O trabalho novo parte do
commit mais recente `f38fe02`, sem transplantar o schema de outro ambiente.

- Broker: branch `codex/broker-chatwoot-control`, worktree `broker-chatwoot-control-20260916`.
- Conversas: branch `codex/jrc-broker-native`, worktree `jrc-broker-native-20260916`.
- Node local: 24.19.0; dependências Broker instaladas pelo lockfile com `npm ci`.
- Ruby nativo indisponível; imagem de laboratório `jrc-nico-test:local` confirmou Ruby 3.4.4,
  a versão exigida pelo checkout. Isso ainda não comprova RSpec ou build Rails.
- Submódulos Broker inicializados nos commits fixados. A tentativa de usar uma
  referência shallow não foi aceita pelo Git; clone normal dos commits fixados concluiu.
- PostgreSQL de testes: somente `127.0.0.1:55433`, bancos aleatórios `jrc_test_*`
  criados e removidos pelo harness. Redis reservado de testes: `127.0.0.1:16380`.
- Banco de clientes na porta 55432 e demais serviços locais não são alvos dos testes.
- `npm run typecheck` no baseline: PASS.
- Testes existentes `chatwoot-client`, `chatwoot-security`, `integration-runtime`: PASS, 9 testes.

## Tarefa B1 — destinos aprovados

Implementação e gate local concluídos. Migração aditiva `0018_chatwoot_destinations`:

- Um destino por organização, revisão e aprovação administrativa auditada.
- Privilégios SQL impedem `jrc_app` de modificar aprovação ou lista de mídia.
- FK diferida mantém a origem da conta consistente com o destino ao final da transação.
- Backfill mantém ciphertext, IDs, datas e estado das contas; não inventa verificação remota.
- Mudança de origem sem recursos associados invalida credencial/aprovação; com conexões
  ou provisionamento incerto é recusada. Destino MANAGED exige a origem global configurada.
- Novas rotas: GET/PUT `/v1/integrations/chatwoot/destination` e POST
  `/v1/platform/organizations/:id/chatwoot/destination/approve`.
- A superfície nova depende de `CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED=true`, padrão desligado.
  O transporte para destinos externos depende ainda das tarefas B2/B3.

### Evidência registrada

| Verificação | Resultado |
|---|---|
| RED unitário | Falha por módulo de destino ainda inexistente |
| GREEN unitário de normalização/contrato | PASS, 21 testes |
| RED PostgreSQL | Tabela nova ausente no journal; teste também identificou falta de privilégio para lock na tabela organizations |
| Correção de lock | Advisory lock por organização, sem conceder UPDATE em organizations |
| PostgreSQL inicial | PASS, 5 testes antes da ampliação de aprovação administrativa |
| Upgrade real 0017 → 0018 | PASS, 1 teste; ciphertext/IDs/datas preservados |
| Typecheck após código B1 | PASS |
| HTTP e contratos B1 + regressão de autenticação | PASS, 25 testes |
| PostgreSQL B1 incluindo aprovação, concorrência e upgrade | PASS, 8 testes |
| Transporte QR/Chatwoot preexistente no PostgreSQL | PASS, 17 testes |
| Primeira suíte completa | 958 PASS, 2 FAIL esperados no inventário/OpenAPI anterior; contrato novo em geração/revisão |
| Inventário e OpenAPI atualizado | PASS, 23 testes; auditoria histórica preservada |
| Suíte completa final B1 | PASS, 960 testes / 130 arquivos, exit 0 |
| Contratos públicos e submódulos | PASS |
| `git diff --check` | PASS |

O teste de aprovação inicialmente usou e-mail sintético em maiúsculas, rejeitado pela
constraint preexistente. Corrigida a fixture para minúsculas; regra do produto preservada.

Após gerar o OpenAPI, a suíte também identificou as políticas explícitas ainda ausentes
do inventário de rotas. As três políticas novas foram registradas; a suíte completa final
passou. Nenhum teste foi removido ou relaxado.

Preparação Conversas: `bundle check` na imagem de laboratório passou; pnpm global 11
foi rejeitado pelo manifest. A instalação pelo pnpm 10.2.0 já presente no cache local,
com `--frozen-lockfile --ignore-scripts`, passou sem alterar o lockfile.

## Gates pendentes

B2–B7, J1–J5 e E1–E5 ainda não foram implementados/validados.
Nenhum piloto remoto ou telefone real foi usado. Ausência desses testes não é PASS.
O resultado local não libera produção.
