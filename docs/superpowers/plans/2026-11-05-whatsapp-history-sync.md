# WhatsApp History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task inline. Steps use checkbox syntax. Preserve existing checkouts and commits; any independent reviewer must use only its assigned scope.

**Goal:** Sincronizar no Broker e no Atendimento JRC os chats, mensagens individuais/grupos e mídias recuperáveis da sessão QR, com progresso real e sem efeitos de automação.

**Architecture:** Ampliar captura durável na Evolution pinada e criar contrato V2 aditivo para importação e projeção. Broker guarda fatos e checkpoints independentemente do JRC; receptor Rails confirma mensagens/anexos após persistência, sem callbacks live. V1 permanece disponível.

**Tech Stack:** Node24.19/TypeScript, Evolution/Baileys pinados, PostgreSQL, Redis existente, S3/MinIO privado, React, Rails/Sidekiq/Vue do LAB2.

**Spec:** `docs/superpowers/specs/2026-11-05-whatsapp-history-sync-design.md`.

## Global Constraints

- Bases: Broker0266ec02 e LAB2200b4f1; conferir novamente HEAD/status/mains antes de editar. Não sobrescrever trabalho, fazer merge na main ou presumir imagem implantada por branch.
- Nenhum backup/dump/restore, envio real, replay cego, desconexão/pareamento ou alteração produtiva de engine neste plano de validação.
- ProtocoloV1 intacto; V2 negociado por capability. Nenhum fallback histórico para POST live.
- Preservar availableFrom para cache legado sem prova. Captura atual autenticada pode conter occurredAt antigo; exigir proveniência da sessão, não simples idade da mensagem.
- KEEP; nenhum bucket público, credencial nova, limpeza de cache/conversa ou mudança de membros/atribuições.
- Histórico não aciona bot/send/campanha/SLA/notificações/autoassignment nem muda o estado de conversa existente.
- Identificadores V2 de canal e instância separados. Números/URLs/segredos não entram em logs/test fixtures/commits.
- Migrations aditivas e reversão por pausa do recurso; não executar down destrutivo. Reconciliar numeração com main antes de criar.

## Review Focus

1. Mensagem legítima anterior ao pareamento versus cache de outro dono: teste de proveniência e mudança de identidade nas tarefas1/2.
2. Mesmo provider ID em grupo, outro tenant ou geração: chave canônica e não colisão na tarefa3.
3. Mensagem live e histórica concorrentes: uma conversa/mensagem/anexo, responsável/status preservados nas tarefas3/4/5.
4. URL expirada, bytes truncados ou objeto perdido depois do ACK lógico: recibo físico/retry/KEEP nas tarefas4/5.
5. Aba fechada, usuário revogado, cancelamento durante página e crash: worker durável, revogação e retomada nas tarefas2/3/6/7.

## Estrutura dos repositórios

**B** = checkout Broker `BrokerJRCIA-source-audit/.worktrees/broker-connection-audit-20261104` no workspace.
**L** = checkout LAB2 `.worktrees/release-grupojrc-20261022` no workspace.
Todos os caminhos abaixo são relativos ao repositório indicado. Arquivos marcados Criar são propostos, não funcionalidades existentes.

### Task 1: Contrato V2, proveniência e migrações aditivas

**Files:** Criar B `packages/contracts/src/history-sync-v2.ts`, `packages/contracts/tests/history-sync-v2.test.ts`, `apps/api/src/modules/history-sync/types.ts`, `apps/api/tests/unit/history-sync-contract.test.ts`; modificar B `packages/contracts/src/index.ts`. Criar migration SQL seguinte a0084 após rechecagem, sem tocar0067/0078. Documentar upgrade/pausa em `docs/api/history-sync-v2.md`.

**Interfaces propostas:** `HistorySyncScope` = organizationId/channelId/historyAccountIdentity/instanceId/identityScopeId/engineGeneration/bindingFingerprint. `historyAccountIdentity` vem de catálogo persistido cujo HMAC inclui tenant+canal+dono normalizado e exclui geração/instanceKey; scope de captura rotaciona, identidade lógica não muda na reconexão do mesmo dono. `HistorySyncRecord` discriminado CHAT/CONTACT/MESSAGE e INDIVIDUAL/GROUP, com providerId/direction/occurredAt/participant e content TEXT ou mediaReference. `SourceCaptureReceipt` vincula esse scope ao chunkId/checksum/capturedAt e à prova do evento socket atual. `HistorySyncStatus` separa captura/persistência/projeção/mídia e lacunas.

