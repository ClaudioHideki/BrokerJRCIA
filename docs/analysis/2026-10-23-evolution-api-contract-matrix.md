# Evolution 2.3.7 e API Broker JRC: matriz de contratos

Inspeção estática independente em 23/10/2026. Broker: base
`be1e9441146d3ce8f9bc29b2f1b2fd135daf4371` e árvore candidata de trabalho.
Evolution preservada: `upstream/evolution-api`, SHA
`fa09d37892cdbb1d65a250155d293d92230c5b30`, `package.json` versão **2.3.7**.
Não foram executadas chamadas ao provedor, mensagens, testes de runtime ou
alterações de produção nesta análise. Teste localizado significa cobertura
encontrada na fonte, não uma nova execução nem prova de entrega em produção.

## Limites do contrato externo

O gerador [public-api.mjs](../../scripts/docs/public-api.mjs) seleciona quatro
perfis do OpenAPI canônico: **Conexões 7, Mensageria 7, Eventos 5, Chatwoot 15**,
total de **34 operações**. A contagem foi refeita executando somente a seleção
estática dos perfis. O [build do portal](../../scripts/docs/build-portal.mjs)
produz `/documentation/openapi-{instances,messaging,events,chatwoot}.json`, PDF
e coleções Postman. Isso não comprova que o servidor já recebeu esses artefatos.

Há três superfícies distintas: chave genérica de parceiro, credencial de controle
Chatwoot vinculada a Account e autenticação/sessão delegada de Flow. Uma não
autoriza automaticamente as operações da outra. O token da Evolution permanece
interno; não é o token entregue ao CCLX nem deve aparecer no seu navegador.

## Matriz

