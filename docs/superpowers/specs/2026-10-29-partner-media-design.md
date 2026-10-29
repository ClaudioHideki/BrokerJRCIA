# Mídia pública de parceiro — desenho da próxima entrega

**Estado:** desenho da próxima entrega com decisões rotineiras de interface registradas pelo executor principal; não implementado, não configurado, não homologado. Não altera o contrato publicado atual.

**Fonte:** Broker `16a2a371e44de65a901cf1a9405bf4939ee1f213`, branch `codex/broker-experience-20261029`. Em 29/10/2026, o último arquivo de migration conferido é `0073_chatwoot_initial_identity.sql`; o número proposto seguinte é `0074`, sujeito a nova conferência antes da implementação.

**Programa:** [pedido integral](2026-10-29-broker-experience-execution.md), seções 5, 10, 13 e 15; [plano principal](../plans/2026-10-29-broker-experience.md), Entrega 3. A primeira entrega de navegação continua sob sua própria verificação. Este desenho prepara uma fatia de API, não encerra lifecycle, mídia de todos os providers nem integração CCLX.

## Objetivo e limites

Permitir ao backend autorizado do parceiro carregar um arquivo privado, reconciliar seu armazenamento e enviar uma referência desse arquivo pela outbox canônica, acompanhando recibos existentes. Preservar isolamento, quota, idempotência, revogação em voo e recuperação de resultados incertos.

Primeiro recorte: mensagens individuais QR com provider `BAILEYS` e `BROKER_TRANSPORT`, igual à fronteira atual de `partner-text`. Manter APIs JRC, stack, store privado, workers e adapters existentes. Não adicionar envio Meta, grupos, stickers, PTT como capacidade nova, chamadas ou publicação de Flow. Áudio anexado continua distinto de chamada e de homologação de codec/reprodução no host.

Nenhuma credencial nova, bucket remoto, upload externo, envio real, migration produtiva, deploy ou troca de engine está autorizada por este documento. Testes usam bytes e destinos sintéticos e serviços de laboratório. Documentar o contrato antes de habilitar o consumidor.

## Evidência existente que deve ser reutilizada

| Fonte atual | Comportamento relevante |
| --- | --- |
| `apps/api/src/http/routes/automations.ts` | Upload binário JWT `OWNER/ADMIN` em `/v1/automations/:id/channels/:channelId/media`, com contexto de raiz de automação; catálogo/revogação próprios |
| `apps/api/src/http/routes/flow-delegation.ts` | Upload `/v1/delegated-flows/:id/channels/:channelId/media` com sessão/grants de Flow; não aceita a chave pública genérica |
| `apps/api/src/modules/automations/conversation-resources.ts` | Verifica raiz, canal, módulo e autoridade durante armazenamento; associa asset à automação |
| `apps/api/src/modules/messaging/media-store.ts` | `writeUpload`, validação de bytes, cifra, quota compartilhada, idempotência e backend privado |
| `apps/api/src/modules/messaging/durable-private-media.ts` | Reserva persistente, integridade e estados de operação `PREPARED/DISPATCHED/CONFIRMED/UNKNOWN/REJECTED` |
| `apps/api/src/modules/messaging/partner-text.ts` | Identidade da chave, canal QR, takeover humano, idempotência e admissão na outbox |
| `apps/api/src/modules/messaging/repository.ts` | FK composta mídia/tenant/canal, claim, revalidação e despacho canônico |
| `apps/api/src/modules/integrations/runtime.ts` | Prepara bytes privados e retorna o efeito físico de mídia pelo adapter |
| `apps/api/src/http/routes/messaging.ts` | GET privado reexecuta autenticação/permissão imediatamente antes de liberar bytes |
| `packages/providers/src/media-upload.ts` | MIME permitido e assinatura real, incluindo contêiner/tracks de MP4 e Ogg |

Não existe POST JWT genérico de envio arbitrário de mídia que possa apenas ser publicado. A presença de upload de automação e adapter `sendMedia` não concede acesso ao parceiro. O catálogo atual em `scripts/docs/public-api.mjs` conserva texto QR e download privado até a implementação e geração deliberada do contrato novo.

## Abordagens consideradas e decisões

1. **Recomendação: upload separado, consulta de estado e envio por referência.** Reutiliza bytes duráveis e outbox; possibilita reconciliar PUT incerto sem repetir upload e enviar o mesmo arquivo em intenções distintas. Acrescenta três operações públicas.
2. Upload e envio num único POST: menos operações, mas mistura resultado de armazenamento com efeito físico e dificulta idempotência e recuperação independente. Não recomendado.
3. Delegar o upload/editor de automação existente ao parceiro: exigiria autoridade de Flow e uma raiz sem relação com o caso de uso. Não recomendado; não usar API key como raiz fictícia.

O programa autoriza a capacidade e delega as decisões rotineiras. O executor principal escolhe a abordagem 1 por separar a persistência do arquivo do efeito físico de envio; as escolhas abaixo são técnicas, não uma nova autorização de produção:

