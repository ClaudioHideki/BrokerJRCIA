# Execução local — Dashboard App externo

Worktree `broker-chatwoot-embed-20260916`, branch `codex/broker-chatwoot-embed`,
derivada de `codex/broker-chatwoot-control` em `71be53229ec96d4644cecf58111bd6161ef77ad2`.
Baseline original Broker `9e530170cdda90ee8b9b673a28723180e0b2e1a3`; incrementos
B1–B7 e descoberta nativa preservados. JRC nativo concluiu implementação J1–J5 em
`3dd2e48b96d177776256fdcd1700e29bb0c9fed1`, com bloqueio explícito de build Docker
por recursos da máquina; 211 RSpec, 15 Vue, 3 contratos reais e 2 navegador passaram.

README/PROMPT, especificação, planos e matriz do pacote foram lidos. AGENTS aplica
TDD, regressão completa antes de commit e revisão de segredos. Execução manual por
tarefa; skills Superpowers indisponíveis nesta sessão. Nenhum subagente utilizado.

`npm ci --ignore-scripts`: 301 pacotes, audit sem vulnerabilidades. Submódulos nas
revisões travadas `fa09d378` e `3137df46`. Nenhuma alteração local do checkout de
origem, push, merge, publicação, deploy ou acesso a recursos de produção.

## E1 — registro e autorização limitada

Migração `0022_chatwoot_embed.sql`: apps, autorizações de 120 segundos e sessões
de cinco minutos, com hash do token, FKs por organização e RLS forçada. Resolução
pública retorna somente a organização para o servidor; HTTP policy expõe apenas
a origem aprovada. Nenhuma tabela contém QR ou credencial permanente do destino.

Nove rotas adicionadas ao OpenAPI: registro, policy, início, descrição,
aprovação/negação, troca, estado e pareamento. Aprovação exige JWT próprio,
origem exata e CSRF assinado. Sessão aceita somente leitura e reconexão de
integrações concedidas. Primeira conexão/identidade ainda requer portal/admin.
As permissões, identidade, usuário, conta, empresa e revisão do destino são
revalidadas, inclusive antes do despacho e após a resposta externa. Revogação
nega a próxima ação; restaurar uma concessão pode permitir novamente a sessão
ainda válida. Não há alegação de revogação permanente implícita.

Evidências privadas `.sessions/e1-*`:

- RED inicial: módulos/rotas ausentes e falta de redação de `qr`/`verifier`.
- Unitários: 11 provas criptográficas passaram.
- PostgreSQL: 7 cenários passaram, incluindo consumo único concorrente,
  prova incorreta, cinco falhas, negação, expiração, RLS e revogação. Duas
  instâncias do serviço compartilham o armazenamento de rate limit no teste;
  produção usa Redis. O limite inicial é dez inícios/minuto por par IP/embedId.
- Regressão PostgreSQL de auth/health/embed anterior: 16 testes passaram.
- Teste adicional detectou expiração durante a checagem de grants: RED real,
  corrigido com UPDATE condicionado a `clock_timestamp()` no consumo/aprovação.
  Um erro de fixture (`INACTIVE` em vez de `DISABLED`) foi corrigido; não é RED
  de funcionalidade. Nenhum token de teste deve ser copiado dos logs RED.
- Typecheck e scanner de contratos públicos passaram. OpenAPI regenerado.
- Regressão completa inicial: 1.026 passaram e uma falha esperada no OpenAPI
  antigo; nova execução após geração registrada abaixo antes do commit.
- Após gerar OpenAPI, a auditoria detectou nove rotas sem política explícita
  (oito falhas de teste). O inventário vivo foi atualizado com autenticação,
  autorização, RLS e exposição de desafios por rota; relatórios históricos
  de segurança foram preservados.

`CHATWOOT_EMBED_ENABLED=false` por padrão; depende também de control habilitado.
Sem chamadas a Chatwoot remoto, telefone, publicação ou implantação nesta etapa.

Gate E1: `npm test -- --maxWorkers=2` **1.028/1.028 PASS, 142 arquivos**, 192,38s
(`.sessions/e1-gate.log`). Auditoria focal: 26 PASS. OpenAPI repetido sem diff
contra o index revisado; `security:contracts`, typecheck e `git diff --check` PASS.

## E2 — superfície incorporável isolada

