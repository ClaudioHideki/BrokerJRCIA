# Mídia pública de parceiro — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** entregar upload privado, consulta de estado e envio por referência para parceiros QR autorizados, sem ampliar as chaves existentes.

**Architecture:** reutilizar `MediaStore`, private-store durável, outbox, dispatcher e recibos JRC. Adicionar scopes explícitos e migration aditiva que preserva uploads de automação e reforça autoridade de mídia no banco. Rotas propostas de parceiro ficam separadas de Flow e do POST de texto.

**Tech Stack:** Node 24.19.0, TypeScript, Fastify, Zod, PostgreSQL/roles/RLS, storage atual PostgreSQL/S3, Vitest e portal existente. Não trocar stack, fila ou engine.

**Spec:** [2026-10-29-partner-media-design.md](../specs/2026-10-29-partner-media-design.md).

**Estado:** próxima entrega planejada; nenhuma caixa marcada representa implementação ou homologação. D1/D2 foram resolvidas pelo executor principal no spec, dentro das decisões rotineiras delegadas pelo usuário. A capacidade está no programa autorizado, sem microaprovação humana.

## Global Constraints

- Primeiro recorte: mensagens individuais QR com provider `BAILEYS` e `BROKER_TRANSPORT`, igual à fronteira atual de `partner-text`.
- Chaves antigas não recebem scopes novos por migration, valor default, wildcard ou frontend.
- Não editar migrations históricas `0058` ou `0071`.
- Parser `application/octet-stream`, corpo de 1 a 16 MiB e limites por tipo.
- Reutilizar `SUPPORTED_UPLOAD_MIME_TYPES`, `validateUploadMedia`, `safeMediaName` e `MAX_MEDIA_BYTES`; imagem até 5 MiB; caption até 1.024 caracteres.
- HTTP 202 é admissão. `SENT`, `DELIVERED`, `READ` e `UNKNOWN` mantêm seus significados atuais.
- Nenhuma credencial nova, bucket remoto, upload externo, envio real, migration produtiva, deploy ou troca de engine está autorizada por este documento.
- PostgreSQL/storage/E2E dependentes do Docker local estão bloqueados enquanto `desktop-linux` não responder. Não converter dependência ausente em skip aprovado.

## Review Focus

- Upload autorizado no início mas chave revogada antes da persistência final: autoridade e resposta precisam ser reavaliadas.
- Apenas `media:send` removido entre admissão e despacho: texto continua válido; MEDIA deve ser bloqueado inclusive por worker anterior.
- Mesmo SHA com MIME/nome/kind alterados: replay não pode aceitar metadata divergente só por bytes iguais.
- PUT enviado com ACK perdido e request repetido: não reservar duas vezes nem reenviar PUT incerto.
- Mídia válida do tenant em outro canal e UUID colidente em outra organização: ref não atravessa o vínculo nem aparece em metadata/bytes.

Os cinco focos são fixados nos testes das tarefas 1–3 abaixo, além da regressão de automação/upload legado.

## Mapa de arquivos e interfaces propostas

| Responsabilidade | Arquivos |
| --- | --- |
| Scopes, requests, DTOs | `packages/contracts/src/api-keys/schemas.ts`, `packages/contracts/src/messaging/schemas.ts` e export existente |
| Delegação de scope | `apps/api/src/modules/api-keys/service.ts`, `apps/api/src/http/routes/api-keys.ts` |
| Upload/ref/autoridade de parceiro | Criar `apps/api/src/modules/messaging/partner-media.ts` e `partner-authority.ts`; integrar em `modules/messaging/service.ts` e `http/routes/messaging.ts` |
| Store compartilhado | `apps/api/src/modules/messaging/media-store.ts`; preservar `durable-private-media.ts` sem novo backend |
| Fences | `apps/api/src/modules/messaging/repository.ts`, `apps/api/src/modules/integrations/runtime.ts`, criar `apps/api/drizzle/migrations/0074_partner_media.sql` após confirmar sequência |
| Wiring/readiness | `apps/api/src/app.ts`, `apps/api/src/db/partner-api-runtime-schema.ts` e verificações atuais de schema impactadas |
| Contrato público | `apps/api/src/http/openapi.ts`, `scripts/docs/public-api.mjs`, `operation-guide.mjs`, geração atual do portal/Postman e documentação |