- [ ] RED: V1 continua rejeitando V2; loteV2 aceita texto/grupo/referência de mídia, não aceita segredo/URL arbitrária, hash errado, tenant/generation cruzados ou categorias incoerentes. Data antiga sozinha não é rejeição de captura válida; cache legado sem prova é recusado.
- [ ] Implementar schemas estritos, catálogo `history_account_identities` e ledger `history_sync_runs/chunks/receipts` tenant-scoped, índices de pendência/dedupe e RLS/grants. Incluir chunks PROVISIONAL isolados por sessão/generation ainda sem owner, sem tratá-los como identidade confirmada. Captura epoch/generation permanece evidência obrigatória, mas não compõe a chave final do mesmo fato. Armazenar páginas privadas limitadas por bytes; contadores semânticos não devem misturar staging, captura validada, persistência e entrega.
- [ ] GREEN: `node --max-old-space-size=192 node_modules/vitest/vitest.mjs run packages/contracts/tests/history-sync-v2.test.ts apps/api/tests/unit/history-sync-contract.test.ts --maxWorkers=1 --no-file-parallelism`; testes PG da migration nova e upgradeV1 em banco isolado. Confirmar constraints, transação e leitura após reinício.
- [ ] Rever diff, rodar `npm test` focal e diffcheck antes do commit; registrar SHA e evidências. Capacidade/rotas não ativadas.

### Task 2: Captura autenticada e journal da engine pinada

**Files:** Modificar B `integrations/evolution-origin-journal/src/projection.mjs`, `engine-overlay.mjs`, `journal.mjs`, `worker.mjs` e composição estritamente necessária; criar `src/history-projection.mjs`, `tests/history-projection.test.mjs`, `tests/history-crash.test.mjs`; expandir `tests/ownership.test.mjs`, `provenance.test.mjs`, `engine-build.test.mjs`. Manter submódulo no mesmo commit.

**Interfaces:** `projectHistoryBatch(binding, payload, captureContext)` produz chunks canônicos bounded com `SourceCaptureReceipt` a partir do evento socket da sessão autenticada. Esse é o caminho normativo; não aceitar assinatura nova de cache sem proveniência como equivalente. Captura sem owner/epoch comprovados não produz sucesso. Consome contrato da tarefa1; receptor de captura V2 registra chunk e ACK correlacionado somente após commit. Não reutilizar o ACK live individualTEXT de0078 para lotesV2.

- [ ] RED: history.set misto >100 mensagens é particionado sem perda; progress/end marker, chats sem texto, outbound, LID/grupo/mídia. Histórico chega antes da confirmação do owner e há crash: staging durável mantém o lote. Troca de dono/generation antes da promoção conserva quarentena e impede associá-lo ao novo dono. Quota de staging esgotada produz parcial/lacuna, nunca sucesso. Evento duplicado e captura parcial não viram conclusão.
- [ ] Implementar staging PROVISIONAL limitado e isolado antes do owner, com persistência privada durável e digest. Confirmação de staging não equivale ao ACK de origem validada. Promover somente após prova da mesma sessão/generation; autorização e identidade válidas iniciam a importação. capturedAt separado de occurredAt, persistência antes do ACK final, chunks estáveis/retry e KEEP. Aproveitar o journal existente; não capturar raw auth/session em payload/log nem presumir que WhatsApp repetirá lote perdido.
- [ ] GREEN: `node --test --test-concurrency=1 integrations/evolution-origin-journal/tests/history-projection.test.mjs integrations/evolution-origin-journal/tests/history-crash.test.mjs`; complementar com PostgreSQL/journal real e imagem de engine isolada com crash/restart/ownership/ordenação. Habilitação e configuração só de laboratório.
- [ ] Comparar imagem construída/source pin/entrypoint com artifact contract; documentar compatibilidade e condição de rollback. Não mudar engine produtiva ou forçar QR para comprovar o código.

### Task 3: Persistência Broker, catálogo histórico e deduplicação

