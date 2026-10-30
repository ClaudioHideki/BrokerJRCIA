# Broker: release candidata de 23/10/2026

Este roteiro registra a verificação local da candidata e prepara a manutenção
da baseline `0072_chatwoot_campaign_intents` para
`0073_chatwoot_initial_identity`. Não registra publicação de imagem, backup,
migração ou deploy realizados. A fonte examinada é a árvore candidata sobre
`be1e9441146d3ce8f9bc29b2f1b2fd135daf4371`; esse SHA de base não identifica uma
nova imagem publicada. O implementador principal registra o commit final e o
par de digests antes da execução da release.

## Evidências e limites

| Verificação | Resultado disponível | Limite |
| --- | --- | --- |
| Gate integral local após a correção documental | 442 arquivos / 3.395 testes, exit 0, 1.000,24 s; log privado `.sessions/broker-npm-test-post-doc-correction-20261023.log` | Não executa o transporte real do CCLX ou WhatsApp |
| Build local final | `npm run build` GREEN em 23/10, 12:51–12:52, confirmado pelo implementador principal | Não comprova imagem publicada ou executada no servidor |
| Bundle web e contratos | 31 arquivos examinados, findings vazios; contratos, sete notices e referência upstream `fa09d37892cdbb1d65a250155d293d92230c5b30` verdes | Verificações locais comunicadas pelo implementador principal |
| Workspace compilado | Um teste GREEN; teste de entrypoint SKIPPED por falta de ENV PostgreSQL/Redis neste ambiente | O skip não é prova de inicialização; a CI com serviços deve executar esse teste |
| OpenAPI compilado | Comparação byte a byte com o canônico, SHA256 `ff9b93f8335bd151ec2e900ae5e8da295d294a0b5af735e043f2eee92022abe0` | O artefato local não comprova atualização do portal em produção |
| PDF e contratos públicos | Manifesto com 34 operações; PDF SHA256 `9b3848d889a640e3cc1977581b06eaf23c47551db8bbdc71b4f2813a81b1b6ca` | Flow mantém autenticação e contratos separados; sem homologação runtime CCLX |
| Produção atual | Leitura do implementador principal às 15:49 UTC: READY, baseline0072 compatível, PostgreSQL16.4 e 13 containers em execução | É a instalação anterior; esta revisão não acessou ou alterou produção |
| Backups no Dokploy | Abas Backups e Volume Backups sem rotina configurada na leitura de 23/10 | Não exclui backups externos ou do host; existência, destino e restauração continuam por verificar |

O leitor encontra os detalhes funcionais e os RED/GREEN em
[matrícula inicial QR](../superpowers/plans/2026-10-23-initial-qr-identity.md) e
[documentação pública](../superpowers/plans/2026-10-23-public-api-documentation-refresh.md).
Logs, dumps, ENV, sessões e arquivos privados não acompanham o commit.

## Migration 0073: alteração e bloqueios

A [migration0073](../../apps/api/drizzle/migrations/0073_chatwoot_initial_identity.sql)
executa um único `ALTER TABLE chatwoot_connection_health`:

- acrescenta `initial_identity_intent jsonb`, `initial_identity_expires_at
  timestamptz` e `initial_identity_pair_expires_at timestamptz`, todas nullable e
  sem default;
- acrescenta a CHECK validada `chatwoot_initial_identity_shape`;
- não faz UPDATE/backfill, não cria tabela, índice ou trigger, não altera
  fingerprints aprovados nem processa respostas pendentes.

Na fonte examinada, o SQL tem 982 bytes e SHA256
`a924b9b6f46872f370c5038373589392d975146ff29e0cae7691bb54b8bbd9bf`.
Conferir também o hash efetivamente empacotado na imagem aprovada.

Linhas anteriores entram com as três colunas nulas e satisfazem a CHECK. A
tabela conserva o proprietário `jrc_migrator`, RLS forçada, política tenant,
política lifecycle e cobertura de expurgo existentes. O
[teste de upgrade](../../apps/api/tests/integration/chatwoot-initial-identity-upgrade.test.ts)
cobre a preservação de uma observação legada sem aprovação e de uma resposta
PENDING, além do gate estrutural e da negativa a `jrc_auth`.

