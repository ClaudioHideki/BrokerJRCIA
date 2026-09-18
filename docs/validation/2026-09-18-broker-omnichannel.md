# Validação — Broker independente, Flows e Chatwoot

Data: 18/09/2026. Branch Broker: `codex/broker-omnichannel-20260918`, base real
`48eb6635f4c7965ba34e8acb502ba4f3d5df3b74`. Branch JRC:
`codex/jrc-omnichannel-20260918`, base `3d0c981`.

## Continuidade e diferenças

- A base Broker já concilia integração nativa, destinos externos e os ajustes
  de Compose vindos de main. O protótipo local de Flows foi trazido da worktree
  `broker-flows-20260917`; a configuração guiada do módulo JRC veio de
  `broker-jrc-suite-20260917`. As duas origens permaneceram preservadas.
- Evolução adicional: transporte Agent Bot por caixa, eventos assinados,
  persistência, reconciliação de associação incerta, cancelamento por humano,
  isolamento/validação de contexto, filas e interface de ativação/histórico.
- JRC: preservado o candidato nativo Flows/Broker; acrescentadas guardas para
  que o Agent Bot ativo na caixa tenha prioridade sobre a automação nativa.
- Novas migrações Broker: `0024_flows` e `0025_flow_chatwoot`. Sem nova migração
  JRC nesta correção. Sem reconstruir os projetos ou substituir os sistemas.
- Referências de produção fornecidas pelo usuário estão no guia de operação.
  Não foi inspecionado nem alterado o ambiente de produção.

## Resultados reais

| Verificação | Resultado | Evidência local |
| --- | --- | --- |
| Suíte final Broker, unitários/HTTP/UI/repositório | **1.107 passaram**, 157 arquivos | `.codex/release-unit.log` |
| Suíte completa PostgreSQL/Redis antes do ajuste final de retentativas | **239 passaram**, 36 arquivos | `.codex/final-integration.log` |
| Regressão final transporte Agent Bot + migrações | **36 passaram**, incluindo dois casos novos de JSON inválido e fila | `.codex/queue-fixes-green.log` |
| Regressão final HTTP e links de interface | **13 passaram**; incluídos depois na suíte de 1.107 | `.codex/final-fixes-green.log` |
| Persistência/execução direta WhatsApp + Agent Bot + migrações, rodada anterior | **38 passaram** | `.codex/flow-runtime-regression.log` |
| TypeScript + Vite + geração OpenAPI | **Passaram** | `.codex/release-build.log`, `.codex/release-openapi.log` |
| Resolução dos pacotes compilados | **1 passou; 1 pulado** por ausência de URLs nesse comando | `.codex/release-compiled.log` |
| Inicialização real das imagens, com banco novo e migrações | **Passou**; API/web uid 1000 | `.codex/image-smoke.log` |
| Fluxo visual no Chromium com API simulada | **Passou**, zero erros de página | `.codex/visual-flows.log` |
| Auditoria npm | **0 vulnerabilidades reportadas** | `.codex/dependency-audit.log` |
| Bundle web/contratos públicos/licenças/submódulo | **Passaram**, 11 assets sem achados | scripts `test:web:bundle`, `security:contracts`, `security:notices`, `security:submodule` |
| JRC RSpec de Flows | **9 exemplos, zero falhas** | `.codex/ownership-green.log` na worktree JRC |
| Git diff check | **Passou** nos dois repositórios | `git -c core.safecrlf=false diff --check` |

As linhas da tabela se sobrepõem: não somar os testes específicos como se fossem
todos casos diferentes. A suíte completa de integração precedeu os dois últimos
casos; depois deles foram repetidos o transporte afetado e todas as migrações.
O teste de entrypoint compilado pulado não foi contado como aprovação; a
inicialização real foi verificada separadamente dentro das imagens finais.

RuboCop JRC: 77 ocorrências tanto na base quanto no candidato, nos seis arquivos.
Não é lint limpo. Dez diagnósticos existentes de complexidade/tamanho apresentam
valores maiores com as novas guardas; não houve limpeza geral desses métodos.
Comparação em `.codex/lint-baseline.json` e `.codex/lint-current.json` no JRC.

## Aceite funcional automatizado