**Files:** Criar B `apps/api/src/modules/history-sync/service.ts`, `store.ts`, `writer.ts`, `source.ts`, `worker.ts`; `apps/api/tests/integration/history-sync-v2.test.ts`, `history-sync-identity.test.ts`, `history-sync-concurrency.test.ts`; modificar apenas os pontos de reuso necessários em `messaging/qr-contact-persistence.ts`, `repository.ts` e identidade de grupos. Preservar `history-import/*`V1.

**Interfaces:** `createHistorySyncService(options)` oferece `admit(scope,policy,requestId)`, `acceptChunk(scope,chunk)`, `status(org,runId)`, `resume(org,runId,revision)`, `cancel(org,runId,revision)`; `writeHistoryRecords(tx,scope,records)` retorna IDs canônicos e contagens, sem HTTP na transação.

- [ ] RED: snapshot sobreposto com live, importações repetidas com runId diferente, reconexão do mesmo dono, troca de engine autorizada, mudança de dono, adoçãoV1 comprovada/ambígua, mesmo timestamp, mesmo providerID em grupos/tenants diferentes, LID conflitante e cancelamento concorrente. Recibos não podem confirmar item descartado; nova captureEpoch não duplica histórico do mesmo dono.
- [ ] Persistir fato, recibo e checkpoint atomicamente; dedupe estável por historyAccountIdentity/canal/recipientKind/JID/providerID, conferindo hash e IDs canônicos live/V1 comprovados. Conflito legado não recebe owner atual automaticamente nem gera cópia. Catálogo de chats é separado de mensagens recuperáveis. Legacy cache somente dentro da prova V1 atual; cobertura anterior depende da captura autenticada, não de recuar availableFrom.
- [ ] GREEN: `npm run test:integration -- apps/api/tests/integration/history-sync-v2.test.ts apps/api/tests/integration/history-sync-identity.test.ts apps/api/tests/integration/history-sync-concurrency.test.ts --maxWorkers=1 --no-file-parallelism`; comparar independentemente listas de IDs/hashes e provar persistência após crash.
- [ ] Garantir páginas100/bytes limitados, backpressure e prioridade live. Cobertura >10000 por chunks paginados, nunca carregamento ilimitado em RAM. Revisar e registrar commit sem iniciar importação produtiva.

### Task 4: Receptor silencioso LAB2 e anexos físicos

**Files:** Criar L `app/services/jrc_broker/history_sync_v2.rb`, `history_sync_bootstrap.rb`, `history_sync_media.rb`, `app/controllers/api/v1/accounts/jrc_history_syncs_controller.rb`, `app/jobs/jrc_broker/history_sync_media_job.rb`, modelo e migration aditiva para recibosV2; modificar L `config/routes.rb`. Criar L `spec/requests/jrc_history_sync_v2_spec.rb`, `spec/services/jrc_broker/history_sync_v2_spec.rb`, `history_sync_media_spec.rb` e `spec/jobs/jrc_broker/history_sync_media_job_spec.rb`.

**Interfaces:** Namespace proposto `/api/v1/accounts/:account_id/jrc_history_sync/v2`; capability por inbox; bootstrap de conversa; POST mensagem; GET recibo. Body inclui org/integration/inbox/canonicalSourceIdentity/destinationRevision. Receptor devolve receiptId/messageId/hash/state depois de commit, ou processamento pendente para mídia. `HistorySyncMediaJob` materializa anexo privado e emite recibo READY só depois de upload e leitura física verificada.

- [ ] RED: isolamento/role/token incorretos, POST duplicado após ACK perdido, contato/conversa live já existente, troca de destino, grupo/participante, mensagem enviada pelo próprio número e conversa resolvida. Congelar contadores de bot/send/webhook/notifications/SLA/assignment em zero durante backfill.
- [ ] Reusar autoridade/locks/estratégia callback-free V1, preservar datas/direção, mapear grupos separadamente de telefone e deduplicar também anexos. Histórico novo fica fora do backlog operacional; histórico em conversa existente preserva seu estado e responsável. Download fora da transação, fila/recibo duráveis e recuperação de upload órfão sem remoção automática.
- [ ] GREEN em Rails/Sidekiq/PostgreSQL e MinIO isolados: `bundle exec rspec spec/requests/jrc_history_sync_v2_spec.rb spec/services/jrc_broker/history_sync_v2_spec.rb spec/services/jrc_broker/history_sync_media_spec.rb spec/jobs/jrc_broker/history_sync_media_job_spec.rb`; testar bytes/hash/leitura após reinício, URL vencida/truncamento/falha e retry. Não afirmar que mock de storage é comprovação física.
- [ ] Testar migration de banco vazio e upgrade do schema atual; pausaV2 compatível com app anterior, sem apagar dados. Receptor antigo devolve capabilityV1; v2 não entra em fallback live.