A adição dessas colunas não exige reescrever os registros. Entretanto, a CHECK
é adicionada validada e precisa verificar a tabela. O comando adquire
`ACCESS EXCLUSIVE`, bloqueando leituras e gravações concorrentes até o commit;
a duração inclui a espera por transações anteriores e a varredura da tabela.
Essa semântica está documentada no
[ALTER TABLE do PostgreSQL16](https://www.postgresql.org/docs/16/sql-altertable.html).

Para uma tabela pequena de saúde por conexão, execução em segundos é uma
expectativa operacional, não uma medição ou garantia. Esta revisão não mediu
linhas, tamanho, I/O ou bloqueadores no servidor. O migrador atual não define
`lock_timeout` ou `statement_timeout`; uma transação longa pode prolongar a
espera. Planejar janela, verificar tamanho e transações abertas, executar um
único migrador e acompanhar os bloqueios. Não prometer migração sem interrupção.

O [migrador](../../apps/api/src/db/migrate.ts) também executa o bootstrap de
roles; o [provisionamento](../../infra/app/provision.mjs) reaplica as senhas
dedicadas já fornecidas pelo ENV. Manter os mesmos valores. Esse trabalho
adicional faz parte do tempo total da manutenção, embora não seja backfill0073.

## Compose e ENV

Este incremento não acrescenta serviço, volume, porta, role, credencial ou
variável de ambiente. Reutiliza o serviço `migrate` do perfil `maintenance` em
[infra/dokploy/compose.yaml](../../infra/dokploy/compose.yaml) e o worker de
mensageria existente. As flags e credenciais atuais continuam válidas; a nova
matrícula não pede autorização manual extra nem uma chave por caixa. Não
habilitar bot ou campanha como etapa da atualização.

API, workers e sandbox devem usar o mesmo novo `JRC_API_IMAGE`; web deve usar o
`JRC_WEB_IMAGE` correspondente ao mesmo commit. Guardar o par anterior por digest.
Preservar `EVOLUTION_ENGINE_IMAGE`, serviços de dados, configuração e chaves.
Não usar `latest`, `down --volumes` ou um comando de manutenção como comando
permanente de deploy. Os roteiros antigos que citam baseline0068 ou serviços
adicionados em setembro são históricos; não repetir suas adições de segredos.

## Backup pré-migração: menor percurso existente

O estado das abas do Dokploy ainda não comprova um ponto recuperável. Antes da
migração, identificar e verificar um backup existente ou produzir uma cópia na
janela autorizada. Não criar nesta etapa destino remoto, bucket, credencial,
chave ou permissão novos. Se não houver destino privado e chave já disponíveis,
esse requisito permanece aberto; não substituir silenciosamente por dump
desprotegido, nem declarar o backup concluído.

1. No servidor atual, identificar o projeto Compose e os caminhos reais do
   Compose, ENV privado e destino de backup já autorizado. O projeto documentado
   é `jrc-broker-broker-ophydn`; confirmar a identidade antes de qualquer ação.
   Verificar espaço livre para os artefatos e temporários, acesso restrito do
   operador e recuperação da chave existente sem imprimir valores.
2. Registrar baseline/journal atual, revisão e digests efetivos, versões dos
   serviços, driver/localização de mídia e horário. Guardar esse inventário
   privado com a evidência da release; não exportar o ENV em texto para o log.
3. Para uma cópia coordenada, organizar a pausa de produtores e consumidores,
   aguardar envios em curso e estabilizar gravações do motor e demais dados.
   Essa pausa é uma operação de manutenção a autorizar/executar separadamente;
   nenhum comando deste documento já a efetuou.
4. Reutilizar o [backup.mjs](../../scripts/operations/backup.mjs) no host com
   Node e Docker CLI, usando `JRC_BACKUP_KEY` existente no ambiente privado e
   `JRC_BACKUP_COMPOSE_PROJECT` com o projeto confirmado. Os marcadores abaixo
   não são caminhos comprovados nem comandos executados:

   ```sh
   node scripts/operations/backup.mjs backup "<COMPOSE_ATUAL>" "<ENV_PRIVADO_EXISTENTE>" "<SUBDIRETORIO_NOVO_NO_DESTINO_JA_APROVADO>"
   node scripts/operations/backup.mjs verify "<SUBDIRETORIO_NOVO_NO_DESTINO_JA_APROVADO>"
   ```

5. Exigir exit0 dos dois comandos e manifesto com cinco arquivos, seus hashes
   e autenticação AES-256-GCM verificados. Validar os dumps com `pg_restore -l`
   após descriptografia somente em área privada já autorizada; um catálogo
   legível ainda não substitui restauração isolada. Registrar bytes, horários e
   hashes sem copiar dados de clientes para Git ou para este documento.
6. Confirmar cobertura do Redis e dos objetos privados pela rotina já
   existente. Manter as chaves de integração, Meta, MFA e versões do cofre
   recuperáveis e protegidas. Se faltar qualquer componente, registrar a lacuna
   e não rotular o conjunto como recuperação integral do servidor.

O utilitário gera `roles.sql.jrcbak`, `broker.dump.jrcbak`,
`engine.dump.jrcbak`, `engine-files.tar.gz.jrcbak` e `runtime.env.jrcbak`, mais o
manifesto. Faz streaming cifrado; não instala agendamento ou cópia externa.
Pressupõe os serviços `postgres`/`evolution`, bancos `jrc_broker`/
`jrc_evolution` e sessões em `/evolution/instances`. Os scripts de operações
acompanham a fonte e não são copiados pelo Dockerfile para a imagem API.

Cada `pg_dump` fornece um snapshot consistente do seu banco, inclusive com
usuários concorrentes, conforme o
[pg_dump do PostgreSQL16](https://www.postgresql.org/docs/16/app-pgdump.html).
Os dois dumps, arquivos do motor e ENV são coletados sequencialmente, sem
snapshot atômico da stack. Redis e bucket S3 não são coletados por esse
utilitário. Um backup somente no mesmo servidor não protege contra a perda do
host. O procedimento não demonstra RPO, RTO ou PITR produtivos.

O [restore-drill](../../scripts/operations/restore-drill.mjs) usa uma stack
sintética descartável. O [CLI de recuperação](recovery-laboratory.md) tem
restrições explícitas de laboratório, loopback e orçamento; nenhum dos dois
deve ser apontado para produção como atalho. A documentação de cobertura e
restauração permanece em [integração JRC](integracao-jrc-conversas.md) e
[operação Dokploy](dokploy-saas.md).

## Sequência de migração e verificação

Após commit/digests aprovados, backup verificável e janela de manutenção,
executar uma única vez o serviço `migrate` com a imagem API nova pelo percurso
existente. Preservar o projeto e ENV reais, e conferir que a única migration
pendente é 0073; divergência de hash ou outras pendências exige diagnóstico.
Exigir exit0 e journal/hash coerentes antes de trocar os processos. Não
reaplicar o SQL manualmente nem editar o journal.

Depois, subir os processos da revisão aprovada e verificar separadamente:

- `/ready` e `operational-status` com baseline0073 compatível;
- comparação exata do journal/hash por `db:schema:status` da imagem nova;
- imagens/digests efetivos e estado de API, web e workers;
- vínculos, identidades legadas e filas preservados, sem ativação de bot,
  campanha, pareamento ou envio como efeito da atualização.

Readiness, schema compatível, portal atualizado e containers em execução são
verificações distintas de entrega de mensagens. Homologação CCLX e operação
real de provedor permanecem jornadas autorizadas separadas.

## Rollback de imagem: manual e não homologado

A alteração é aditiva para linhas antigas e para linhas cujas três colunas
novas estejam nulas. Isso não basta para declarar rollback seguro após uso da
candidata:

- a CHECK0073 exige `approved_fingerprint IS NULL` enquanto houver intenção;
  o `confirmIdentity` da imagem0072 atualiza a aprovação sem limpar as colunas
  novas e pode receber violação de `chatwoot_initial_identity_shape`;
- mesmo uma intenção expirada continua incompatível com essa escrita enquanto
  armazenada; a imagem0072 não conhece sua limpeza;
- o `db:schema:status` antigo compara a cadeia exatamente e classifica um
  journal com0073 como `DIVERGED`. O probe estrutural antigo verifica apenas
  os objetos conhecidos e pode passar: isso não torna os dois resultados
  equivalentes.

Não há nesta entrega ensaio que homologue o retorno da imagem0072 sobre linhas
criadas pela0073. Antes de prescrever rollback, é necessário testar essa
combinação em PostgreSQL isolado, definir um procedimento compatível e ensaiar
os casos com intenção pendente/expirada, confirmação, desconexão e reinício.
Qualquer revogação/limpeza de intenção exige manutenção, backup recuperável,
comando previamente testado e autorização específica. Este roteiro não fornece
nem executa SQL de limpeza, remoção de CHECK/colunas ou alteração do journal.

Uma restauração do backup pré-migração é recuperação de dados, não simples
troca de imagem. Pode perder gravações posteriores e ressuscitar pendências
já entregues externamente. Deve ser feita primeiro em ambiente isolado, com
produtores/workers parados e reconciliação de SENDING/UNKNOWN, preservando
segredos, isolamento de tenants e sessões. Não reaplicar filas cegamente.

## Pendências da execução de release

- [ ] Registrar commit final, CI da revisão e digests API/web aprovados.
- [ ] Verificar backups externos existentes, destino privado e chave
  recuperável; capturar e validar o ponto pré-migração se necessário.
- [ ] Medir tamanho/bloqueadores e definir a janela da migration0073.
- [ ] Homologar o procedimento de rollback; permanece manual e não comprovado.
- [ ] Aplicar migração/deploy na janela autorizada e guardar evidências
  sanitizadas. Nenhuma dessas operações foi executada por esta revisão.
