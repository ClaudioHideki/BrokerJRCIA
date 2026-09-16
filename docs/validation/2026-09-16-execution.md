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

B4–B7, J1–J5 e E1–E5 ainda não foram implementados/validados.
Nenhum piloto remoto ou telefone real foi usado. Ausência desses testes não é PASS.
O resultado local não libera produção.

## Tarefa B2 — transporte HTTPS com IP fixado

Implementação e gate local concluídos. B1 foi registrado no commit local `c47aed4`.

- O transporte padrão de `ChatwootClient` agora resolve todos os endereços A/AAAA,
  bloqueia faixas especiais, fixa o lookup usado pelo socket e preserva hostname/SNI/TLS.
- Não segue redirects autenticados; anexos só usam origens aprovadas, sem token de API.
- A exceção HTTP local continua exclusivamente na configuração do servidor para testes.
- Timeout cobre DNS/conexão/resposta; corpos têm limite. Multipart usa o encoder nativo.
- Políticas de rede consultadas nos registros oficiais
  [IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) e
  [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/), além da
  [orientação SSRF da OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

RED: módulo ausente. Typecheck inicial apontou uma opção de socket não declarada no tipo
`https.RequestOptions`; removida, pois a família IPv4/IPv6 já é fixada explicitamente.
GREEN inicial: 41 testes em quatro arquivos, incluindo servidor HTTPS local com
certificado descartável, IP efetivamente conectado, hostname, certificado não confiável,
limite de corpo chunked e cancelamento. Sem conexão a infraestrutura de terceiros.

Suíte completa B2: PASS, 994 testes / 132 arquivos, exit 0. Regressão PostgreSQL de
QR/Chatwoot: PASS, 17 testes. A revisão acrescentou um caso de status HTTP 700:
RED confirmou exceção assíncrona não tratada no adaptador; corrigido para rejeição
sanitizada `CHATWOOT_INVALID_RESPONSE`. Após essa correção, os dois arquivos de
segurança de transporte passaram com 35 testes, incluindo o caso novo. Esse caso
foi adicionado depois da coleta da suíte completa; não está incluído nos 994.

## Tarefa B3 — resolução por empresa

- `resolveChatwootContext` centraliza conta/destino para serviços, workers e anexos.
- Uma instalação somente externa dispensa origem global; chave de cifra isolada
  não habilita Chatwoot. Com chave e `PUBLIC_ORIGIN`, o transporte permanece ativo
  mesmo ao desligar a flag de novos cadastros externos.
- Token de plataforma exige MANAGED aprovado na origem global exata. Não é usado
  no Chatwoot externo. O provisionador revalida o destino antes das etapas externas.
- Rotação valida o novo token antes de substituir o ciphertext e usa revisão/versão
  e lock tenant para impedir sobrescrita concorrente. Credencial rejeitada conserva a anterior.
- Portal permite solicitar destino; administração aprova revisão e domínios de mídia.
  Não há campo de token enquanto a aprovação estiver pendente. Status explicita UNVERIFIED.
- Worker preserva a fila quando a aprovação é revogada. Alterar o destino enquanto
  se inicia uma conexão usa o mesmo lock e confere novamente a revisão.

RED unitário: resolvedor ausente. GREEN: 5 testes de contexto/runtime.
RED de interface: 2 falhas específicas, controles ainda ausentes; GREEN: 8 testes.
A primeira chamada `npm test` com caminhos de integração executou apenas os testes
web; o include padrão não contém integração. Os testes de banco foram depois
executados explicitamente com `npm run test:integration` — resultados abaixo.

PostgreSQL e dois servidores HTTP em loopback: primeira execução encontrou uma
fixture de conversa sem `phone_number`; corrigida para `null` conforme o contrato.
Teste adicional RED provou que a revogação consumia tentativa/transformava a tarefa
em FAILED; corrigido no claim e revalidado antes do consumo. GREEN: 22 testes em
dois arquivos, incluindo os 17 testes preexistentes de QR/Chatwoot. Após adicionar
rotação concorrente: arquivo novo PASS com 6 testes. Os dois servidores usam os
mesmos IDs de conta/inbox/conversa e validam o token esperado; não são terceiros.
O adaptador de teste redireciona somente suas duas origens ao HTTP local; DNS/TLS
de produção são cobertos separadamente pelos testes de socket de B2.

Typecheck, geração OpenAPI, contratos públicos e `git diff --check`: PASS.
Suíte completa B3: PASS, 999 testes / 133 arquivos, exit 0. O teste RED de B4,
criado depois da coleta desta suíte, fica fora do commit B3.