- **D1 — adotada:** três rotas abaixo e HTTP 201 depois de criar o recurso durável, incluindo `STORING`. O corpo contém o estado e a URL de consulta de metadados; 201 não afirma bytes prontos nem envio. Replay não cria outra operação.
- **D2 — adotada:** referência compartilhável somente no mesmo tenant/canal por chave atual com scopes suficientes. A chave emissora delimita idempotência/auditoria; a rotação não inutiliza arquivos do tenant. Identidade/chave original nunca vira autorização implícita após revogação.
- **D3 — adotada:** corpo reutiliza a união de destinatário da API de texto: `conversationId` ou `phoneNumber` E164, nunca ambos. `kind`, filename e MIME vêm do registro armazenado.

## Interface proposta

| Método e rota | Autoridade | Corpo/resultado |
| --- | --- | --- |
| POST `/v1/messaging/channels/:id/media` | API key atual com novo `media:upload` | Binário e headers; retorna metadados estáveis do recurso e estado `READY`, `STORING` ou `FAILED` |
| GET `/v1/messaging/channels/:id/media/:mediaId` | API key atual com `media:upload` | Consulta somente metadados sanitizados de upload de parceiro no canal; inclui estado, integridade e erro canônico quando houver |
| POST `/v1/messaging/channels/:id/partner-media` | API key atual com `messaging:send` **e** novo `media:send` | `{conversationId,mediaId,caption?}` ou `{phoneNumber,mediaId,caption?}`; retorna mensagem existente com `conversationId`, HTTP 202 |
| GET `/v1/messaging/media/:id` existente | Mantém `messaging:read` ou membership JWT atual | Proxy de bytes; mantém revalidação antes da resposta |

Metadados propostos: `{id,channelId,status,kind,fileName,mimeType,byteSize,sha256,errorCode?}`; não expor descritor privado, identidade da chave, ciphertext, object key, bucket, URL assinada, segredo nem payload de provider. `byteSize`/integridade devem representar os bytes validados, inclusive quando persistidos mas ainda não confirmados no objeto remoto.

Scopes novos entram explicitamente no schema do issuer e em `requestedPartnerScopes`, inclusive revalidação transacional da delegação. Chaves antigas não recebem scopes novos por migration, valor default, wildcard ou frontend. `media:upload` não implica envio; `media:send` sozinho não implica texto nem upload. O máximo de scopes genéricos deve comportar os oito valores, preservando os scopes de controle Chatwoot no issuer próprio.

## Validação e isolamento

- Autenticar em `onRequest` antes de ler corpo grande; revalidar antes do serviço e após I/O. Aceitar exatamente uma credencial; chave API não se mistura com JWT, sessão Flow ou segredo de webhook.
- Tenant sempre derivado da chave. Params UUID, query vazia e body estrito; recusar override de organização, URL remota, caminho de objeto, root de automação ou configuração S3.
- Em cada etapa: organização ativa, chave não revogada/expirada e scopes atuais, canal próprio aberto, não arquivado/em exclusão, `BAILEYS`, `BROKER_TRANSPORT`. Envio confirma conversa e mídia do mesmo canal; não confiar na FK apenas para produzir diagnóstico.
- Parser `application/octet-stream`, corpo de 1 a 16 MiB e limites por tipo. Reutilizar headers `X-JRC-Media-Mime`, `X-JRC-Media-Kind`, `X-JRC-Media-Name` codificado por `encodeURIComponent` e `Idempotency-Key` UUID.
- Reutilizar `SUPPORTED_UPLOAD_MIME_TYPES`, `validateUploadMedia`, `safeMediaName` e `MAX_MEDIA_BYTES`; imagem até 5 MiB; caption até 1.024 caracteres. Nome/MIME/kind do envio são do arquivo validado, não do cliente JSON.
- Reutilizar quota combinada de inline e reservas privadas sob serialização existente. Não contar reserva incerta duas vezes nem liberar reserva só porque ACK de PUT não chegou.

Estas rotas mantêm autoridade de serviço por tenant/canal; não solucionam a lacuna separada de operador JWT por inbox atribuída. O BFF do host revalida sua própria sessão/membership antes de consultar bytes.

## Persistência aditiva e fences

Não editar migrations históricas `0058` ou `0071`. Criar `apps/api/drizzle/migrations/0074_partner_media.sql` após reconferir a numeração.

