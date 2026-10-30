# Reconciliação de infraestrutura, recuperação e release — 30/10/2026

## Escopo e prova

Inspeção somente leitura da árvore `BrokerJRCIA-source-audit/.worktrees/image-release-20260924`, HEAD `d1b66a56fe6d4f9202969784301abdf61490db45`, referência local `origin/main=be1e9441146d3ce8f9bc29b2f1b2fd135daf4371`. Caminhos e linhas abaixo são relativos a essa árvore, exceto o ZIP e os relatórios de publicação em `output/broker-phase2-20261029` na raiz do workspace. Nenhuma consulta ao host/produção, alteração de ENV, deploy, migração, backup real, Docker up/down, commit, push ou merge foi executada por este recorte. Documentos `docs/auditoria-900/12-INFRA-DOKPLOY.md`, `09-SEGURANCA-MULTITENANT.md`, `04-POSTGRES-PERSISTENCIA.md` são evidência histórica, reconciliada com o código atual, não estado atual do host.

Foi conferido o inventário do ZIP `Broker_JRC_Publicacao_Evidencias_2026-10-30.zip`: contém relatório de publicação, manifesto de release, diário, guard de migration, duas capturas e logs. O relatório informa publicação, schema 0077, preservação de PostgreSQL/Redis/Evolution e dispensa expressa do backup naquele deploy. Isso não prova a existência nem a ausência de backups externos. A verificação atual de servidor/GitHub cabe ao relatório principal.

`VALIDADO` abaixo qualifica a prova especificada (Git, código ou teste local), jamais homologação produtiva implícita.

## Compose main versus candidata

**VALIDADO por igualdade dos objetos Git** — não há drift nestes seis arquivos entre main e candidata:

| Arquivo | Blob Git comum |
|---|---|
| `infra/dokploy/compose.yaml` | `18e5097be7f1bd97f45060561a74f5b429cc289c` |
| `infra/dokploy/compose.fleet.yaml` | `743997068052a4974b97c90da2781b891bb996c3` |
| `infra/app/provision.mjs` | `7704e255a640f59dc0344f53773f80287412de0e` |
| `infra/app/postgres/init-roles.sql` | `465c708e921660ebb544d7dc0e593b90c55cfe34` |
| `scripts/operations/backup.mjs` | `5dead234310c2a9b217493b716c4ecab9a25c593` |
| `scripts/operations/restore-drill.mjs` | `7fef0f6307877f4c3a4d4f35c23ee393c3e9439f` |

Método: `git rev-parse HEAD:<arquivo>` versus `git rev-parse origin/main:<arquivo>`, além de `git diff --name-status origin/main HEAD -- infra scripts/operations apps/api/src/db`. Compose vir da main e imagens da candidata não é, por si, divergência comprovada de configuração. Igualdade dos arquivos não atesta o Compose resolvido, overrides, ENV ou quotas efetivamente aplicados pelo host.

## Imagens, recursos e isolamento

| Item | Situação | Evidência e limite |
|---|---|---|
| PostgreSQL fixado | VALIDADO no IaC | `infra/dokploy/compose.yaml:492`: `postgres:16.4-alpine@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c`. Digest efetivo em execução e CVEs da imagem não inspecionados. |
| Redis fixado | VALIDADO no IaC | `compose.yaml:518`: `redis:7.4.0-alpine@sha256:c35af3bbcef51a62c8bae5a9a563c6f1b60d7ebaea4cb5a3ccbcc157580ae098`. AOF, maxmemory 384mb e noeviction em `:521-530`; memória do container 512m em `:549`. |
| Engine fixada/proveniência | PARCIAL / NÃO VERIFICADO no host | `compose.yaml:554` recebe `${EVOLUTION_ENGINE_IMAGE:?required}`; `.env.example:5` pede imagem revisada. Nada aqui impõe sintaticamente `@sha256`. Commit do submódulo não atesta o binário da engine implantada. |
| API/web fixadas | PARCIAL no enforcement | `compose.yaml:98,145` exigem variáveis não vazias; `.env.example:3-4` exemplifica digest. O teste `tests/release-hardening.test.mjs:28-39` verifica textos, não recusa tag móvel na variável resolvida. |
| Checker de pins | PARCIAL | `scripts/check-compose-pins.mjs:5-11` rejeita somente imagem sem `:` ou terminada em `:latest`. Tags versionadas mutáveis e placeholders com `:` passam. `tests/compose-pins.test.mjs:5-8` cobre o baseline. Não chamar esse gate de validação universal de digests. |
| Build não root | VALIDADO no Dockerfile | `infra/app/Dockerfile:1,32,56` fixa Node 24.19.0 por digest; `:52,62` usa `USER node`. Engine usa imagem externa independente. |
| Limites declarados | VALIDADO no IaC / NÃO VERIFICADO no host | Web 0,5 CPU/256m; API 1/1g; messaging 1/768m; automation e IO 0,75/512m cada; partner, scheduler, history e lifecycle 0,25/256m cada; sandbox 0,5/160m; PG 2/2g; Redis 0,5/512m; Evolution 2/2g (`compose.yaml:125-593`). Limite não é reserva nem prova de capacidade. |
| Redes/volumes | VALIDADO no IaC | backend e sandbox internos, edge/egress e rede Dokploy externa (`:596-618`); PG/Redis/engine sem `ports` públicos nesse Compose. Um host e volumes locais não constituem HA. |
| Endurecimento | PARCIAL | API/workers/web com read_only, cap_drop e no-new-privileges; sandbox tem pids_limit 32. Esses controles não são universais para PG/Redis/Evolution. Só API, worker principal, PG e Redis têm healthcheck próprio (`:179,240,499,532`). Outros workers exigem heartbeat/telemetria operacional. |