Nos caminhos Evolution, `:i` significa o `:instanceName` acrescentado pelo
[RouterBroker](../../upstream/evolution-api/src/api/abstract/abstract.router.ts#L21).
As referências são da revisão fixada, não da versão mais recente do GitHub.

| Área | Evolution: rota e implementação | Broker: adaptador/rota real e contrato do parceiro | Cobertura localizada e lacuna concreta |
| --- | --- | --- | --- |
| Instâncias | [instance.router](../../upstream/evolution-api/src/api/routes/instance.router.ts): criar, conectar, consultar estado, listar, restart, presença, logout e delete. | [EvolutionProviderAdapter](../../packages/providers/src/evolution/evolution-provider-adapter.ts) implementa provisionamento, QR/código, estado, desconexão, busca/conciliação e remoção. [Rotas JRC](../../apps/api/src/http/routes/instances.ts): criar/listar/ler/connect/status/disconnect, acessíveis por chave com escopos. Remoção lifecycle possui outro contrato; restart/presença não são operações do perfil público. | [evolution-provider-adapter.test.ts](../../packages/providers/tests/evolution-provider-adapter.test.ts), [partner-activation.test.ts](../../apps/api/tests/http/partner-activation.test.ts). Homologar primeiro pareamento, perda de sessão e reconexão no consumidor; não prometer que a chave de Conexões remove qualquer recurso. |
| Configurações, perfil e chats | [settings.router](../../upstream/evolution-api/src/api/routes/settings.router.ts) e [chat.router](../../upstream/evolution-api/src/api/routes/chat.router.ts): settings, presença/leitura, contatos/chats/mensagens, arquivar, editar/apagar mensagem, bloqueio, perfil e privacidade. | [Workspace adapter](../../packages/providers/src/evolution/workspace.ts) lê perfil/contagens e atualiza **sete campos**: rejectCall, msgCall, groupsIgnore, alwaysOnline, readMessages, readStatus, syncFullHistory. [workspace/settings](../../apps/api/src/http/routes/instance-workspace.ts) exige JWT; atualização exige OWNER/ADMIN no serviço. Não há API genérica equivalente para catálogo de contatos, edição/remoção de mensagens, privacidade, perfil mutável ou arquivo de chat. | [evolution-workspace.test.ts](../../packages/providers/tests/evolution-workspace.test.ts) protege respostas limitadas, campos desconhecidos e token de voz existente. Expor essas capacidades por chave exige contrato e escopos próprios; dados ausentes continuam nulos. |
| Chatwoot | [chatwoot.router](../../upstream/evolution-api/src/api/integrations/chatbot/chatwoot/routes/chatwoot.router.ts): set/find/webhook. [Serviço](../../upstream/evolution-api/src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts#L91) cria cliente e, com autoCreate, cria/localiza inbox e callback. | [chatwoot-control](../../apps/api/src/http/routes/chatwoot-control.ts) oferece contexto, recursos, onboarding, status, QR, identidade, desconexão, agentes e ponte de campanha. Perfil público **Chatwoot tem 15 operações**, com chave específica e actor; não depende da chave administrativa do motor. O consumo genérico transporta mensagens/eventos e exige adaptador local no CCLX. | [chatwoot-control.test.ts](../../apps/api/tests/http/chatwoot-control.test.ts), [chatwoot-onboarding.test.ts](../../apps/api/tests/integration/chatwoot-onboarding.test.ts), [chatwoot-media-matrix.test.ts](../../apps/api/tests/integration/chatwoot-media-matrix.test.ts). Falta aceite no Chatwoot 3.x exato do CCLX e confirmação da fila Pub/Sub. QR incorporado não instala a ponte de mensageria/atribuição. |
| Flow / URA | [typebot.router](../../upstream/evolution-api/src/api/integrations/chatbot/typebot/routes/typebot.router.ts): CRUD, settings, start, changeStatus e sessões; [chatbot.router](../../upstream/evolution-api/src/api/integrations/chatbot/chatbot.router.ts) agrega outros conectores. Isso não é o editor nativo JRC. | [flows](../../apps/api/src/http/routes/flows.ts), [delegação](../../apps/api/src/http/routes/flow-delegation.ts) e [registro nativo](../../apps/api/src/http/routes/flow-native.ts) possuem contratos separados. Editor, publicação, simulação, mídia, captura, HTTP, IA e transferência constam no [catálogo de nós](../automations/node-capabilities.md). A chave genérica QR/texto não administra Flows. | [flows.test.ts](../../apps/api/tests/http/flows.test.ts), [flow-delegation.test.ts](../../apps/api/tests/http/flow-delegation.test.ts), [flow-native-installation.test.ts](../../apps/api/tests/integration/flow-native-installation.test.ts). Incorporar editor/URA no CCLX exige instalação, sessão delegada, catálogo e confirmação de handoff/retomada. Não ligar bot ao parear. |
| Eventos | [EventController.events](../../upstream/evolution-api/src/api/integrations/event/event.controller.ts#L138) inclui mensagens/set/edit/delete, contatos, chats, presença, grupos, labels e call. | O [webhook privado Evolution](../../packages/providers/src/evolution/messaging.ts) configura **seis eventos**. [qr-events](../../apps/api/src/modules/messaging/qr-events.ts) normaliza apenas parte desse universo. [API de parceiro](../../apps/api/src/http/routes/partner-webhooks.ts) publica quatro famílias: message.received, message.created, message.status e connection.status; HMAC, cursor e estado de entregas são próprios do JRC. | [evolution-messaging.test.ts](../../packages/providers/tests/evolution-messaging.test.ts), [partner-webhooks.test.ts](../../apps/api/tests/http/partner-webhooks.test.ts), [worker.test.ts](../../apps/api/src/modules/partner-events/worker.test.ts). Não há equivalência para todo evento upstream: definir schema/evento canônico, retenção, deduplicação e ordenação antes de acrescentar presença, edição, remoção, reação ou chamada. |
| Mídia | [sendMessage.router](../../upstream/evolution-api/src/api/routes/sendMessage.router.ts#L64): sendMedia, sendPtv, sendWhatsAppAudio, sendSticker; [Baileys](../../upstream/evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts#L2956) contém despacho real. PTT tem caminho próprio, com conversão e ptt:true. | [EvolutionMessagingClient](../../packages/providers/src/evolution/messaging.ts) implementa download, sendMedia e sendSticker para imagem/áudio/vídeo/documento/figurinha. **GET /v1/messaging/media/{id} já aceita messaging:read** e revalida antes de liberar bytes, conforme [rota](../../apps/api/src/http/routes/messaging.ts#L337). **Não existe envio genérico de mídia por chave de parceiro.** Upload do Flow e anexos da ponte Chatwoot não equivalem a esse contrato. | [messaging-media.test.ts](../../packages/providers/tests/messaging-media.test.ts), [private-media-minio.test.ts](../../apps/api/tests/storage/private-media-minio.test.ts), [chatwoot-media-matrix.test.ts](../../apps/api/tests/integration/chatwoot-media-matrix.test.ts). Próximo lote: upload privado + envio por assetId, autoridade da chave no dispatch, cotas/MIME, recibos e UNKNOWN. Áudio como arquivo não comprova nota de voz PTT; PTV também não está mapeado. |
| Mensagens especiais | [sendMessage.router](../../upstream/evolution-api/src/api/routes/sendMessage.router.ts#L125): localização, contatos, reação, enquete, lista, botões e status. Há implementações Baileys; a rota de status contém TODO de revisão. | [PartnerTextRequest](../../packages/contracts/src/messaging/schemas.ts) só aceita texto individual. Nenhum adapter/contrato JRC correspondente foi localizado para enviar esses tipos. **QR ignora reactionMessage**; localização/cartão/lista/respostas de botão/enquete não são normalizados como tipos canônicos e podem gerar QR_CONTENT_UNSUPPORTED. Meta ingress já converte localização/contatos para texto em [ingest](../../apps/api/src/modules/messaging/ingest.ts#L167), sem preservar uma estrutura especial completa. | Criar fixtures por tipo e versionar conteúdo/projeção antes de expor endpoints. Mensagem textual de menu no Flow não é uma lista interativa WhatsApp; campanha sequencial não é lista nativa de transmissão. |
| Grupos | [group.router](../../upstream/evolution-api/src/api/routes/group.router.ts) oferece criar, subject/foto/descrição, catálogo/participantes, convite, alterações de membros/configuração, temporárias e saída. [Baileys](../../upstream/evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts#L4329) chama métodos do cliente. | [EvolutionGroupsClient](../../packages/providers/src/evolution/groups.ts) só lê catálogo limitado; [group-text](../../packages/providers/src/evolution/group-text.ts) envia texto com destinatário GROUP explícito. [Rotas](../../apps/api/src/http/routes/whatsapp-groups.ts) exigem JWT e papel corrente. **Ingresso de grupo em qr-events normaliza somente texto**; anexos e especiais são ignorados nesse ramo. Gestão geral de participantes/convites não foi localizada no adapter JRC. | [evolution-groups.test.ts](../../packages/providers/tests/evolution-groups.test.ts), [whatsapp-groups.test.ts](../../apps/api/tests/http/whatsapp-groups.test.ts). Não há grupo no perfil público genérico. Separar expansão de mensagens de grupo de administração de membros; implementar ambas com revisão/escopo e permissões verificadas. |
| Chamadas | [call.router](../../upstream/evolution-api/src/api/routes/call.router.ts) publica offer; porém [Baileys offerCall](../../upstream/evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts#L2116) tem a chamada real comentada e retorna id fixo. Meta upstream rejeita essa operação. | Settings de rejeição/mensagem de chamada existem; não foi encontrado contrato/adapter de conversação de voz em tempo real no Broker. | Não expor o retorno fixo como chamada realizada. Telefonia WhatsApp exige transporte real, sinalização, mídia e prova separada por canal. Não pode ser concluída ativando uma flag ou copiando esse endpoint. |
| Proxy | [proxy.router](../../upstream/evolution-api/src/api/routes/proxy.router.ts) set/find; [controller](../../upstream/evolution-api/src/api/controllers/proxy.controller.ts) valida e [service](../../upstream/evolution-api/src/api/services/proxy.service.ts) aplica configuração. A conexão Baileys usa makeProxyAgent. | Não foi localizado adapter, endpoint ou perfil público JRC de proxy por instância. Proxy de saída HTTP do servidor não é esse recurso. | Trabalho separado: escopo tenant/instância, cofre para credenciais, validação de destino, auditoria e reconexão controlada. Não prometer proxy ativo pelas telas da Evolution. |
| Transportes externos | [event.router](../../upstream/evolution-api/src/api/integrations/event/event.router.ts) agrega webhook, WebSocket, RabbitMQ, NATS, Pusher, SQS e Kafka. [WebSocket](../../upstream/evolution-api/src/api/integrations/event/websocket/websocket.controller.ts), [RabbitMQ](../../upstream/evolution-api/src/api/integrations/event/rabbitmq/rabbitmq.controller.ts) e [SQS](../../upstream/evolution-api/src/api/integrations/event/sqs/sqs.controller.ts) têm implementações condicionadas à configuração. | JRC oferece feed durável e webhook assinado. Não foram encontrados adaptadores externos equivalentes por tenant para os demais transportes; filas/Redis internos não são APIs de Pub/Sub para o CCLX. | Manter webhook/polling como contrato entregue. Se necessário, acrescentar transporte a partir da outbox canônica, com cursor/ack, isolamento, reconexão, backpressure e DLQ; não retransmitir payload bruto/global do motor. |

## Próximo lote recomendado

1. **Mídia do parceiro:** concluir upload privado e despacho por referência já
   armazenada, reutilizando outbox/worker e identidade da API key. Cobrir expiração,
   revogação antes do dispatch, isolamento, MIME/quota, repetição idempotente e
   resultado incerto. Gerar OpenAPI, PDF e Postman da mesma fonte. Download existe;
   não reconstruí-lo nem abrir uma URL pública para o arquivo.
2. **Ingresso completo e representação:** implementar primeiro localização,
   cartão de contato e reação com conteúdo versionado; projetar corretamente na
   central e no evento do parceiro. Adicionar fixtures de envelopes efêmeros,
   deduplicação, mensagem referenciada e mídia de grupos. Não descartar silenciosamente
   tipos que a interface afirma suportar.
3. **Capacidades e consumo CCLX:** publicar uma matriz consultável por canal e
   versão, diferenciando receive/send e os tipos suportados. Homologar QR, texto,
   download, nova mídia, estado, loop e handoff na versão exata do host. Instalação
   QR, ponte de mensageria e editor de Flow são entregas distintas.
4. Só depois ampliar presença/leitura/edição/remoção e catálogo de contatos/chats,
   administração de grupos, listas/botões/enquetes, PTT/PTV/status e proxy, cada qual
   com adapter, persistência e contrato próprio. Transporte Pub/Sub externo e voz
   em tempo real permanecem projetos explícitos, sem indicação fictícia de sucesso.

Nenhum desses lotes exige expor uma rota genérica de passthrough para a Evolution.
Uma rota publicada, um teste com fetch simulado e uma entrega real no WhatsApp
continuam sendo três evidências diferentes. Não há base nesta inspeção para afirmar
paridade completa nem equivalência automática entre Baileys e Meta.

## Licença da referência fixada

O [LICENSE preservado](../../upstream/evolution-api/LICENSE) declara Apache 2.0
com condições adicionais sobre logo/copyright dos componentes frontend e aviso
visível a administradores de que a Evolution é utilizada, acessível pela documentação
ou configurações. Preservar licença e atribuições; a interface própria JRC não
autoriza apagar avisos de componentes frontend reaproveitados. Esta é a leitura
do texto distribuído na revisão fixada, não uma conclusão jurídica sobre outras versões.

Referência pública primária:
[árvore Evolution fixada](https://github.com/evolution-foundation/evolution-api/tree/fa09d37892cdbb1d65a250155d293d92230c5b30).