### Task 5: Projeção e recibos Broker → consumidor

**Files:** Criar B `apps/api/src/modules/integrations/chatwoot-history-v2-worker.ts`, testes `apps/api/tests/integration/history-sync-chatwoot.test.ts`, `history-sync-media-custody.test.ts`; ampliar B `integrations/chatwoot-client.ts`, composição runtime e contratos de mídia de forma aditiva. Reusar S3 privado e media-custody KEEP.

**Interfaces:** `projectHistoryRun(org,runId,signal)` consome fatos canônicos/tarefa3 e capacidade/tarefa4; confirma receiptId/hash/destinationVersion. Estado persistido local não significa entregue ao JRC; anexos pendentes não são entregues por simples HTTP202.

- [ ] RED: JRC fora do ar, POST confirmado sem resposta, storage perdido, integração removida/recriada, receptorV1, reordenação de chunks e evento live igual. Provar que nenhum desses casos dispara POST live ou reenvio WhatsApp.
- [ ] Implementar fila histórica de baixa prioridade, retry/backoff, reconciliação de recibo e renovação de URL privada restrita ao objeto/tenant. Falha permanente registra lacuna; rede incerta preserva obrigação. Sem ACK de custódia física, KEEP continua.
- [ ] GREEN: testes PG/Redis/MinIO com dois consumidores independentes/two tenants; comparar IDs entre origem/Broker/JRC e bytes nas cópias. Crash após commit antes de ACK precisa convergir para o mesmo receipt/message/anexo.
- [ ] Documentar matriz de compatibilidadeV1/V2/adaptador externo e os hashes de teste; revisão do diff antes do commit.

### Task 6: Automação da jornada e progresso nos dois produtos

**Files:** Criar B `apps/api/src/http/routes/history-sync-v2.ts`, `apps/api/tests/http/history-sync-v2.test.ts`, `apps/web/src/channels/HistorySyncPanel.tsx`, `HistorySyncPanel.test.tsx`; modificar B `apps/api/src/commands/history-import-worker.ts`, `apps/api/src/http/routes/chatwoot-control.ts`, `apps/api/src/modules/integrations/chatwoot-control-service.ts` e composição para comporV2 sob gate e budgets existentes. Modificar L `app/javascript/dashboard/routes/dashboard/jrcBroker/ConnectionsPage.vue`, `app/javascript/dashboard/api/jrcBroker.js`, `app/controllers/api/v1/accounts/jrc_broker_controller.rb` e `app/javascript/dashboard/components-next/jrc-broker/__tests__/ConnectionsPage.spec.js`/`connectionsApi.spec.js`; criar L `app/javascript/dashboard/components-next/jrc-broker/HistorySyncStatus.vue` e `__tests__/HistorySyncStatus.spec.js`.

**Interfaces:** Rotas propostas no design, sem reutilizar o ID públicoV1 ambiguamente. Gate novo proposto `HISTORY_SYNC_V2_ENABLED=false` mais política por canal/autoridade. Estado exposto por integração autorizada; leitura dos agentes conforme membership, start/cancel/configuração apenas administrador. Sem credencial do Broker no browser.

- [ ] RED: conexão nova admitida uma vez depois da identidade; browser fechado não interrompe; reconexão mesma identidade retoma; identidade nova não mistura histórico; revogação para o worker; tenant cruzado/role restrita403; UI não diz concluído se projeção/anexo estiverem pendentes.
- [ ] Política por conexão `groupsMode=ALL_AUTHORIZED` cobre histórico e live, materializando escopos centrais idempotentes só da inbox autorizada, inclusive para grupo novo. Preservar SELECTED em conexões não habilitadas e provar que nenhum binding de bot/automação foi ativado. Tela no Broker e Conectar WhatsApp JRC: capturando/sincronizando/pronto/parcial/bloqueado, contagens por categoria, última confirmação, retomar/cancelar quando autorizado. Atendimento inclui histórico na pesquisa/lista apropriada, mantendo Minhas/compartilhadas/URA e sem substituir filtros por importação.
- [ ] GREEN: Vitest/HTTP/Playwright dos componentes e jornadas reais com API+Rails locais; acessibilidade, celular, lista grande paginada e falha/retry. Autocaptura independe de destinoREADY; somente projeção aguardaREADY. Deploy com gate desligado não admite backfill em conexões atuais.
- [ ] Atualizar OpenAPI/PDF/Postman no mesmo commit das rotas efetivas, e inventário de segurança; entradas propostas não são apresentadas como API já publicada.