Header compartilhado entre API/helper e servidor web, restrito à origem HTTPS
canônica aprovada (sem wildcard, caminho, credenciais ou porta alternativa).
`frame-ancestors` permite apenas esse parent; `frame-src 'none'` impede subframes.
Console, login, administração e `/embed/authorize` continuam com XFO DENY e
`frame-ancestors 'none'`. Somente `/embed/chatwoot/:embedId` recebe exceção.

Servidor consulta a API interna fixa, sem headers/cookies do navegador, sem
redirect, com limite de 4 KiB e dois segundos. Não mantém cache entre clientes.
Falha, revisão revogada, flag off ou ID inválido produzem 403 não incorporável.
O HTML `embed.html` carrega somente sua entrada React/CSS e dependências comuns;
não importa App/rotas da console nem restaura cookies de login dentro do iframe.
Dockerfile copia explicitamente a entrada e o helper compartilhado.

Evidências `.sessions/e2-*`:

- RED: helper ausente, rota servindo console e falha de policy sem bloqueio correto.
- GREEN: 15 testes de unidade/HTTP passaram. A primeira execução identificou
  exceção de socket após destruir resposta excessiva; corrigida e repetida sem
  erros não tratados. Acrescentado timeout ao teste final de regressão.
- `npm run build`: PASS, 199 módulos; aviso de anotação upstream do Zod.
- `npm run test:web:bundle`: dez arquivos, nenhum finding.
- Chrome (`playwright.embed.config.ts`): três cenários PASS, 10,2s. Origem
  permitida/negada, /jrc/login/dashboard/authorize bloqueados e revogação sem
  cache. Confere ausência de bundle App e de restore da console no iframe.
  O navegador recebe headers e HTML do servidor web real, através de interceptação
  HTTPS local. A API de policy é fixture sintética; não é teste de Traefik/CDN
  remoto. Esse proxy final continua BLOCKED até homologação autorizada.

Sem service worker no projeto. Nenhuma imagem/container foi publicado ou implantado.

Gate E2: regressão completa **1.042 PASS / 143 arquivos**, 232,33s
(`.sessions/e2-gate.log`), incluindo timeout de policy. Diff check PASS.

## E3 — login próprio e sessão em memória

`/embed/authorize?requestId=UUID` reaproveita SessionProvider, login e seleção de
empresa existentes. Mostra usuário, empresa, origem/conta e caixas/ações antes
do consentimento; seleção inicialmente vazia. Troca de empresa desmonta o
formulário. Aprovação/negação enviam o CSRF assinado pela API first-party.

Iframe cria prova WebCrypto somente após clique; abre popup no gesto do usuário
e remove opener. Verifier/token ficam em campos privados do cliente, nunca no
estado React/URL/storage/postMessage. Fetch do iframe usa `credentials: omit`
e `cache: no-store`. Polling de autorização é de 1s, limitado à expiração;
sessão de 5min consulta estado a cada 5s e remove desafio em expiração,
revogação, pagehide ou mudança de contexto. Respostas antigas são descartadas.
Popup bloqueado oferece link first-party normal com requestId público e portal.

Contexto limitado a account_id/inbox_id/id da conversa, no máximo 64 KiB, origem
exata e janela parent. Dados de contato, mensagens e currentAgent não persistem
nem concedem acesso. Contexto de outra conta/caixa ou malformado nega sessão.
Como o fork só envia contexto no carregamento/pedido, o iframe solicita nova
leitura a cada 5s, com targetOrigin exato e sem conteúdo privado na mensagem.

TDD e regressão focal `.sessions/e3-*`:

- RED inicial: parser/cliente ausentes, CSRF da aprovação ausente e rota faltante.
- Contexto nulo inicial mantinha desafio: RED real, corrigido para negar também
  antes do primeiro contexto válido. Página exige ação explícita e mantém a
  URL pública através de login/seleção. Teste de sincronização passou a aguardar
  os dados da solicitação antes de procurar o botão.
- Typecheck detectou import Node em teste web; teste passou a usar WebCrypto,
  sem alterar a configuração TypeScript do frontend.
- Chrome detectou `fetch` nativo invocado como método do cliente (`this` inválido),
  antes de qualquer POST. Teste RED específico reproduziu a diferença dos mocks;
  chamada corrigida, **47 testes focais PASS**, build PASS (203 módulos).
