# Lifecycle e integração — evidências do segundo incremento

Base Broker: `526e2ac53de1e84cbba089ee43f85ee98fc8bb1b`.
Fonte JRC: lab2 `e4a6a007193988af3f314a902ec68531fd25a14a`.
Não houve alteração de instalação, credenciais, instâncias ou mensagens reais.

## Cobertura existente a preservar

Os nomes Broker abaixo são relativos a `apps/api/tests/`. Os testes JRC foram
inspecionados no objeto Git da revisão acima. Esta matriz é descoberta de
cobertura, não uma nova execução dessas suites.

| Requisito | Cobertura existente | Limite da prova |
| --- | --- | --- |
| Onboarding idempotente e recuperação por estágio | `integration/chatwoot-onboarding.test.ts`: concorrência/hash, resposta perdida, cancelamento e recuperação após provisionamento | PostgreSQL com HTTP sintético; recriar serviços não equivale a reiniciar processo |
| Identidade inicial com intenção e autorização | `integration/chatwoot-initial-identity.test.ts`: ordem, revogação, troca de contexto, concorrência | Provider simulado; não repetir regras de enrollment sem reexecutar esta cobertura |
| Inbox e binding no BFF JRC | JRC `spec/requests/api/v1/accounts/jrc_broker_spec.rb` e `spec/services/jrc_broker/context_sync_spec.rb` | Fonte preserva adoção, callback prematuro e deriva em voo; falta composição atual entre processos |
| Desafio QR por POST explícito e consulta sem repetir intenção | JRC `ConnectionPanel.spec.js`, `OnboardingFlow.spec.js`; Broker `unit/chatwoot-pair-operation.test.ts` | API simulada; reload durante operação pendente precisa de regressão da tela canônica Broker |
| QR efêmero e entrega única | `integration/chatwoot-pair-action-redis.test.ts` | Redis real exigido; não prova restart. Selecionar `TEST_REDIS_URL` explicitamente |
| Sessão conectada distinta de atendimento operacional | `integration/chatwoot-control-health.test.ts` e web `ConnectionHealthSummary.test.tsx` | Fixtures de transporte não comprovam ida/volta com provider |
| Callback, dedupe e recuperação JRC | JRC `jrc_broker_webhook_job_spec.rb`, `jrc_broker_contract_spec.rb` | ActiveJob adianta retries; o harness existente não comprova restart Sidekiq/Redis |
| Instalação conjunta | Harness JRC `tests/playwright/tests/e2e/ui/jrc-broker-contract.spec.ts` | Revisões antigas do README não transferem PASS ao par atual |
| Meta onboarding e ownership | `integration/meta-onboarding.test.ts` | Graph sintético; ativos, autorização e Embedded Signup reais permanecem homologação externa |

O helper PostgreSQL exige `TEST_DATABASE_ADMIN_URL` e cria banco descartável.
O Docker local não forneceu uma API utilizável: a primeira consulta encontrou
ausência do named pipe `dockerDesktopLinuxEngine`; depois de iniciar o Desktop,
uma consulta `info` ficou sem resposta e foi encerrada, preservando daemon e
containers. A leitura da GUI não foi concluída. Nenhum banco produtivo foi usado
para substituir essa dependência.

## Bugs descobertos nesta revisão

1. `ChannelDetail` condicionava o polling à presença de desafio. Uma página
   reaberta com `transportStatus=PAIRING`, ou uma resposta aceita com ação
   `NONE`, não iniciava acompanhamento automático. A correção deve consultar
   status sem repetir o POST e parar em estado terminal, revogação ou troca
   de contexto.
2. O PUT de agentes usava a operação remota de adição e ignorava a lista vazia.
   Isso podia reportar sucesso sem substituir/remover os agentes anteriores.
   A substituição deve manter separada a semântica de adição do onboarding.
3. O catálogo remoto de agentes era lido antes da mutação sem revalidar a
   autorização e o binding após esse I/O. Revogação durante a consulta precisa
   impedir o POST/PATCH remoto.
4. O QR da tela canônica era renderizado diretamente, sem o validador PNG já
   usado pelo painel legado. Falha de autorização e `pagehide` precisam limpar
   desafios mantidos em memória. Reutilizar a proteção existente, não criar
   armazenamento persistente para recuperar QR.

## Correções e resultados focais

- A tela canônica acompanha `PAIRING` após reload e resposta pendente `NONE`.
  Mantém uma requisição em voo, pausa quando oculta e aborta em purge, unmount
  e `pagehide`; não repete POST. Erros 401/403/404 interrompem o acompanhamento.
- O desafio usa `ChallengePanel`/`safeQrPngDataUrl`, sem URL externa ou SVG.
  QR/código são removidos em `pagehide`, purge, perda de acesso e estado terminal.
  Resposta de pair que chega depois de `pagehide` não republica o QR. Atualização
  manual terminal também descarta o desafio para que não reapareça em `PAIRING`.
