# B02 — fronteira de continuidade e decisão de implementação

Inspeção local em 29/10/2026, base Broker `9e62ceaf3177979a68bc4985a93e25474de48487`, branch `codex/broker-audit-fixes-20261029`. Evolution fixada em `fa09d37892cdbb1d65a250155d293d92230c5b30`. Foram lidos AGENTS, relatórios 03/04/05/13 e o plano da fase 2. Este incremento escreve somente este relatório; não altera código, submódulo, dependências, banco, imagem, configuração ou serviço.

## Parecer

**B02 permanece parcial na investigação e bloqueado para a afirmação de entrega durável completa.** A garantia demonstrada do Broker começa no COMMIT da ingestão autenticada. A origem Evolution não conserva uma intenção durável de entrega dos eventos inspecionados. Uma inbox/spool no receptor só conserva o que chegou a ela.

É tecnicamente possível construir um incremento real dentro deste repositório sem modificar o checkout upstream: uma receita de imagem local que copia o SHA fixado para uma árvore de build e aplica ali um patch JRC versionado, com outbox PostgreSQL integrada aos produtores da engine. Isso precisa ser entregue como integração efetiva da imagem local, schema, dispatcher e testes da fonte modificada; um módulo independente no Broker não atende o item. **Essa imagem/integração ainda não existe e não foi implementada neste incremento.** A política atual registra upstream imutável e alterações JRC nos adapters/serviços (`docs/legal/evolution/UPSTREAM.md:8-9`); um derivado deve declarar explicitamente sua identidade e sua diferença, mantendo o gitlink e o gate existentes. Não deve ser apresentado como a engine oficial inalterada.

Recomendação para a fase corrente: preservar o runtime e registrar a dependência com precisão. Se o próximo incremento implementar a receita local, começar por mensagens individuais persistidas, anunciar o escopo restrito e provar Message+outbox na mesma transação antes de ampliar a eventos de conexão/grupo. Sem essa implementação conectada e testada, o critério B02 não fecha.

## Fronteiras e pontos de integração comprovados

Referências `upstream/...` apontam a fonte fixada, não atestam o binário observado em produção.

| Etapa | Evidência | Consequência |
|---|---|---|
| Produtor de mensagem recebida | `upstream/evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts:1355-1358` persiste `Message` se SAVE_DATA.NEW_MESSAGE; `:1483` chama `sendDataWebhook` sem await | Há janela entre persistir mensagem e capturar sua entrega. Não há transação Message+intenção de webhook nesse caminho. |
| Produtor de status | Mesmo arquivo `:1690-1693` atualiza status; `:1702` emite; `:1704-1707` persiste `MessageUpdate` condicionalmente | A ordem é diferente da mensagem: um hook somente após insert de MessageUpdate não conserva necessariamente o evento exato emitido. |
| Envelope | `upstream/evolution-api/src/api/services/channel.service.ts:435-463` cria horário e chama `eventManager.emit` | Hook central é um ponto de integração, mas persistir somente aqui ainda deixa a janela após COMMIT de Message e antes dessa chamada. |
| Fanout | `upstream/evolution-api/src/api/integrations/event/event.manager.ts:128-134` aguarda websocket, RabbitMQ, NATS, SQS, webhook, Pusher, Kafka em sequência | O enqueue precisa preceder transportes externos; falha ou espera anterior ao webhook também pode impedir sua execução. |
| Retry HTTP | `upstream/evolution-api/src/api/integrations/event/webhook/webhook.controller.ts:203-282`; contador local `:220`, POST `:224`, timer `:282`; catches externos `:135-148,185-198` só registram falha | Reinício elimina payload/tentativas/timer; falha terminal não vira DLQ durável nesse método. |
| Contrato configurado pelo Broker | `packages/providers/src/evolution/messaging.ts:25,220-245`; `apps/api/src/modules/messaging/qr-service.ts:136-141` | Integração usa webhook com Authorization por canal, eventos limitados e base64 false; nenhum consumer alternativo durável é configurado ali. |
| Recebimento no Broker | `apps/api/src/http/routes/integrations.ts:368-378`; `modules/messaging/qr-service.ts:182-206,191-260`; `db/tenant-transaction.ts:38-47` | Autenticação/autoridade e gravação ocorrem antes de responder 200, com COMMIT aguardado. A garantia cobre fatos reconhecidos pelo normalizador, não todos os bytes arbitrários do envelope. |