Interfaces propostas para fixar no RED de contrato:

- `PartnerMediaMetadata`: `{id,channelId,status:'READY'|'STORING'|'FAILED',kind:'image'|'audio'|'video'|'document',fileName,mimeType,byteSize,sha256,errorCode?}`; todos os campos de storage são públicos sanitizados, sem descriptor/key/bucket.
- `PartnerMediaRequest`: união estrita `{conversationId,mediaId,caption?}` ou `{phoneNumber,mediaId,caption?}`.
- `createPartnerMediaService({repository,media,transact})` produz `upload(organizationId,channelId,input:BinaryMedia & {idempotencyKey:string},apiKeyId):Promise<PartnerMediaMetadata>`, `get(organizationId,channelId,mediaId,apiKeyId):Promise<PartnerMediaMetadata>` e `send(organizationId,channelId,input:PartnerMediaRequest,idempotencyKey,apiKeyId):Promise<MessageView & {conversationId:string}>`.
- `MediaStore.writeUpload` aceita a união compatível de identidade legada e identidade de parceiro; a variante de parceiro não contém `rootAutomationId` fictício.
- Em `partner-authority.ts`, `requireCurrentPartnerKey(tx:TenantTransaction,organizationId:string,apiKeyId:string,requiredScopes:readonly string[]):Promise<void>` verifica chave atual/tenant/scopes na transação; `assertPartnerMessageAuthority(tx:TenantTransaction,organizationId:string,messageId:string):Promise<void>` resolve identidade e conteúdo da mensagem e exige os scopes correspondentes. Mensagem inexistente falha; mensagem existente sem identidade de parceiro conserva seu caminho anterior. Claim e callback de leitura reutilizam o helper; banco permanece fence independente.

## Tarefa 0 — fixar decisões e pré-requisitos

**Arquivos:** spec acima; nenhum arquivo de produto nesta etapa.

- [x] Registrar D1/D2: três rotas, HTTP 201 para recurso durável com estado explícito/GET de consulta; ref compartilhável somente no mesmo tenant/canal, com chave e scopes atuais em cada fronteira. Nenhum contrato novo foi publicado.
- [ ] Conferir branch/HEAD, alterações locais e último migration; reservar `0074` somente se ainda for o próximo. Preservar a entrega UI em verificação e arquivos de outros agentes.
- [ ] Confirmar `docker info` e laboratório descartável antes de qualquer teste que cria banco. Usar `TEST_DATABASE_ADMIN_URL` explícita; não executar `db:migrate:test` por nome nem cair em banco de produção.

## Tarefa 1 — contrato de scopes e upload privado

**Arquivos:** schemas de contrato; `modules/api-keys/service.ts`; `modules/messaging/partner-media.ts`, `partner-authority.ts`, `media-store.ts`, `service.ts`; `http/routes/messaging.ts`; migration nova.

**Testes:** criar `apps/api/tests/http/partner-media.test.ts` e `apps/api/tests/unit/partner-media.test.ts`; ampliar `apps/api/tests/unit/automation-conversation-upload-store.test.ts`, `apps/api/tests/integration/partner-messaging.test.ts`; criar `apps/api/tests/integration/partner-media.test.ts`.

**Interfaces:** consome `MediaStore`, transação de tenant e `BinaryMedia`; produz `upload/get` e DTO de ref para a Tarefa 2.

