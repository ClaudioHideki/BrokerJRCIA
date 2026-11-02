# B03 — recibo de custódia e conservação de mídia

Data: 29/10/2026. Base da fase: `9e62ceaf3177979a68bc4985a93e25474de48487`; branch local `codex/broker-audit-fixes-20261029`. Referências: tarefa 2 de `PLANO-IMPLEMENTACAO.md` e relatórios históricos 06, 08 e 04, que não foram reescritos.

## Estado e fronteira da entrega

**Incremento funcional preparado e conectado ao Broker, com testes unitários/HTTP locais. PostgreSQL real, storage do cliente e CCLX real NÃO EXECUTADOS.** A migration é somente preparação local; sua presença no journal/readiness e schema central é consolidada pelo responsável da fase. Nenhuma migration foi aplicada a serviço real nesta tarefa.

O cliente pode atestar que persistiu definitivamente os bytes. O Broker valida autoridade atual, referência real, destino registrado e integridade declarada, e persiste o recibo na mesma transação. Essa atestação autenticada **não prova fisicamente** gravação/fsync, disponibilidade, backup ou restauração no storage do cliente. O Broker não acessa esse storage.

A única política deste incremento é **KEEP**. A avaliação retorna `eligibleForDeletion: false` e `physicalStorageVerified: false`, inclusive após recibo válido e quando várias mensagens referenciam a mesma mídia. Não há prazo presumido, job de GC, remoção de conteúdo, chamada DELETE ao object store ou mudança do estado da mídia. ACK HTTP 2xx de webhook/download/upload permanece separado do recibo; nenhum desses ACKs promove mídia a READY.

## Contrato HTTP aditivo, schemaVersion 1

Todas as rotas exigem API key genérica com novo scope **`media:archive`**, e usam exclusivamente o tenant do principal autenticado. JWT, scope antigo de upload/envio/leitura ou credencial Chatwoot de controle não concedem essa autoridade. Chaves antigas não são atualizadas. A emissão pede o scope explicitamente; uma chave delegadora precisa ter `api_keys:manage` e `media:archive` atuais na transação da emissão.

| Método/rota | Semântica |
| --- | --- |
| `POST /v1/media-custody/receipts` | Registra atestação com `Idempotency-Key` UUID; 201 com recibo canônico e `replayed`. Repetir após timeout usa a mesma chave e o mesmo corpo. |
| `GET /v1/media-custody/receipts/:id` | Consulta recibo por identidade Broker no tenant autenticado. |
| `GET /v1/media-custody/receipts/:id/retention` | Consulta a avaliação conservadora KEEP; não agenda nem executa limpeza. |

Corpo estrito do POST: `schemaVersion: 1`, `channelId`, `messageId`, `mediaId`, `endpointId`, `destinationVersion: 1`, `clientReceiptId` UUID, `byteSize` inteiro entre 1 e 16777216, `sha256` hexadecimal minúsculo de 64 caracteres, `storageObjectId` opaco e limitado a 255 caracteres, `attestation: "DURABLY_STORED"`. Não há campo `organizationId`; campos extras são rejeitados. O objeto opaco não aceita URL, querystring ou credenciais de storage e nunca é dereferenciado pelo Broker.

O destino usa o vínculo a um endpoint previamente registrado em `partner_webhook_endpoints`, do mesmo tenant e ACTIVE. Sua URL não é enviada no recibo; a versão 1 representa esse vínculo imutável pelas APIs atuais. Mudança de URL exige novo endpoint. O serviço existente de registro de webhook continua responsável por sua configuração/segredo independente.

A resposta guarda `id`, tenant autenticado, campos do corpo e `acceptedAt` do servidor. Não expõe chave autorizadora, hash interno de idempotência, segredo do endpoint, URL assinada, bytes ou configuração privada de storage. Todas as respostas usam `Cache-Control: no-store`. As schemas declaradas no router entram no gerador OpenAPI existente; a geração do artefato compartilhado é parte da consolidação da fase.