- O PUT de agentes usa PATCH remoto de substituição, inclusive `[]`, e confere
  o conjunto observado antes de concluir a intenção. O POST aditivo do onboarding
  e da API legada foi preservado. Catálogo, credencial, destino e binding são
  revalidados após GET; callers de controle, onboarding, legado e plataforma
  revalidam autorização antes da mutação remota.
- Quando o catálogo remove a inbox selecionada, `ChatwootPanel` bloqueia o envio
  do ID antigo e exige nova escolha explícita. Atualizar não cria caixa e não
  troca silenciosamente o destino para criar uma nova.

| Verificação | Resultado observado |
| --- | --- |
| Polling canônico antes da implementação | 6 casos novos falharam por ausência de GET; `pagehide` adicional falhou por falta de abort |
| QR canônico antes da correção | 6 falharam / 1 passou; QR externo/SVG, retenção e resposta tardia reproduzidos |
| QR após refresh terminal, teste adicional RED | 1 falhou / 7 passaram; desafio antigo reaparecia ao voltar a `PAIRING` |
| ChannelDetail, desafio, jornada do bot, API de canais e ChallengePanel | 5 arquivos / 43 testes passaram |
| Agentes, contratos HTTP/cliente/plataforma | 4 arquivos / 37 testes passaram; 13 casos novos incluem revogação durante GET e readback incompatível |
| ChatwootPanel, onboarding e NativeJrcSetup | 3 arquivos / 21 testes passaram |
| TypeScript/build e scanner do bundle | Build exit 0; scanner 31 arquivos / nenhum finding; aviso de chunk grande permanece |
| Geração OpenAPI + comparação do contrato versionado | Exit 0, contrato sem mudança |

Os testes de backend deste lote usam transações e HTTP sintéticos. Não substituem
as suites PostgreSQL/RLS ou a homologação com Chatwoot real. O HTTP permanece
fora da transação: revalidar após o catálogo bloqueia alterações observadas durante
o GET, mas não desfaz uma requisição já despachada depois da última checagem.

A semântica de substituição foi conferida no controller/rotas do lab2 `e4a6a007`
e nas fontes oficiais Chatwoot
[v3.13.0](https://github.com/chatwoot/chatwoot/blob/v3.13.0/app/controllers/api/v1/accounts/inbox_members_controller.rb)
e [v4.0.0](https://github.com/chatwoot/chatwoot/blob/v4.0.0/app/controllers/api/v1/accounts/inbox_members_controller.rb).
Isso não comprova a versão ou customizações da instalação CCLX.

## Fechamento verificável do lote

- `npm test -- --maxWorkers=4`: **448 arquivos / 3459 testes passaram**, exit 0,
  378,80 s, após corrigir o fixture BASE64 antigo que continha texto em vez de PNG.
- `npm run test:partner-qr`: **2 arquivos / 34 testes passaram**, exit 0.
- `npm run build`: exit 0, incluindo TypeScript e Vite. Scanner de bundle:
  **31 arquivos / nenhum finding**. Aviso de chunk >500 kB permanece.
- Gerador OpenAPI e comparação do arquivo versionado: exit 0, sem mudança.
- Revisão independente: sem P1/P2 confirmado em UI e núcleo backend; callback
  final de plataforma conferido pelo coordenador, incluindo testes de sessão
  revogada e rebaixamento de papel durante GET.
- `git diff --check`: sem erros. Arquivos locais preexistentes `output/` e
  `tmp/` no checkout foram preservados e não integram o commit.

Logs locais, fora do Git: `broker-experience-lifecycle-final-suite-20261029.log`,
`broker-experience-lifecycle-build-20261029.log` e
`broker-partner-qr-lifecycle-20261029.log`, em `New project/output/`.

Não houve nova operação pública, migration, alteração de scopes, publicação ou
operação produtiva. O aceite de lifecycle permanece parcial até testes de banco,
composição conjunta, restart e providers reais.

## Portal gerado pelo build

O build inclui os assets estáticos de `/documentation/`. A consulta em navegador
à prévia do build `http://127.0.0.1:5200/documentation/` abriu Swagger e o perfil
“Mensageria por chave”, com escrita desabilitada e sem credencial informada.
Imagem local: `output/broker-experience-20261029/api-portal-built-local.png`.

O servidor Vite de desenvolvimento em 5199 gera esses assets somente no build;
nessa prévia a mesma rota caiu na SPA/login. Portanto, a prova do portal é da
prévia do build em 5200, e não da demonstração SPA em 5199. Nenhum proxy, porta
produtiva ou arquivo de implantação foi alterado para produzir esta evidência.
