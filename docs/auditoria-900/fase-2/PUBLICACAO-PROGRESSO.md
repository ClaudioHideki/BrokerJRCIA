# Publicação e homologação JRC — progresso

Referência: solicitação de publicação oficial de 29/10/2026. Este registro sucede o encerramento local da Fase 2; não altera retroativamente suas evidências.

## Limites e sequência

- Preservar a candidata em codex/broker-audit-fixes-20261029, base 9e62ceaf3177979a68bc4985a93e25474de48487, e todas as alterações anteriores.
- Inspecionar infraestrutura real, atestar imagens e inventariar serviços compartilhados antes de modificar servidor.
- O plano original previa backup e restauração. O usuário dispensou a criação de backup posteriormente; migrations homologadas e revisão continuam necessárias antes da substituição produtiva.
- B02 não está resolvido; outbox durável na origem Evolution continua pendente. B03 não comprova custódia física definitiva.
- Não realizar carga contra serviços compartilhados nem disparar mensagens reais neste incremento de preparação.

## Incremento local: configuração do laboratório CI

Problema: ci.yml e images.yml forneciam usuário/database postgres e não declaravam cluster exclusivo. Os guards das novas integrações B03/B12 rejeitavam essa configuração antes de conectar.

Alterações:
- Ambos os serviços efêmeros PostgreSQL dos workflows usam lab_broker_admin/lab_broker_ci, sem volumes persistentes.
- DSNs e healthchecks foram alinhados ao serviço de cada job. A versão/imagem fixada PostgreSQL 16.4 permanece igual.
- As flags de exclusividade ficam na etapa de integração, e as suítes rodam com maxWorkers=1 para limitar interferência de alterações de roles globais.
- Não se alterou o guard, produção, Compose ou credenciais reais.
- Novo teste ci-exclusive-lab.test.ts analisa os workflows e aplica o guard real aos parâmetros, além de conferir serviço, identidade e execução sequencial.

Verificação observada:
- Antes da correção: 2 testes falharam com MEDIA_CUSTODY_REQUIRES_EXPLICIT_EXCLUSIVE_LAB_CLUSTER.
- Depois: 2 arquivos, 14 testes aprovados (ci-exclusive-lab e exclusive-lab), zero falhas.
- Typecheck tsc -b --pretty false: exit 0.
- Suíte geral repetida neste incremento: 463 arquivos, 3.602 testes aprovados, zero falhas, exit 0, duração 567,43 segundos. Log local: output/broker-phase2-20261029/publication-unit.log (na raiz do workspace). Nenhum commit novo foi criado.
- Integrações PostgreSQL/Redis reais, Actions remotas, build/publicação e restore permanecem não executados neste incremento.

## Acesso ao servidor

O inventário do navegador lista a aba Dokploy do serviço Broker CHpunqOjNpNu-hv6TZLRb, mas a aquisição pela API documentada retorna browser.user is unavailable. A existência da aba não comprova leitura do servidor. Solicitada reinicialização do aplicativo Codex, sem reiniciar serviços.

## Próximos gates

1. Recuperar acesso de leitura ao Dokploy e coletar inventário/digests/configuração sanitizada.
2. Disponibilizar cluster descartável exclusivo, conferir versão real do PostgreSQL e executar migrations, RLS, concorrência e regressões.
3. Implementar e provar continuidade na origem Evolution; finalizar pendências internas e simulador conforme plano autorizado.
4. Documentar rollback e a dispensa de backup pelo usuário. Revisar diff, rodar build/gates e preparar commits/PR.
5. Somente após os pré-requisitos, publicar candidata por SHA e implantar de modo controlado; manter CCLX real e capacidade física explicitamente não homologados até prova.

## Atualização após recuperação do navegador

Acesso recuperado na nova aba 8. Inspeção do serviço Broker de produção, sem salvar configurações:
- 13 containers em execução; API, worker principal, PostgreSQL e Redis marcados healthy pelo Dokploy.
- API: Node v24.19.0; journal contido na imagem com 74 migrations, última 0074_partner_media. Isto não atesta o digest nem o histórico aplicado.
- Consulta pelo comando schema-status retornou SCHEMA_STATUS_UNAVAILABLE; não afirmar migrations aplicadas a partir disso.
- Consulta pg via DATABASE_URL em BEGIN READ ONLY: PostgreSQL 16.4, banco jrc_broker, 204247523 bytes no momento observado.
- Backups e Volume Backups deste serviço sem configuração. Destino existente bkp: endpoint https://s3.jrcws.cloud, bucket dokploy-backups, região br-east-1. Apenas cadastro observado; credenciais omitidas e nenhuma escrita/teste de storage executado.
- Origem Compose configurada no Dokploy: repositório BrokerJRCIA, branch main, infra/dokploy/compose.yaml; autodeploy desligado. Isso não prova a origem da imagem em execução.
- Fetch origin executado com sucesso: origin/main be1e9441146d3ce8f9bc29b2f1b2fd135daf4371; HEAD contém a main, 11 commits à frente e zero atrás.

Orientações posteriores do usuário: não criar backup; não criar PostgreSQL/Redis separados no servidor; usar serviços e dados reais. Não foi criado nenhum desses recursos. A proposta local de manifesto separado foi abandonada antes de criar o Compose; seu teste preliminar foi retirado. Diagnósticos produtivos permanecem somente leitura ou operações controladas sem perda. Suítes que recriam bancos/roles continuam restritas aos serviços efêmeros já definidos na CI; a autorização geral de usar dados reais não especifica exclusão ou alteração destrutiva de dados/roles.

