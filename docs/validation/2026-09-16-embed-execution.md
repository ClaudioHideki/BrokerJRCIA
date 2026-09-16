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