Não confundir o Compose Dokploy com `infra/app/compose.yaml`: este último usa tags PG/Redis sem digest (`:54,68`) e conecta a engine com usuário postgres (`:90`), enquanto Dokploy usa `jrc_evolution` e banco separado (`infra/dokploy/compose.yaml:568`). O primeiro é caminho distinto, não descrição da implantação Dokploy.

## Pools, TLS e segredos

**PARCIAL — orçamento implementado, capacidade não medida.** `apps/api/src/db/pool-budget.ts:12-23` mantém APP/AUTH 10+10, platform 4, messaging 4+auth 2, automation/IO 4+4, scheduler/lifecycle/partner/history 2 cada. Uma instância de todos esses pools soma potencialmente **46** conexões Broker; isso não inclui engine, fontes externas de histórico, administração, migration, backup, monitoramento, conexões reservadas nem sobreposição de rollout. Não é número observado ou orçamento aprovado. APP/AUTH preservam aquisição sem timeout (0), demais defaults 5000ms; idle 10000ms. History max validado até 8; outros perfis até 100 (`:38-41`). Limite de entrada por processo não é teto global de PostgreSQL. Compare pools ativos e réplicas com max_connections/role limits reais antes de configurar.

**PARCIAL — TLS na borda, sem TLS interno declarado.** Traefik tem redirect-to-https externo e certresolver (`infra/dokploy/compose.yaml:134,140`); depende da configuração externa Dokploy. DSNs internos PostgreSQL não declaram TLS, Redis usa `redis://`, engine/API usam HTTP (`:7-8,41-42,75,102,568,572`). mTLS e certificados efetivos não foram verificados. Não se conclui que isso seja exposição pública, pois há redes internas; também não se pode anunciar criptografia ponta a ponta ou transporte entre hosts seguro com base nesse arquivo.

**VALIDADO no código / NÃO VERIFICADO operacionalmente — defesas de segredos.** `apps/api/src/config/env.ts:4-8,176-200` exige tamanho mínimo, rejeita exemplos conhecidos e segredos repetidos no conjunto validado. `infra/app/provision.mjs:11-24` valida senhas >=32 e usa `format(%I,%L)` para roles; `init-roles.sql:24-28` reaplica NOSUPERUSER/NOBYPASSRLS/NOINHERIT aos papéis Broker. Migrador aplica bootstrap e assume `jrc_migrator` (`apps/api/src/db/migrate.ts:18-38`). Senhas são ENV/DSNs; Redis também recebe senha no comando/healthcheck (`compose.yaml:525-539`). Portanto acesso a Docker/Dokploy continua altamente privilegiado; não há secret manager universal inferível. Rotação de chaves de cifra, recuperação delas e configuração real de logs da engine continuam pendentes de prova. Não foram lidos valores reais.

## Backup, restore e continuidade

**PARCIAL — backup de cinco artefatos, sem garantia sistêmica de recuperação.** `scripts/operations/backup.mjs:28-99` usa AES-256-GCM/AAD, nonce aleatório, arquivos exclusivos/permissão restrita e remove saída incompleta. `:120-143` autentica e verifica checksums dos cinco nomes permitidos. `:155-219` captura globals PostgreSQL, dump Broker, dump Evolution, tar de `/evolution/instances` e runtime.env. Falha de comando não publica manifesto completo.

