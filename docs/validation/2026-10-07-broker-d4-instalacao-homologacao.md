# D4 — Instalação e homologação do canal central

Este incremento permite configurar no Broker uma caixa já conectada em uma central JRC Conversas/Chatwoot. O transporte CENTRAL usa a API dessa central; não cria outra instância QR nem cadastra um ativo Meta fictício. QR e Meta conectados ao Broker conservam seus caminhos existentes.

## Publicação e instalação

A entrega deve usar API e Web do mesmo commit aprovado da main, com digests publicados pelo workflow de imagens. Os valores específicos e links de CI serão fornecidos no registro de release; não usar uma tag mutável como evidência de versão instalada. API, workers e sandbox usam o mesmo digest API. Evolution, PostgreSQL, Redis e volumes permanecem com suas configurações próprias.

A instalação D2 anteriormente confirmada pelo operador tem baseline 0046. Para instalar D4, aplicar também 0047_central_dispatch e 0048_central_cutover. O deploy normal do Compose não substitui o migrator no profile maintenance. No Dokploy Advanced, o comando é prefixado com docker pela plataforma. Executar o migrator com o digest API da entrega, conferir os logs e restaurar o Run Command padrão antes do deploy dos serviços:

```text
compose -p jrc-broker-broker-ophydn -f ./infra/dokploy/compose.yaml --profile maintenance run --rm --no-deps migrate
```

Confirmar backup restaurável dos dados e preservar as filas/recibos incertos. Não apagar volumes nem repetir efeitos UNKNOWN. O rollback de imagem exige conferir compatibilidade do banco e dos recibos; a reversão de uma caixa é uma operação separada, descrita abaixo.

Após a instalação: /ready HTTP 200; AUTOMATION_RUNTIME_V2_ENABLED=true; schema baseline 0048_central_cutover com estruturaCompatível=true; heartbeats atuais de todos os workers. Esses resultados confirmam disponibilidade e estrutura, sem substituir a jornada real.

Consulta no Open Terminal do container api (/bin/sh), copiando somente o bloco inteiro:

```sh
node --input-type=module <<'NODE'
import pg from '/app/node_modules/pg/lib/index.js';
import { probeRequiredRuntimeSchema, RUNTIME_SCHEMA_BASELINE } from '/app/apps/api/dist/db/runtime-schema.js';
const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  options: '-c default_transaction_read_only=on'
});
try {
  await db.connect();
  console.log(RUNTIME_SCHEMA_BASELINE);
  console.log(await probeRequiredRuntimeSchema(sql => db.query(sql)));
} catch (error) {
  console.log('FALHA_NA_CONSULTA', error.code ?? 'SEM_CODIGO');
} finally { await db.end(); }
NODE
```

## Jornada de configuração e aceitação

1. Entrar como OWNER/ADMIN da empresa correta e configurar a conta/destino aprovado da central dessa empresa. Informar credenciais no sistema, nunca em evidência compartilhada.
2. Criar uma caixa de origem central e selecionar uma caixa real da conta. Conferir a observação do bot existente e autorizar sua substituição quando necessária. O webhook original da caixa é preservado.
3. Acompanhar DETACH → CREATE → ATTACH → VERIFY. Recarregar a tela deve recuperar a operação salva. Resultado desconhecido exige consultar o estado; não significa que a alteração falhou ou que pode ser repetida.
4. Receber uma nova mensagem de um contato de teste na caixa. O callback autenticado dessa caixa confirma o ingresso e libera o vínculo da automação. Histórico anterior não inicia bot.
5. Criar/publicar o menu no motor único do Broker e vincular a versão à caixa. Enviar uma nova mensagem de teste, escolher uma opção, fornecer uma resposta capturada e conferir uma única resposta por turno.
6. Transferir para o time/agente válido da conta, responder publicamente como humano e comprovar que o bot fica pausado. Retomar explicitamente pelo comando coordenado e confirmar o menu/ciclo escolhido.
7. Conferir os mesmos IDs de correlação, mensagem e recibo no Broker e na central; recebimento no WhatsApp deve ser comprovado no aparelho de teste. ACK ou SENT da central não provam leitura.
8. Repetir com duas empresas JRC Conversas e um Chatwoot externo, incluindo IDs numéricos remotos iguais em contas diferentes, duplicação de callbacks, reconexão e recuperação após reinício. Registrar versão real da central, capacidade observada, digests instalados, migrações, configurações não secretas e resultados.

A caixa Welton está autorizada para teste. Os outros tenants e a central externa serão preparados na fase final acordada. Essa homologação externa permanece NOT_RUN até existir evidência real; transporte HTTP sintético e CI não a substituem.

## Recuperação e reversão

Antes do primeiro efeito remoto, uma preparação pode ser cancelada. O cancelamento não afirma restauração de um executor legado que foi pausado localmente. Depois de efeitos remotos, usar a reversão da própria operação; ela observa bot/webhook/callback, exige revisão atual e preserva o histórico.

Reconfigurar credenciais pode exigir revalidar a reversão. A recuperação aceita somente a mesma origem e conta e não transforma um resultado UNKNOWN em autorização para novo POST. Executor legado com revisões antigas continua pausado até configuração atual. Bots criados não são excluídos automaticamente; conversas antigas não são reassumidas. Exclusão definitiva de canal CENTRAL não faz parte desta entrega.

## Escopo restante do programa

Mensagens do aparelho, grupos, chamadas WhatsApp, módulos embutidos QR/Flow, Meta real, S3 e capacidade de 500 empresas/10 mil conexões pertencem às fases seguintes. O D4 não declara essas integrações homologadas nem dimensionamento comprovado.