- [ ] RED HTTP: chave `messaging:send` não faz upload; `media:upload` permite arquivo válido sem enviar; ausência/dupla credencial e tenant override são recusados antes do store. RED transacional: emissor sem novo scope não o delega.
- [ ] RED de store: bytes falsos/vazios/>16 MiB, imagem >5 MiB, MIME/kind divergente e nome/header inválido recusados; hash igual com metadata alterada conflita. Registrar a falha anterior à implementação, com comando/saída.
- [ ] Ampliar schemas/issuer para `media:upload` e `media:send`, sem grants/defaults novos em chaves existentes. Validar max de oito scopes genéricos e preservar issuer próprio Chatwoot.
- [ ] Implementar variante de identidade `UPLOAD` de parceiro e CHECK aditivo compatível com `0058`: source key prefixado `partner:`, UUIDs, hash dos bytes e hash canônico completo; nenhum root de automação artificial.
- [ ] Implementar upload/get com tenant/canal/provider/transporte/estado operacional atuais, autenticação antes do corpo e revalidação após I/O. Usar parser privado/limitado e DTO sanitizado. GET não faz upload ou envio.
- [ ] RED→GREEN PostgreSQL: arquivo válido e replay mantêm ref; conteúdo alterado 409; outro tenant/canal e canal indisponível falham. Quota concorrente considera inline e reservas uma única vez.
- [ ] Rodar `node node_modules/vitest/vitest.mjs run apps/api/tests/http/partner-media.test.ts apps/api/tests/unit/partner-media.test.ts apps/api/tests/unit/automation-conversation-upload-store.test.ts --maxWorkers=1`; executar integração somente com laboratório confirmado. Registrar não executado/bloqueado quando faltar ambiente.
- [ ] Revisar diff/compatibilidade e `git diff --check`; somente preparar commit após os checks exigidos por `AGENTS.md`, inclusive `npm test`. Não criar um commit que finja encerrar o módulo sem Tarefa 2.

## Tarefa 2 — envio canônico e fences de revogação

**Arquivos:** `partner-media.ts`, `repository.ts`, `service.ts`, `integrations/runtime.ts`, `http/routes/messaging.ts`, migration nova; readiness conforme objeto/schema efetivo.

**Testes:** `apps/api/tests/http/partner-media.test.ts`, `apps/api/tests/integration/partner-media.test.ts`, `partner-authority-fence.test.ts`, testes existentes de dispatcher e mídia de automação.

**Interfaces:** consome `PartnerMediaMetadata` e `MediaStore.read`; produz `send` e `MessageView & {conversationId}` no mesmo pipeline de outbox/recibos de texto.

- [ ] RED: apenas `media:send`, apenas `messaging:send`, ref `STORING`/`FAILED`, outro canal/tenant, provider Meta ou `CENTRAL_TRANSPORT` não entram na outbox. Ref `READY` com os dois scopes entra uma vez.
- [ ] RED de corrida: remover somente `media:send` após admissão bloqueia claim/preparação/despacho. Testar transição SQL direta `SENDING→SENDING` com mensagem de parceiro sem autoridade e preservar texto autorizado.
- [ ] Implementar união de destinatário estrita, metadados derivados do store, caption limitada, takeover humano e outbox atômicos. Registrar identidade de chave; namespace/hash de idempotência distingue texto/mídia e não repete takeover ou criação no replay.
- [ ] Atualizar função de `0071` pela migration nova mantendo owner/ACL/search path/trigger; para MEDIA exigir scopes de texto+media. Atualizar `validateClaim` e callback de `prepareMedia` com a mesma regra sem perder a verificação de automação existente.
- [ ] GREEN de bytes: revogar chave durante leitura impede liberar bytes; revogar durante armazenamento impede devolver ref autorizada. Revalidar membership no GET JWT legado permanece coberto pelo teste existente.
- [ ] GREEN de outbox: requests simultâneos com mesma chave produzem uma mensagem; ACK perdido resulta `UNKNOWN` e replay consulta a mesma intenção, sem provider POST adicional. Recibos antecipados/fora de ordem preservam o estado mais recente.
- [ ] Rodar HTTP/unitários pertinentes; rodar `vitest.integration.config.ts` para `partner-media.test.ts`, `partner-authority-fence.test.ts`, `partner-messaging.test.ts`, `messaging-storage.test.ts` e regressão de mídia de automação apenas com PostgreSQL explícito. Registrar ambiente e limitações.
- [ ] Revisar migration/readiness e diff por alteração final, sem modificar `0058`/`0071` históricos nem remover o fence para acomodar um teste.