## Identidade, integridade e concorrência

- Idempotência no tenant, independente da chave física, permite rotação autorizada sem criar outra cópia lógica. A mesma chave e corpo retornam o mesmo recibo/instante. Divergência de corpo ou reutilização de `clientReceiptId`/associação com outra intenção retorna 409. Alterar o header mantendo a mesma identidade também conflita; a recuperação usa o header original ou GET do recibo conhecido.
- A associação real vem de `messaging_messages.media_id`, com joins por organização/canal. Não basta fornecer IDs existentes isoladamente. A mídia deve estar READY; tamanho e SHA256 devem ser exatamente os já confirmados no Broker. Mídia PENDING/DOWNLOADING/STORING/UNKNOWN/FAILED é rejeitada.
- O serviço toma locks na ordem organização → API key → advisory de custódia do tenant → instância/canal → endpoint → mensagem/mídia. Revalida a API key com relógio do banco após locks e antes/depois da gravação. A expiração durante espera não herda autoridade da autenticação inicial. Revogação e remoção de scope não usam snapshot do JWT ou da emissão.
- O INSERT possui a mesma fronteira SQL: organização ativa, key atual com scope, rejeição de binding de controle, endpoint ACTIVE, mensagem/mídia exatas e READY/integridade, com rechecagem de expiração depois dos locks. Triggers existentes de lifecycle bloqueiam admissão durante exclusão de organização/canal.
- A FK composta inclui `organization_id, channel_id, message_id, media_id`. Ela também impede trocar posteriormente o anexo da mensagem já referenciada pelo recibo. Várias mensagens da mesma mídia têm recibos específicos; um recibo não se transfere para as outras referências. Não existe elegibilidade por contagem de recibos neste incremento.
- Uma key vinculada ao controle Chatwoot é recusada pelo serviço e pelo SQL, mesmo se receber incorretamente o scope novo. O fence de controle usa seu enum próprio e não aceita `media:archive` como permissão de controle.

## Persistência, RLS e lifecycle

`0075_media_custody.sql` cria `media_custody_receipts` com PK/UNIQUEs por tenant, FKs compostas, CHECKs de versão/integração, política KEEP, RLS ENABLE/FORCE e owner `jrc_migrator`. `jrc_app` recebe somente SELECT/INSERT; UPDATE e DELETE não são concedidos. Trigger adicional rejeita UPDATE da evidência.

A chave autorizadora fica como identidade histórica sem FK a uma credencial que pode ser removida; sua ausência passa a negar novas operações. Referências de mensagem, mídia e destino usam RESTRICT. A tabela entra no `lifecycle_purge_catalogue`; a função de purge de canal recebe um patch verificado que remove esse metadado antes dos pais, exclusivamente dentro da exclusão explícita já protegida pelo lifecycle. Esse patch preserva a exclusão administrativa existente e não introduz retenção por recibo nem apaga bytes por ACK. O purge de organização segue a ordenação de FKs do catálogo.

Adicionar a UNIQUE composta sobre mensagens exige avaliar lock/duração e volume em homologação antes de qualquer release. A migração não cria dependência npm, worker ou configuração de armazenamento nova.

## TDD e verificação local

RED foi observado antes de GREEN:

1. `npx vitest run apps/api/tests/unit/media-custody-scope.test.ts --maxWorkers=1`: falhou porque o issuer ainda rejeitava `media:archive`; depois passou sem adicionar scopes a chaves antigas.
2. `npx vitest run apps/api/tests/unit/media-custody.test.ts apps/api/tests/http/media-custody.test.ts --maxWorkers=1`: HTTP falhou 404 versus 201/403 pela ausência das rotas; a suíte do serviço inicialmente não importava o módulo ausente. Após implementação, os cenários passaram. O erro inicial de import não é prova isolada dos branches internos; as asserções HTTP comprovaram a ausência funcional.
3. Testes adicionais de controle observaram RED real: chave híbrida retornava 201 em vez de 403; fence de controle aceitava `media:archive`; chave control-bound conseguia gravar no harness. Cada fronteira foi corrigida e repetida em GREEN.
4. URL no campo de objeto opaco observou RED 201 versus 400 antes da restrição do contrato/CHECK.