| Requisito | Evidência |
| --- | --- |
| Empresa/conta/caixa isoladas | RLS, vínculo de credencial e testes de empresa diferente; HTTP deriva a empresa da sessão e recusa campos forjados |
| Conceder Flows pela administração | Platform + UI de empresa, bloqueio no serviço quando flag/empresa desabilitada |
| Editor e JSON | Testes do grafo/importação, criação/edição/publicação na UI, nós incompatíveis bloqueados |
| Canal WhatsApp direto | Estado/versão/outbox persistidos, evento duplicado e revogação em PostgreSQL real |
| Caixa externa sem canal WhatsApp no Broker | API/UI selecionam caixa de e-mail sintética, criam Agent Bot e associam à conta correta |
| Compatibilidade da instalação | Falha explícita se não houver segredo/token de assinatura; outro bot não é sobrescrito |
| Falhas de rede na associação | Retomada reconcilia por URL de callback, sem criar segundo bot quando a resposta se perdeu |
| Eventos e respostas | HMAC, bytes brutos, JSON inválido, notas privadas, resposta do próprio bot e eventos duplicados |
| Reinício e publicação | Sessão retoma na versão imutável original; transferência ocorre após a última resposta |
| Humano tem prioridade | Evento humano cancela pendências; estado/atribuição canônicos conferidos antes de executar e enviar |
| Consulta remota indisponível | Retentativa limitada com intervalo; não bloqueia outras conversas nem inverte a conversa afetada |
| Envio incerto/crash | UNKNOWN persistido, sem duplicação automática; ordenação conserva bloqueio das respostas seguintes |
| JRC não responde com dois motores | Conversa anterior à associação e execução nativa já pendente são interrompidas/canceladas |

O PostgreSQL/Redis e o Rails usados nos testes foram descartáveis e exclusivos.
Provedores e HTTP Chatwoot nos testes de transporte são simulados; não foram
usados credenciais, bancos, números nem payloads de produção. O teste visual
usa dados fictícios e comprova a interface, não uma conexão remota real.

## RED/GREEN e obstáculos resolvidos

- Os dois novos casos JRC falharam antes das guardas e passaram depois.
- Conflito HTTP e link Broker falharam antes do ajuste; JSON inválido e fila
  também falharam antes da correção. Logs `*-red.log` e `*-green.log` preservados
  localmente; falhas não foram ignoradas.
- A primeira rodada completa apontou expectativas desatualizadas de OpenAPI,
  inventário, mocks de status/contador, auditoria da plataforma e RLS das tabelas
  novas. Foram corrigidas e as suítes voltaram a passar.
- PostgreSQL/Redis dedicados foram usados; autenticação permissiva existe
  somente no PostgreSQL descartável de teste/serviço CI, nunca no Compose real.
- O sandbox impediu subprocessos de teste; execuções autorizadas fora dele
  completaram. Uma tentativa anterior de aprovação foi interrompida por créditos
  de revisão esgotados; após o usuário solicitar continuação, o mesmo caminho
  de aprovação voltou a funcionar. Não se contornou a revisão.
- O Docker estava sem sub-redes automáticas livres. Após inspecionar as redes,
  o smoke test usou `10.246.123.0/24` em projeto próprio; apenas esse projeto foi
  removido ao terminar. As redes dos outros laboratórios foram preservadas.

## Imagens finais locais

Construídas com `infra/app/Dockerfile`, após os ajustes finais de código:

| Tag local | ID informado pelo Docker local |
| --- | --- |
| `jrc-broker-api:omnichannel-20260918` | `sha256:df482a667f2645e48b6458a1b7acd9bb5965c5f8db3f2b764dc29cfe5716c724` |
| `jrc-broker-web:omnichannel-20260918` | `sha256:91f45f5e24acdfc01b12cfb2c5a6a83b7870d9938eb210bc3c5a8c392b3e5ec9` |

Esses IDs são artefatos do Docker local; **não são referências já publicadas em
GHCR**. API e web executaram como usuário não root. A API respondeu `/health`
e `/ready` com 200 e `/v1/flows/status` sem autenticação com 401; o web serviu
`/flows` e encaminhou `/health` com sucesso. O serviço de migração terminou com
sucesso no banco novo antes da API.

O workflow manual de imagens foi ampliado com PostgreSQL/Redis de teste e a
suíte de integração. Ele não foi disparado remotamente. Não houve push, merge,
publicação de imagens, deploy ou instalação do certificado TLS recusado pelo
usuário. A imagem JRC de produção não foi reconstruída nesta rodada; sua
correção foi validada no runtime Rails de testes.

## Limites e próximos passos de liberação

O candidato está construído e testado localmente. Ainda é necessário revisar e
publicar as revisões autorizadas, aplicar as migrações no ambiente de homologação
e validar números/canais de teste reais. Não se executou a totalidade da CI de
release/E2E remoto. Não declarar HA, paridade n8n/Typebot, interpretação de mídia,
entrega final ao destinatário ou homologação universal de forks Chatwoot.

O roteiro de configuração, imagem, piloto e rollback está em
[Broker independente e Flows](../operations/broker-omnichannel.md). No JRC,
consulte `docs/DEPLOY-BROKER-OMNICHANNEL.md`.
