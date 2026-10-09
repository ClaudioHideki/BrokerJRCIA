# Instalação do incremento HTTP e catálogo G1

Release da main `003aab1afd91ff80e01050c14a9781aae25a3681`, CI `37831296242`, imagens `37833925328`. Não instalada pelo agente. Inclui catálogo G1 e conservação de chamadas HTTP mutantes incertas; não inclui G2, persistência privada C2b nem módulos P9.

## Atualização no Dokploy

Na configuração privada do serviço Broker, alterar somente as duas referências abaixo. Conservar os demais valores e a Evolution já instalada. Não copiar senhas para este documento ou para o Git.

```dotenv
JRC_API_IMAGE=ghcr.io/claudiohideki/brokerjrcia-api@sha256:751e175f1533516659fc491ef34c8971546e099e6ec6df7482e32005ee45aa7a
JRC_WEB_IMAGE=ghcr.io/claudiohideki/brokerjrcia-web@sha256:fd45f2e6f0dae048879022745c2752fd4eec33e6c9df99ee4c187aa63deb4d1e
```

Salvar Environment. Em General, conservar branch `main` e Compose Path `./infra/dokploy/compose.yaml`. Usar o Compose desta revisão do repositório, com todos os workers. Os pools por processo têm opções no Compose e ENV de exemplo; seus defaults são preservados quando as opções são omitidas. Esta release não exige configuração S3 nova: a persistência privada C2b ainda está em desenvolvimento.

**Correção verificada no código em 09/10:** o serviço `migrate` possui perfil `maintenance`. O Deploy padrão não o executa, e API/workers não aplicam migrations em sua inicialização. A migração deve ser acionada explicitamente antes de iniciar a aplicação nova. Os comandos abaixo são para **Advanced → Run Command**, que acrescenta `docker`; não são comandos para o terminal dentro do container.

Fazer backup do PostgreSQL, Redis, volumes Evolution e configuração privada antes da manutenção, preservando as chaves existentes. Não usar `down --volumes` ou substituir o ENV completo pelo exemplo.

1. Confirmar PostgreSQL e Redis existentes saudáveis. Em uma janela de manutenção, inserir o comando abaixo em Advanced → Run Command, salvar e clicar General → Deploy. Ele para somente a aplicação e os consumidores; preserva banco, Redis e Evolution.

```text
compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml stop web api worker automation-worker automation-io-worker scheduler-worker lifecycle-worker
```

2. Substituir o comando temporário pelo seguinte, salvar e executar General → Deploy. A imagem API é a indicada no Environment salvo.

```text
compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm --no-deps migrate
```

Em Deployments → View, exigir execução sem erro e a mensagem `Schema and dedicated roles provisioned.`. O container é pontual e termina. Se houver erro, conservar os dados e corrigir antes de iniciar a nova aplicação.

3. Para conferir também os hashes do journal com a credencial do serviço de migração, usar este comando temporário, salvar e executar General → Deploy. A saída é somente o estado das migrations; não imprime o ENV.

```text
compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm --no-deps --entrypoint /bin/sh migrate -c 'SCHEMA_STATUS_DATABASE_URL="$MIGRATION_DATABASE_URL" node /app/apps/api/dist/db/schema-status.js'
```

Esperado: `state: CURRENT`, `compatible: true`, `expectedVersion` e `appliedVersion` iguais a `0050_whatsapp_group_catalog`, `pending: []`. O terminal da API usa `jrc_app`, que não possui leitura do journal; `SCHEMA_STATUS_UNAVAILABLE` nesse terminal não prova ausência de migration.

4. Apagar **todo** o campo temporário Advanced → Run Command e salvar. Deixar o campo vazio e clicar General → Deploy. O Dokploy monta o comando padrão e recria aplicação, workers e sandbox com as imagens selecionadas. **Não colar o comando completo abaixo em Advanced:** ele é apenas a prévia exibida pelo painel, que já acrescenta `docker`.

```text
docker compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml up -d --build --remove-orphans
```

Se for necessário preencher o campo manualmente, o conteúdo correto é somente `compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml up -d --build --remove-orphans`, sem o prefixo `docker`. Para encerrar a manutenção, preferir o campo vazio.

Conservar `AUTOMATION_RUNTIME_V2_ENABLED=true` e as configurações de destinos/control já autorizadas. Não aumentar shards, réplicas ou pools sem o orçamento do PostgreSQL. A imagem Evolution e os volumes continuam os existentes.

Conferir imagens/digests dos containers efetivos nas telas Containers/Deployments e os logs de migração. No Open Terminal do container api executar separadamente:

```sh
node -e 'fetch("http://127.0.0.1:3000/ready").then(async r=>{console.log("HTTP",r.status);console.log(await r.text());process.exitCode=r.ok?0:1}).catch(()=>{console.log("READINESS_FAILED");process.exitCode=1})'
```

```sh
node -p 'process.env.AUTOMATION_RUNTIME_V2_ENABLED ?? "NAO_DEFINIDA"'
```

```sh
node --input-type=module <<'NODE'
import pg from '/app/node_modules/pg/lib/index.js';
import { probeRequiredRuntimeSchema, RUNTIME_SCHEMA_BASELINE } from '/app/apps/api/dist/db/runtime-schema.js';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000, options: '-c default_transaction_read_only=on' });
try {
  await db.connect();
  console.log(RUNTIME_SCHEMA_BASELINE);
  console.log(await probeRequiredRuntimeSchema(sql => db.query(sql)));
} catch {
  console.log('FALHA_NA_CONSULTA');
  process.exitCode = 1;
} finally {
  await db.end();
}
NODE
```

Esperado: ready HTTP 200, runtime true e baseline `0050_whatsapp_group_catalog` com estrutura `true`. O probe verifica estrutura e grants necessários, não o hash completo do journal.

## Evidência do servidor em 09/10

Os quatro logs enviados pelo operador comprovam: parada dos serviços da aplicação concluída; execução do migrador com a imagem API `751e175f…` e mensagem `Schema and dedicated roles provisioned.`; journal `CURRENT`, `compatible: true`, versões esperada/aplicada `0050_whatsapp_group_catalog`, contagem 50/50 e `pending: []`.

Na quarta execução, o comando efetivo foi `docker docker compose …`, que falhou com `unknown shorthand flag: 'p' in -p` antes de iniciar o Compose. A falha é de montagem do comando no painel, não uma falha observada de migration. A orientação anterior ficou ambígua ao exibir a prévia completa. Correção operacional enviada: limpar Advanced → Run Command, salvar e executar General → Deploy.

O quinto log enviado pelo operador confirma o comando padrão correto, o pull da imagem web `fd45f2e6…`, recriação de API/web/workers/sandbox, PostgreSQL e Redis `Healthy`, API `Healthy`, todos os consumidores e web `Started`, e `Docker Compose Deployed: ✅`. A Evolution permaneceu `Running`. O aviso de swap não interrompeu a execução. Isso comprova a conclusão do deploy e a prontidão da API nesse momento; não comprova o pareamento WhatsApp, os heartbeats de aplicação nem a jornada real do bot. A inspeção funcional permanece em andamento.

A inspeção autenticada da console em 09/10 confirmou API, banco, schema, Redis e os quatro heartbeats operacionais, caixa QR conectada e automação de homologação publicada na versão 2 com vínculo ativo. O estado global degradado corresponde a `META_NOT_OBSERVED`, com zero caixas oficiais configuradas. Na integração real, havia falhas `CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION` e uma execução sem efeitos aguardando confirmação de controle pela central. A leitura da caixa API na central comprovou saudação desligada, nenhum AgentBot vinculado e atribuição automática ligada. Na caixa exclusiva de testes autorizada, a atribuição automática foi desligada pela UI e permaneceu desligada após recarregar. O ajuste não reprocessou entregas históricas nem retirou atribuições de conversas existentes. A jornada real depende agora da mensagem nova solicitada ao operador; não foi declarada aprovada apenas com esses checks.

## Homologação funcional

Usar somente a caixa física de testes autorizada do Welton. Confirmar vínculo publicado e versão, estado BOT na autoridade atual e workers recentes. Executar menu → escolha → captura → transferência humana → resposta do agente → retomada coordenada. Conferir uma única resposta por passo no aparelho e nos históricos; não trocar a caixa para CENTRAL para simular o resultado.

No catálogo G1, atualizar e comparar dois grupos reais com o aparelho, selecionar/desselecionar e reabrir para conferir persistência. A seleção não ativa automação em grupo; G2/G3 pertencem a entregas posteriores.

Para HTTP mutante, usar somente endpoint controlado e dados sintéticos: após perda de resposta comprovada, a execução deve conservar UNKNOWN, a espera IO e o bloqueio do efeito seguinte, sem repetir POST/PUT/PATCH/DELETE. Confirmar o efeito remotamente antes de qualquer reconciliação explícita. CONFIRMED_SENT sem resposta HTTP verificada não retoma IO.

Registrar commit/digests efetivos, versão da automação, correlações, horário e resultado sem conteúdo de clientes. Outros tenants e Chatwoot externo serão configurados para a matriz final P10. Se ocorrer falha, conservar registros/filas e diagnosticar; rollback de imagem exige revisar a compatibilidade das migrations e nunca reverter o banco cegamente.