Os últimos caminhos `modules/...` e `db/...` são relativos a `apps/api/src/`. O normalizador pode omitir conteúdo fora de contrato: sucesso HTTP não significa que toda variante Evolution produziu uma mensagem persistida. O gap de mídia de grupo permanece separado.

## Alternativas examinadas

| Alternativa | Capacidade real | Decisão |
|---|---|---|
| Spool HTTP diante do Broker | Conserva pedidos recebidos e aceitos pelo spool; reduz janela posterior a esse recebimento | Útil apenas como camada adicional. Não substitui intenção durável na engine nem fecha B02. |
| RabbitMQ já implementado | Exchanges/queues duráveis e quorum existem, mas usa `createChannel` comum `rabbitmq.controller.ts:74`, `publish` sem publisher-confirm e sem opção `persistent` em `:274,327`; sem conexão retorna em `:222-224` | Não basta ativar ENV. Antes de publish continua sem registro durável; `await` no booleano de publish do callback API não é confirmação do broker. Também exige consumer JRC e operação novos. |
| NATS já implementado | `nats.controller.ts:5,85,105` usa `NatsConnection.publish`, sem JetStream nesse caminho | Core publish não adiciona log de origem/replay durável; não resolve. |
| SQS já implementado | `sqs.controller.ts:146-151` pode omitir payload grande; `:181-194` envia por callback e registra erro | Uma fila aceita conserva o que recebeu, mas falha antes da aceitação não possui ledger local; não resolve sozinha. |
| Kafka já implementado | `kafka.controller.ts:275-277` retorna sem conexão; `:305-343,351-388` tenta até três vezes sem ledger de origem | Pode conservar publicação aceita conforme configuração do cluster; não fecha janela pré-publicação nem falha terminal. |
| Reconciliação da fonte PostgreSQL existente | `apps/api/src/modules/history-import/postgres-source.ts:49-71` lê snapshot READ ONLY/REPEATABLE READ e texto individual com limites; `:83-89` conserva snapshot no Broker | Recuperação histórica limitada já conectada. Não equivale a replay do evento live, não recupera eventos sem linha, mídia/grupo completos ou transições perdidas de conexão. Não transformar histórico silenciosamente em novo inbound/bot. |
| Trigger adicional em Message/MessageUpdate no banco Evolution | Pode inserir uma outbox na mesma transação do registro persistido sem editar código upstream | Viável em laboratório futuro para o subconjunto persistido, mas muda schema da engine e semântica/carga de suas escritas. Não reconstrói envelope original ou evento transitório e exige integração com migrações/restore da engine. Não instalar trigger ad hoc nem declarar continuidade geral. |
| Derivado local com patch de origem + PostgreSQL | Pode ligar produção e intenção no mesmo commit e iniciar dispatcher real na imagem, preservando checkout/gitlink oficial | Caminho preferido para resolver o requisito com escopo explícito. A implementação integrada, imagem derivada e prova de recuperação são trabalho restante. |

Os controladores de transporte da tabela ficam em `upstream/evolution-api/src/api/integrations/event/{rabbitmq,nats,sqs,kafka}/`. Não foi acessado nenhum desses serviços; a avaliação é de código.

### Por que consulta incremental simples não é um replay completo

`Message` conserva timestamp do conteúdo e ID cuid, não um cursor transacional de ingestão nem ledger de webhook (`upstream/evolution-api/prisma/postgresql-schema.prisma:155-180`). `MessageUpdate` também não tem sequência de ingestão/horário de entrega (`:183-198`). Ordenar por timestamp/ID com watermark crescente pode perder chegada tardia com timestamp anterior. Uma janela com sobreposição reduz esse risco somente sob uma hipótese explícita de atraso máximo; não prova ausência de lacunas. Scan completo limitado exige orçamento e retenção que conservem a fonte até captura, e ainda não recupera fatos jamais gravados.