## Tarefa 3 — recuperação de storage e contrato público

**Arquivos:** testes privados de storage; `http/openapi.ts`, `scripts/docs/public-api.mjs`, `operation-guide.mjs`, geração normal; `docs/api/partner-onboarding.md`, `integration-modes.md`, baseline/progresso pertinentes.

**Testes:** `apps/api/tests/integration/private-media-facade.test.ts`, `durable-private-media.test.ts`, `apps/api/tests/storage/private-media-minio.test.ts`, `tests/partner-api-route-policies.test.mjs`, `public-api-documentation.test.mjs` e suites Postman existentes.

**Interfaces:** consome rotas/scopes implementados; produz OpenAPI/portal/Postman sincronizados, com escrita deliberada e exemplos sintéticos.

- [ ] RED de recuperação: PUT confirmado remotamente mas ACK perdido; reinício, GET de estado e replay não repetem PUT, não somam outra reserva e não fazem download de provider para `UPLOAD`.
- [ ] GREEN no harness privado e, quando disponível, MinIO real fixado. Não substituir o gate real por store mock nem alterar configuração para bucket público.
- [ ] Acrescentar as três operações reais ao perfil público e decorar corretamente API-key-only/binary/errors no gerador canônico. Manter GET de bytes já publicado e evitar exposição acidental de endpoints JWT/Flow.
- [ ] Gerar OpenAPI/portal/Postman pelos scripts atuais somente após código/contrato aprovados; escrita opt-in, sem credencial embutida, sem upload ou envio automático no playground/Runner. Novo scope não é selecionado automaticamente em chaves existentes.
- [ ] Rodar testes de perfil/inventário/OpenAPI/Postman e verificação de assets; comprovar que GET de metadata é read-only e replay de UNKNOWN não vira nova intenção. Registrar contagem derivada, sem usar contagem como aceite.
- [ ] Rodar `npm test`, build/typecheck e gates exigidos pela alteração; revisão independente do diff final e `git diff --check` antes do commit. Integração/storage/E2E bloqueados devem permanecer explícitos, com comando e entrada faltante.
- [ ] Atualizar progresso: código implementado, testes locais, ambiente configurado e provider/host homologado são estados distintos. Não declarar mídia/CCLX completos sem a evidência abaixo.

## Aceite externo preparado, ainda não executado

- [ ] Confirmar SHAs/imagens/schema e consumers efetivos; relógio, HTTPS e callback; duas organizações próprias e um proprietário de envio/projeção por inbox.
- [ ] Número/ativo e arquivos de laboratório autorizados: imagem/documento/vídeo/áudio nas duas direções, nome/legenda e reprodução no host; não afirmar PTT/codec só por MIME.
- [ ] Host BFF revalida membership; decidir cópia Active Storage versus referência Broker, retenção/revogação e eliminação. Endpoint/bucket compartilhado não concede autorização entre sistemas.
- [ ] Reinício real de API/worker/consumidor, callback indisponível, dedupe, recibos fora de ordem, revogação e perda de ACK sem duplicação.
- [ ] Restore conjunto de banco/objetos/chaves e rollback de imagem mantendo migration aditiva e bloqueio de novos envios enquanto houver pendências incertas.

## Checkpoint de retomada

Preparação documental e decisões D1/D2 concluídas; produto, migration, testes novos e geração de contrato ainda pendentes. Último migration observado: `0073`. Docker `desktop-linux` sem named pipe funcional segundo coleta do executor principal; não há teste PostgreSQL/storage/E2E desta fatia. Retomar pela conferência de pré-requisitos da Tarefa 0; não começar gerando OpenAPI ou autorizando mídia pela chave antiga.