Comando final direcionado:

```text
npx vitest run apps/api/tests/unit/media-custody.test.ts apps/api/tests/http/media-custody.test.ts apps/api/tests/unit/media-custody-scope.test.ts apps/api/tests/unit/api-key-service.test.ts apps/api/tests/http/api-keys.test.ts apps/api/tests/unit/partner-media-contracts.test.ts apps/api/tests/unit/chatwoot-control-auth.test.ts --maxWorkers=1
```

Resultado: **7 arquivos / 70 testes passaram**. Cobertura local inclui contratos, wiring via `buildApp`, autenticação/scope/controle, tenant injection, integridade, estados incompletos, revogação/expiração simulada após lock, replay/conflito e conservação de bytes. Harness de transação não prova concorrência/RLS/triggers reais. `npm run typecheck` passou. `git diff --check` dos arquivos do item passou. Suíte geral, build e revisão independente são consolidados pelo responsável da fase; não se infere seu resultado dos testes direcionados.

Saídas sintéticas locais em `tmp/b03-*.txt` registram RED/GREEN e typecheck; não são evidência histórica de produção.

## Integração PostgreSQL preparada, NÃO EXECUTADA

`apps/api/tests/integration/media-custody.test.ts` prepara replay concorrente, ACK perdido/rotação, RLS entre tenants, troca de referência bloqueada pela FK, várias mensagens compartilhando mídia, integridade/credencial/lifecycle via INSERT SQL direto, app sem UPDATE/DELETE e expiração real enquanto a transação espera lock de mensagem. Usa o fixture existente de bancos descartáveis e aplica 0075 localmente somente se ainda não estiver no journal.

O guard exige, antes de abrir conexão: `TEST_DATABASE_ADMIN_URL` explicitamente fornecido, host literal `127.0.0.1` ou `[::1]`, usuário administrativo e database com prefixo `lab_`, além da declaração operacional `TEST_MEDIA_CUSTODY_EXCLUSIVE_CLUSTER=1`. Não lê `DATABASE_URL`/DBENV nem usa fallback. O cluster inteiro deve ser exclusivo/descartável porque o fixture altera papéis globais. A flag é declaração do operador e não comprovação automática dessa exclusividade.

Somente após disponibilizar esse ambiente, executar:

```text
npx vitest run --config vitest.integration.config.ts apps/api/tests/integration/media-custody.test.ts --maxWorkers=1
```

Não foi executado contra cluster compartilhado ou remoto. A indisponibilidade de PostgreSQL/MinIO exclusivo deixa RLS, triggers, FKs e interleavings reais sem prova nesta entrega.

## Rollback e pendências bilaterais

Rollback operacional conservador: voltar o binário/roteamento anterior e suspender emissão/uso do scope novo. Preservar a tabela de recibos, constraints, catálogo e funções; versões anteriores não escrevem recibos, e a evidência já gravada não deve ser perdida para facilitar rollback. Não remover a UNIQUE/FKs nem executar DROP/DELETE como rotina de rollback. Não há GC para desligar nem restauração de bytes apagados por esta feature.

Permanecem pendentes: integração do cliente com seu storage definitivo, gravação/backup/restore comprovados, versão/fork CCLX, contrato de destino e rotação de identidades, janelas técnicas e tratamento de todas as referências/backups, retenção legal/operacional acordada e um eventual GC auditado com ensaios próprios. Nenhuma política destrutiva ou promessa de custódia física foi ativada. Sem commit, push, PR, deploy, carga ou dados reais nesta tarefa.