O importador atual exige instância aberta/dono verificado (`postgres-source.ts:51-52`), epoch de identidade (`:40-41`), no máximo 10.000 registros e 14 MB no snapshot (`:59-67`); usa projeção histórica e não agenda envio (`history-import/README.md:25-28`). Pode ser usado pelo fluxo já autorizado de importação para recuperar TEXT individual armazenado; não deve ganhar a etiqueta de continuidade live.

## Implementação mínima realmente integrada para um próximo incremento local

1. Receita JRC fora de `upstream/`, base digest/pacotes fixados, patch versionado com hash e aplicação estrita ao SHA esperado. Copiar a fonte preservada para estágio de build e aplicar somente nessa cópia; não tocar o gitlink, working tree ou gate `security:submodule`. Não usar patch silencioso na imagem comercial já implantada.
2. Schema adicional da engine para eventos/intents/destinos/tentativas com ID estável, corpo canônico/hash, engine/instância/epoch, ordem e lease. Evitar credenciais/apikey no payload e logs. Uma outbox somente no banco Broker não é atômica com Message do banco Evolution. O banco da outbox deve ser explícito na proveniência/restore.
3. Para MESSAGES_UPSERT persistido, modificar a transação do produtor `Message.create` e incluir outbox no mesmo COMMIT. O hook central deve capturar demais eventos antes de efeitos externos e não suprimir erro de enqueue. Apenas adicionar enqueue em `WebhookController.emit` ou em `ChannelStartupService.sendDataWebhook` não elimina a janela de Message já confirmada. Eventos sem persistência anterior precisam de contrato próprio de admissão; não prometer recuperação de um fato que morreu antes de atingir qualquer armazenamento.
4. Integrar dispatcher no entrypoint da imagem derivada, com lease/backoff/recovery após restart, delivery persistida e mesmo eventId em ACK perdido. Não dar baixa antes do 2xx do Broker; erros permanentes conservam evidência para redrive. Desabilitar o caminho direto duplicado para o mesmo destino somente no perfil local da integração testada. Outros consumidores upstream devem ter comportamento explicitamente definido.
5. Preservar autorização Broker por token/canal e binding corrente (engine/generation/fingerprint/epoch); não derivar organização do corpo recebido ou reapontar backlog de uma instância antiga para um novo dono. Revalidar autoridade no envio e na ingestão; revogação/lifecycle durante lease deve bloquear o efeito. IDs estáveis e hash detectam conflito sem substituir dedupe existente por heurística de horário.
6. Validar limites HTTP/normalização e catálogo de eventos. Ingresso atual limita corpo a 1 MiB e não preserva um evento genérico para replay. Um ACK do handler atual prova os fatos reconhecidos; se o novo contrato exigir captura genérica, adicionar versão/receipt explícitos e testes sem quebrar a API pública atual.

Isso preserva PostgreSQL/RLS e não introduz Redis como fonte de fila. O que não pode ser afirmado mesmo após esse incremento: recuperação de fato WhatsApp anterior à captura durável na engine, suporte de todo evento/media upstream, capacidade de 900 sessões, identidade de imagem produtiva ou restauração real de sessão.

## Verificação executada e limites da prova