Lacunas comprovadas por escopo do script: não captura Redis, bucket S3, múltiplas engines/fleet, Compose/overlays nem digests num manifesto; não agenda, replica offsite ou aplica retenção; dumps/tar são sequenciais e não estabelecem quiescência comum. Chaves e config adicionais em arquivos externos não são automaticamente incluídas pelo único runtime.env. O manifesto v1 tem hashes mas não HMAC próprio, diferentemente do pacote C5; cada arquivo continua autenticado por GCM. O script não demonstra consistência entre artefatos da mesma janela. `docs/operations/integracao-jrc-conversas.md:62-72` exige complementar Redis/digests/cópia externa e reconciliar pendências; é instrução, não execução atestada.

**VALIDADO como teste sintético; PENDENTE como restauração integral.** `scripts/operations/restore-drill.mjs:23-54` cria duas linhas de tenant e uma sessão fictícia; grava `synthetic-session`; restaura dois dumps em outros bancos do mesmo cluster; consulta contagens como postgres; consulta uma role que já existia; apenas lista o tar. Não restaura globals em cluster novo, runtime.env, arquivo de sessão no destino nem inicia Broker/engine. `infra/operations/restore-drill.compose.yaml:13-15` chama de evolution um container da imagem PostgreSQL com `sleep infinity`. Nenhuma jornada Baileys real é coberta. `rpoSeconds:0` é valor fixo desse cenário, não RPO observado do serviço. O script faz `down --volumes` do projeto de laboratório em finally (`:59`); **não foi executado nesta auditoria**.

**PARCIAL — C5 existe e amplia a recuperação, sem cobrir a instalação inteira.** `docs/operations/recovery-laboratory.md:3-29` descreve captura/restore real de banco efêmero, namespace Redis e objetos do ledger, HMAC no manifesto, GCM nos artefatos, journal e reconciliação de UNKNOWN. Limites: 64MiB/32 objetos/128 keys, alvo lab vazio, sem roles de cluster novo, sessões Evolution ou RDB/AOF global. `scripts/operations/recovery/postgres-recovery.mjs:5-8,21-25` restringe alvo e usa pg_restore `--exit-on-error --single-transaction`. A declaração de quiescência não pausa nem prova pausa dos serviços. Evidências históricas de testes C5 não substituem ensaio integral da release 0077. Nenhum ensaio físico C5 foi executado agora.

## Rollback: correção da recomendação do pacote

**P1 — PENDENTE: rollback binário sobre schema 0077 não está homologado.** A frase do relatório ZIP que recomenda restaurar os digests anteriores mantendo schema aditivo precisa ser qualificada como procedimento candidato, não recuperação garantida.

Causa comprovada: `apps/api/src/db/schema-status.ts:38-56` exige prefixo e contagem exata. O journal da base anterior `9e62cea` termina em 0074; o atual tem 77 migrations. Uma execução local do comparador puro com nomes/timestamps do journal e labels sintéticos de hash correspondentes, sem banco, retornou `DIVERGED`, `compatible:false`, expectedCount 74, appliedCount 77. Isso comprova o comportamento do **verificador de journal**, não que todo binário antigo deixe necessariamente de iniciar.

Readiness é outro contrato: `apps/api/src/db/runtime-schema.ts:19-20` explica que a role app não lê journal; em `:439-449` o probe verifica estruturas/funções e catálogos. A versão anterior não conhece todos os controles novos. Readiness verde de uma imagem antiga não prova semântica compatível nem autoriza reescrever journal. Migrations 0075 e 0077 acrescentam FKs/ledgers e alteram lifecycle/attempt fences (`0075_media_custody.sql:19-21,79-90`; `0077_partner_delivery_replay.sql:43-70`). Também podem existir dados criados pela candidata que exercitem caminhos desconhecidos pelo código anterior. A compatibilidade funcional e o probe antigo sobre esse banco não foram executados neste recorte; devem ser medidos, sem afirmar falha não reproduzida.