O Docker local não respondeu em 10 segundos à consulta de versão fora do sandbox (ETIMEDOUT); nenhum daemon foi reiniciado.

## Conferência adicional dos serviços reais

- PostgreSQL: consulta via psql com default_transaction_read_only=on e statement_timeout=5000. A tabela drizzle.__drizzle_migrations possui 74 registros, último created_at=1793918400000.
- Fingerprint do histórico ordenado (hash de migration + timestamp): 5ae1001216712eab6f284121bb76a02c. O cálculo local sobre as primeiras 74 migrations, usando readMigrationFiles de drizzle-orm/migrator, produziu exatamente o mesmo valor. Isso confirma correspondência do histórico; não identifica o digest da imagem. As migrations 0075–0077 da candidata não foram aplicadas.
- Amostra de conexões: jrc_evolution=49, jrc_broker=9 (inclui consulta), processos sem database=5. max_connections=100, shared_buffers=128MB. Os dois bancos compartilham o cluster; a amostra não demonstra capacidade de 50/400/900 sessões.
- Redis: tentativa somente leitura de INFO no terminal local retornou NOAUTH Authentication required. Nenhum dado de fila foi lido, nenhuma chave foi alterada e não houve tentativa de desabilitar autenticação. Métricas e persistência Redis ainda não verificadas.
- S3: cadastro do destino existente confirmado; acesso a objetos, retenção e custódia ainda não testados.
- Terminais de diagnóstico encerrados sem reiniciar containers.

Situação: em andamento. Nenhuma implantação, push, migration produtiva, backup ou alteração de dados foi executada.

## Candidata autorizada para publicação

O usuário solicitou aplicar as mudanças e atualizar o servidor. Build local repetido: exit 0; permanece aviso Vite de chunk superior a 500 kB. Revisão independente do diff não encontrou novo P0/P1 inequívoco, mas condiciona implantação a integrações PostgreSQL e storage verdes.

- Revisão independente: 3 arquivos / 12 testes aprovados (CI exclusiva, readiness e ordenação), diff-check aprovado.
- Suíte geral da revisão: 463 arquivos / 3.602 testes aprovados; apenas normalização de linha em branco no fim de um teste foi feita após essa execução.
- Scanner de segredos dos 76 arquivos preparados: zero achados das regras disponíveis; não equivale a pentest.
- Ordem obrigatória: validar imagem na CI, registrar imagens atuais, aplicar migrations 0075–0077 pela imagem candidata, atualizar API/web/workers, conferir readiness e regressões. O serviço migrate usa profile maintenance e não roda automaticamente como dependência da API.
- 0075 cria UNIQUE em mensagens e 0077 altera/backfill de deliveries: conferir volumes/locks e limitar tempo de espera. Rollback binário deve preservar schema aditivo, recibos e ledger; não apagar tabelas para voltar imagem.
- B02 permanece pendente; a atualização não promete replay durável na origem Evolution nem homologação definitiva CCLX.

## Gate SQL da publicação de 30/10/2026

Candidata `eed920ca9344f6a63ffd0b3267ccaa5f65906b5d`, PR draft #5, workflow de imagens 40994546327. Build, 3.602 testes unitários (incluindo seis de PDF), bundle, submódulo, auditoria npm e fonte do Flow passaram. Integração: **1.505 testes aprovados e 21 falhos em 16 arquivos**, de 1.526 testes/153 arquivos. Nenhuma imagem foi publicada por esse run; storage e builds Docker foram corretamente interrompidos pelo gate.

Causas confirmadas nos stacks e SQL:

1. A sonda nova de prontidão fazia cast direto de `partner_webhook_endpoints` para regclass. Em bases antigas anteriores à tabela, PostgreSQL falhava ao analisar a query, antes de retornar false. Os três alvos da FK agora usam `to_regclass`, preservando a contagem obrigatória e os demais checks; os testes de upgrade existentes continuam exigindo false antes e true depois de migrar.
2. A leitura idempotente de `media_custody_receipts` usava FOR SHARE, que exige UPDATE no PostgreSQL. O ledger deliberadamente só concede SELECT/INSERT. Removido somente esse lock de linha: o advisory lock transacional por tenant, locks das referências, unicidade, revalidação de autoridade e imutabilidade permanecem. Não foram ampliados grants. Os cinco testes SQL existentes cobrem replay concorrente, isolamento, integridade, revogação e imutabilidade.
3. O catálogo esperado no teste geral de migrations omitia `media_custody_tenant` e `partner_replay_tenant`. Incluídos os dois nomes, com role jrc_app e comando ALL previstos nas migrations, sem enfraquecer a comparação exata.

Pré-verificação do servidor: 2.463 mensagens (estimativa pg_stat), zero partner deliveries, zero locks esperando e zero transações maiores que 30 segundos. As 99 variáveis existentes foram conferidas em memória, sem gravar segredos em arquivos. Environment, containers e banco produtivo permanecem sem alterações desta publicação enquanto os gates são corrigidos e repetidos.

Verificação das correções: build e typecheck exit 0; revisão independente dos três arquivos sem bloqueador adicional, 19 testes focados aprovados. A regressão local completa teve 458 arquivos aprovados e cinco suítes afetadas por spawn EPERM do Git/OpenSSL no sandbox (9 falhas e 4 skips). Reexecução exclusiva dessas cinco suítes fora do sandbox: **5 arquivos / 41 testes aprovados, zero falhas**. Assim, os 463 arquivos/3.602 casos estão cobertos pelas duas execuções; os resultados SQL ainda dependem da nova CI. Nenhum grant foi ampliado e nenhuma migration foi reescrita.