| Verificação local | Resultado |
|---|---|
| `git rev-parse HEAD`, branch, `git ls-files --stage -- upstream/evolution-api`, `git submodule status`, `git -C upstream/evolution-api status --short` | HEAD/base e branch acima; gitlink 160000 no SHA fixado; checkout upstream sem alterações. |
| Probe Node do corpo real de `retryWebhookRequest` extraído da fonte (somente remoção de `get<Webhook>` para executar JS), transporte sintético que falha e timer interceptado | Filho chegou ao primeiro erro com `attempts=1`, timer pendente `5000 ms`, terminou intencionalmente com exit 73. Novo processo sem reemissão fez zero POST. Mostra perda do trabalho em RAM nesse harness; não foi restart da engine nem prova de um consumer ausente na imagem produtiva. |
| Mesma função extraída, timer imediato, jitter zero, transporte 503 | Dez POSTs; nove esperas de 5/10/20/40/80/160/300/300/300 segundos simuladas; falha terminal. Nenhuma espera real ou HTTP. |
| Mesma função, transporte 401 | Um POST, nenhuma espera, falha terminal. Os catches externos foram inspecionados, não executados pela probe. |
| `node scripts/security/check-submodule-clean.mjs` | NÃO CONCLUÍDO: `spawnSync git EPERM` no ambiente. Verificações Git diretas acima passaram; não substituem um PASS do script. |
| Fonte da probe | SHA256 de `webhook.controller.ts`: `c35b3333907ac8b577ddba43ab5bfb65fbc926712dd8feb76ef021202dee94bf`. |

As probes executaram código extraído do retry existente com dependências injetadas, sem escrever scripts ou alterar a fonte. O processo de restart foi deliberadamente iniciado sem o evento: não constitui teste de bootstrap do servidor Evolution. A conclusão de ausência de ledger nesse caminho vem da inspeção dos produtores/controlador/schema em conjunto, não do campo sintético do harness.

Não executados: engine, build da engine, banco/Redis/fila/storage, crash físico, suite de integração PostgreSQL, teste de aparelho, teste da imagem observada. Não há funcionalidade nova para a qual se possa declarar RED/GREEN. Nenhuma credencial ou ENV produtiva foi lida.

## Gates para aceitar B02 futuramente

- RED/GREEN sobre a fonte integrada à imagem: queda após COMMIT da outbox e antes do POST; queda após COMMIT Broker com ACK perdido; replay após restart mantendo ID e hash; duplicata concorrente; payload conflitante. Confirmar uma única projeção no Broker em PostgreSQL real descartável.
- Queda entre Message e captura precisa ser eliminada por transação, não apenas por retry; provocar rollback de Message+outbox; simular banco indisponível e comprovar que a engine não declara admissão/captura durável. Separar essa admissão de eventual ACK anterior da camada WhatsApp/Baileys, que pode exigir investigação adicional.
- Autoridade revogada/epoch alterado/instância excluída enquanto lease está ativa; impedir cross-tenant, redirecionamento e uso de token antigo; nenhuma credencial em fila/log. RLS/FKs Broker continuam habilitadas.
- Lease vencido, completion tardio, reinício do dispatcher e disputa de workers; falhas 4xx/5xx, body acima do limite, evento não suportado, grupo/mídia fora do escopo. Falha terminal deve continuar durável/observável; não reenviar WhatsApp por replay de webhook.
- Cluster laboratório exclusivo e descartável, loopback literal e credenciais próprias, com guard antes da conexão. Não apontar `TEST_DATABASE_ADMIN_URL`, transportes ou build a serviço existente por conveniência. Medir backlog/capacidade separadamente.
- Cadeia fonte→build→imagem: SHA upstream e nested SHA preservados, hash do patch/JRC revision/receita/lockfiles, base digest, schema versão, SBOM/provenance e digest da engine derivada. Testar o código e o entrypoint efetivamente contidos nessa imagem. `.github/workflows/images.yml:88-113` constrói API/web; esse workflow não atesta nem constrói a engine.
- `infra/dokploy/compose.yaml:553-586` apenas seleciona `EVOLUTION_ENGINE_IMAGE` externo. A imagem histórica `evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339` continua sem vínculo fonte→binário atestado (relatório 03:3). Nome da tag, versão do package e HTTP 200 não fecham esse gate. A receita de demo mencionada em `docs/operations/diagnostico-login-qr-local.md:14-18` não existe no checkout inspecionado e não serve como artefato reprodutível atual.

Estado final: **fronteira identificada e decisão técnica preparada; transporte durável da origem e proveniência da engine não entregues.** Nenhum módulo desconectado, spool receptor, leitura histórica ou teste sintético foi marcado como B02 concluído. Publicação e implantação exigem tarefa futura autorizada, fora deste incremento local.