Aceite: cluster vazio isolado; schema 0074 e fixtures representativas; upgrade 0077; gerar recibos/replays/estados de conexão; trocar para os digests anteriores conhecidos; testar boot, /ready, journal, rotas e workers, conservação de ledgers, integridade e ausência de replay externo duplicado; repetir volta à candidata. Resultado deve definir por digest se rollback é suportado ou se exige correção progressiva. Não remover CHECK/colunas/grants nem editar journal para forçar READY. Restauração pré-migration é recuperação de dados, com risco de perda pós-backup e repetição de efeitos externos, e exige reconciliação própria.

## Homologação JRC independente do CCLX e ordem de trabalho

Nenhum item de infraestrutura desta lista é **DEPENDENTE EXCLUSIVAMENTE DO CCLX**. CCLX real será necessário para confirmar seus efeitos de negócio e persistência do consumidor; JRC pode fechar os seguintes ensaios usando receptor sintético próprio e recursos exclusivos de laboratório.

| Ordem / prioridade | Situação | Proposta e critério de aceite |
|---|---|---|
| 1 / P1 inventário | NÃO VERIFICADO | Identificar digests de cada serviço, arquitetura, engine e sua proveniência; Compose efetivo sanitizado, perfis, redes, mounts, quotas, storage, PG/Redis e orçamento host. Aceite: vínculo release→imagem→container e divergências explicitadas, sem exportar ENV/secrets. |
| 2 / P1 backup recuperável | PENDENTE | Definir RPO/RTO, janela consistente, escopo completo (PG/roles, Redis, S3, chaves, config, sessões de todas engines), retenção e cópia externa. Aceite: restaurar em host/cluster novo isolado e abrir bytes autorizados com RLS/roles corretos; evidência de horários, checksums e reconciliação de mensagens, sem reaproveitar sessões ativas em paralelo. |
| 3 / P1 rollback | PENDENTE | Executar matriz 0074→0077→binário anterior→candidata com dados novos e efeitos bloqueados/sintéticos. Aceite por digest, separando journal, readiness e comportamento; corrigir runbook conforme resultado. |
| 4 / P1 continuidade engine | PENDENTE | Engine homologada JRC com número/dispositivo de teste autorizado; falha antes/depois COMMIT, ACK perdido, queda de worker/engine e recuperação de sessão. Aceite: nenhum evento aceito perdido, duplicatas deduplicadas e UNKNOWN reconciliado. CCLX não é necessário; WhatsApp/dispositivo e engine são dependências próprias. |
| 5 / P1 pools/carga | PENDENTE | Inventariar conexões reais, limites por role, reserves e overlap; testar saturação de pools, lock waits, Pg indisponível, Redis noeviction cheio, reinício e backlog. Aceite: SLO/abort definidos previamente, filas limitadas e recuperação mensurável. Sem promessa de 50/400/900 a partir de defaults. |
| 6 / P2 transporte/segredos | PARCIAL | Conferir TLS público/cadeia/redirect e, se houver frota remota, canal TLS/autenticação real; testar falha fechada, rotação e recuperação de chaves em lab; logs com fixtures sem segredo. Aceite: credenciais/config não vazam e ciphertext antigo continua recuperável após processo de rotação aprovado. |
| 7 / P2 observabilidade | PARCIAL | Monitorar cada worker, idade de backlog, uso de pools, lag/IO/disco, memória/cgroup/restarts e integridade de backup. Aceite: falhas de componentes silenciosos disparam alarme e runbook mensurável; métricas não contêm payload/segredo. |

## Testes executados nesta revisão

Comando local: `node node_modules/vitest/vitest.mjs run tests/backup.test.mjs tests/compose-pins.test.mjs tests/release-hardening.test.mjs tests/database-pool-compose.test.mjs tests/dokploy-compose-config.test.mjs --maxWorkers=1`.

Resultado: **5 arquivos, 13 testes aprovados**, exit 0, 13,92s. O teste de Compose usa credenciais sintéticas e somente `docker compose config --format json`, sem iniciar ou alterar containers. Backup é round-trip de bytes e rejeição de chave errada/adulteração em diretório temporário; não é backup de banco. Testes de hardening são asserções estáticas, com as limitações de enforcement registradas acima.

Comparação de blobs Git: seis igualdades confirmadas. Comparador de rollback puro: DIVERGED com 74/77, sem acesso ao banco. Uma tentativa inicial de chamar git via subprocesso Node recebeu EPERM; a consulta Git foi realizada diretamente em PowerShell e o comparador puro usou o journal local. Nenhuma restrição foi contornada ou mudança elevada solicitada. Os demais ensaios de laboratório listados são pendentes, não foram executados.