1. Ampliar por substituição aditiva o CHECK `messaging_media_upload_identity` de `0058`: preservar a variante legada `{rootAutomationId,idempotencyKey,sha256}` com `source_key=root:key`; acrescentar variante explicitamente marcada como parceiro, por exemplo `{uploadKind:'PARTNER',apiKeyId,idempotencyKey,sha256,requestHash}`, com source key `partner:apiKeyId:key`. Validar campos e falhar fechado em NULL/forma incompleta. Manter `source='UPLOAD'`, excluído do download por provider nos workers.
2. O hash canônico do upload inclui hash dos bytes, MIME, kind e nome sanitizado, no contexto tenant/canal/chave. Registro persistente conserva identidade mesmo após apagar a chave; não adicionar cascade que apague evidência ou converta autoridade ausente em envio livre.
3. Substituir a função `partner_require_message_authority()` de `0071` mantendo owner `jrc_migrator`, `SECURITY DEFINER`, search path fixo, ACLs e trigger em toda transição para `SENDING`, inclusive `SENDING→SENDING`. Texto continua exigindo `messaging:send`; `MEDIA` com `authorizing_api_key_id` exige também `media:send`. Ausência/revogação/expiração/scope perdido impede envio, mesmo com worker de imagem anterior.
4. `repository.validateClaim` repete a condição por conteúdo; admissão, preparação de bytes e último validate antes do POST físico usam autoridade atual. Callbacks de leitura não devem limitar-se a `assertQueuedMediaAuthority` de automação: o caminho de parceiro precisa de verificação própria, preservando o contrato anterior da automação.
5. Preservar FK composta `messaging_messages_media_fk` de `0016`, tenant RLS, lifecycle, private-store integridade e políticas de mensagem. Atualizar readiness/inventário de schema e seus testes conforme a migration efetiva; não marcar compatible somente por existir uma tabela.

Sem tabela paralela ou novo storage no primeiro recorte. Revogação de arquivo individual, retenção específica para uploads não associados e limpeza de resíduos de admissão recusada precisam ser explicitadas antes de prometer essas operações; o primeiro contrato não oferece um botão de revogar asset que apenas muda UI.

## Idempotência e recuperação

Upload: mesma chave/contexto + mesmos bytes/metadados retorna o mesmo `id`; conteúdo ou metadados diferentes retornam 409. `STORING`/operação `UNKNOWN` é consultada/reconciliada pelo store existente. Nem replay HTTP nem GET pode emitir um segundo PUT incerto. GET não envia mensagem nem cria recursos.

Envio: exigir arquivo `READY`; takeover humano e inserção da mensagem/outbox ocorrem na mesma transação. Hash inclui destinatário, ref, caption e identidade da chave; namespace deve impedir colisão ambígua com `partner-text`. Replay exato conserva mensagem e estado; conflito 409. HTTP 202 é admissão. `SENT`, `DELIVERED`, `READ` e `UNKNOWN` mantêm seus significados atuais. Timeout após possível aceite não permite nova chave para forçar reenvio.

Revogar antes do efeito impede despacho; requisição física já enviada não é desfeita. Revogação durante GET impede liberar bytes/headers. Não revogar implicitamente webhooks ao revogar API key.

## Seis aceites automatizados essenciais

1. Scopes: chave antiga não faz upload/envio de mídia; upload não envia; par de scopes de envio funciona; delegação não concede scope ausente na chave emissora atual.
2. Tenant/canal: recusar mídia ou conversa estrangeira, outro canal da mesma empresa, canal arquivado/em exclusão, Meta ou `CENTRAL_TRANSPORT`; sucesso no canal QR autorizado.
3. Bytes: arquivo sintético válido persiste; vazio/excesso, assinatura falsa, MIME/kind divergente e nome inválido falham antes de qualquer storage/provider indevido; nome válido é sanitizado conforme contrato atual.
4. Quota e PUT: concorrentes respeitam uma quota; replay exato reutiliza ref; corpo alterado conflita; ACK perdido permanece incerto e reinício/GET não repete PUT.
5. Outbox e recibo: upload→READY→admissão→um despacho→recibo; requests concorrentes e ACK de envio perdido não criam segunda mensagem nem reenvio cego.
6. Revogação: durante leitura/armazenamento e entre admissão/preparação/despacho; perda apenas de `media:send` bloqueia worker atual e tentativa SQL `SENDING→SENDING`, preservando texto e automação anteriores.

## Validação e dependências atuais

Executar HTTP/unitários com serviços sintéticos; integração PostgreSQL/roles/RLS e storage real requerem laboratório explícito. Em 29/10, o executor principal informa `docker desktop start` bem-sucedido, porém `docker info` para `desktop-linux` ainda falha por named pipe ausente. PostgreSQL de integração, storage e E2E dependentes desse ambiente permanecem **não executados/bloqueados**, não aprovados.

A obtenção local de OpenSSL e o ajuste process-local de Git da entrega anterior resolvem pré-requisitos de suítes específicas; não provam este módulo, ainda sem código. Providers reais, CCLX, mídia reproduzida no host, restart de consumidores e restore conjunto continuam aceites externos separados.

## Registro de decisão do executor principal

- D1: HTTP 201 para recurso durável, estado explícito e GET de metadados; não afirma prontidão/entrega.
- D2: compartilhamento restrito ao mesmo tenant/canal, com scopes e chave atuais em cada fronteira.
- Implementação: código local em revisão, incluindo migration aditiva 0074 e
  documentação sincronizada. Ver checkpoint do plano para gates ainda pendentes.
- Homologação: não executada.