- Fixture de auditoria de seleção corrigida para enviar o tipo do evento real;
  alteração somente na fixture, não nos controles de produção.
- Primeira rodada corrigida do Chrome: **6 PASS, 27,4s**. Auth/CSRF/handshake/RLS/
  grants/expiração são código real com PostgreSQL descartável. Apenas facade de
  estado/pareamento retorna código sintético; não há telefone/Chatwoot remoto.
  Chrome ativa `Network.setCookieControls` restringindo cookies de terceiros.
  Teste confirma ausência de cookie nos pedidos do iframe, consumo único e
  limpeza na revogação. Popup recusado e contexto com falso administrator também
  passaram. Traces/vídeos/screenshots permanecem desligados.

Rodada ampliada Chrome: **8 PASS, 1,9min** (`.sessions/e3-browser-final.log`),
incluindo expiração da sessão, empresa incorreta e request desconhecido/expirado.
Scanner do bundle: 11 arquivos, nenhum finding.

A regressão executada em paralelo com Chrome teve 1 timeout de Testing Library
no teste existente de filtro de conexões (1.061 PASS, 1 FAIL). Repetição focal,
sem alterar o teste: **14 PASS, 7,56s** (`e3-connections-recheck.log`). A repetição
completa sem navegador concorrente: **1.062 PASS / 146 arquivos, 189,39s**
(`.sessions/e3-gate-recheck.log`). Diff check PASS. E3 concluída localmente.

## E4 — instalação opcional e controles do portal

Migração aditiva `0023_chatwoot_dashboard_install`: estado, ID remoto e lease por
app existente, preservando RLS. `UNKNOWN` persiste antes do POST; listagem por URL
exata reconcilia, inclusive depois de restart. Sem transação aberta durante HTTP.
403/404 oferecem nome/URL para cadastro manual. Se já havia incerteza, a perda de
permissão para listar preserva UNKNOWN. Não altera transporte/inbox ao remover app.

API usa métodos list/create Dashboard Apps do cliente seguro existente, verifica
perfil de administrador e revalida destino/credencial antes de criar e retornar.
O contrato foi conferido no controller e views do fork Rails local. A validação
desta etapa usa fixtures remotas sintéticas; homologação de terceiros segue BLOCKED.

Portal inclui preparação/instalação sob ação explícita, alternativa manual e
controle de caixas sem conversa. Reutiliza ChallengePanel e contratos existentes,
acrescentando confirmação de identidade e edição de grants por administrador.
Leitor delegado usa apenas controle autorizado; não recebe papel OPERATOR legado.

TDD/evidências `.sessions/e4-*`:

- RED: funções/métodos de Dashboard Apps e componentes ausentes.
- Fixture PG inicialmente recusada por e-mail em maiúsculas: normalizada sem mudar
  constraint; falha de preparação, não contada como RED funcional.
- RED real: perda de permissão apagava UNKNOWN; corrigido. Sete testes de instalação
  PASS, incluindo concorrência, restart, app deletado e ausência de transação HTTP.
- RED real de banco: `jrc_app` não pode ler users. Criada projeção SECURITY DEFINER
  sem argumentos, restrita ao tenant corrente, somente ID/e-mail/papel. Mantida
  a proibição de SELECT direto em users; teste de isolamento incluído.
- UI inicial: 12 PASS. RED de resposta tardia reproduziu código de pareamento
  reaparecendo após revogação; revisão de ação descarta o resultado. Focal final:
  12 PASS em três arquivos, incluindo HTTP JWT-only, injeção de URL e no-store.
- PostgreSQL final: **15 PASS / 2 arquivos, 11,65s**, incluindo projeção sem tenant
  vazia, isolamento e SELECT em users negado (`e4-db-final.log`).
- Build/typecheck PASS; OpenAPI atualizado e revisado (três rotas, schemas
  estritos, JWT). Scanner de 11 arquivos sem findings; contratos públicos PASS.
- Primeira regressão: 1.070 PASS, um FAIL no inventário esperado do teste OpenAPI:
  faltavam as três rotas novas na lista explícita. Lista atualizada após revisão
  do diff gerado; sem afrouxar a comparação de endpoints.
- Gate final E4: **1.071 PASS / 149 arquivos, 183,43s** (`e4-gate-final.log`).
  Geração OpenAPI repetida com SHA-256 idêntico. Diff check PASS. Commit local.