### Task 7: CI integrada, infraestrutura e aceite progressivo

**Files:** B `.github/workflows/ci.yml`, `images.yml`, testesE2E em `apps/web/tests/e2e/history-sync.spec.ts`, docs `docs/api/history-sync-v2.md`; workflow LAB2 de regressão nativa, manifests e checkpoint. Compose/ENV produtivos somente em release posteriormente autorizada.

- [ ] Validar imagem efetiva da engine, owner/proveniência, dados disponíveis no cache e fonte READ ONLY, flags de retenção e versões de storage. Não copiar URLs/chaves para relatório; registrar presença/situação e digests. Se fonte não contiver o histórico, relatório deve dizer isso.
- [ ] Executar unitários, contratos/API/OpenAPI, PG/Redis, Rails/Sidekiq, MinIO físico, engine isolada e E2E no SHA candidato; separar testes existentes dos novos. Não rodar agregados backup/dump/restore. Medir RAM/CPU/backlog/tempo/live latency com eventos sintéticos e tamanho crescente de histórico.
- [ ] Revisar pools, quotas e workers a partir das métricas. Reutilizar o processo history-import-worker inicialmente; só acrescentar processo/pool quando a medição justificar. Fonte, API e projeção precisam de budgets separados para não congelar Atendimento.
- [ ] Candidatas separadas para Broker API/web, LAB2 Rails/Sidekiq e engine se necessária. Não atualizar engine real apenas para fazer o teste; rollout real exige autorização específica, janela e gate por inbox.
- [ ] Homologar primeiro uma sessão autorizada, comparando categorias/IDs e leitura visual do Atendimento; depois expandir. Registrar itens ausentes na origem, antigas atribuições de bot e membros de caixa como questões separadas. Não declarar900 sessões nem100% de histórico com base em teste sintético.

## Ordem e conclusão desta rodada

### Task 8: Atendimento agrupado por caixa de origem (escopo adicional aprovado)

Spec: LAB2 `docs/superpowers/specs/2026-11-05-inbox-by-origin-design.md`. Alterar agrupamento de canal para inbox_id, origem/número sempre distintos do responsável e no cabeçalho/compositor, horário da última mensagem e filtros simples com avançados recolhidos. Compartilhamento/URA/permissões, estados de resolução e URLs existentes preservados. Usar identidade autorizada, sem consulta HTTP por cartão. Cobertura de UI, serialização segura e resposta de identidade fora de ordem é obrigatória. Pode avançar após contrato de origem confiável, sem esperar captura real do telefone. Não confundir essa melhoria visual com sincronização concluída.

1→2→3 define/garante a origem; 4 constrói receptor;5 fecha entrega/custódia;6 oferece jornada automática;7 prova ponta a ponta e prepara rollout. Receptor4 pode ser desenvolvido após1 em paralelo técnico, mas o método desta validação é execução inline futura, sem abrir trabalho paralelo de produto agora.

**Checkpoint de implementação05/11:** contratos e ledger privadoV2, migration0085, staging cifrado, promoção, quotas e comandos implementados. 50 contratos/focais e31PGV1/V2/upgrade passaram, incluindo kill real do processo depois do commit antes deACK. Task1 tem esse núcleo validado, mas a origem autenticada e sua composição ainda dependem da Task2; Task3 tem staging e catálogo, ainda sem writer/dedupe live completos. Task8 tem agrupamento por inbox, origem/responsável separados, relógio de mensagem e snapshot autorizado com expiração/quarentena;18focais,23Hoya,32InboxList e9Ruby/21asserts passaram em execuções separadas. Regressão final combinada está no checkpoint do workspace. RSpec completo, build frontend, E2E e CI nova ainda são gates pendentes. Tasks2/4/5/6/7 não foram consideradas concluídas. Sem publicação/deploy/replay/captura produtiva ou migration em produção.
