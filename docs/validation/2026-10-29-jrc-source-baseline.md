# Fonte JRC Conversas e contratos Broker — 29/10/2026

## Alvo autoritativo e alcance da evidência

O usuário corrigiu a origem autoritativa para
[`ClaudioHideki/jrc-conversas-lab2`](https://github.com/ClaudioHideki/jrc-conversas-lab2).
Esta correção prevalece sobre a URL comercial-integrado do pedido inicialmente
anexado. A comparação com comercial-integrado é histórica; sua divergência não é
bloqueio para implementar e testar no lab2.

Esta descoberta consulta refs, ancestralidade e arquivos Git. Não modifica fonte
JRC, não escolhe imagem de produção, não homologa instalação, não executa Rails,
Sidekiq, Redis, provider ou mensagens reais. A identificação de `1da5bbfb` na
instalação em 27/10 é evidência anterior, sem nova prova de implantação em 29/10.

## Refs e candidata de desenvolvimento

O coordenador consultou `ls-remote` e fez fetch explícito de todas as heads para
reconciliar as refs locais. Um fetch que acompanha apenas a branch configurada
não basta para escolher a baseline. Os objetos abaixo foram inspecionados após
essa atualização:

| Ref/revisão lab2 | SHA | Interpretação |
| --- | --- | --- |
| HEAD remoto/default | `128243d925617c08896a2a9448b2bb9f6e5da115` | Default antigo; não representa a última candidata Grupo JRC |
| `main` | `5f619b7cb3f922ead95613200afe5cb476694952` | Ancestral da candidata de atendimento; isoladamente não contém o preparador de campanhas mais recente |
| `codex/jrc-campaign-direct-audience-20261022` | `764de08317e0f7e19758f93a612ee99eb5a46ed6` | Campanhas, ancestral da candidata |
| `codex/servicedesk-read-performance-20261027` | `7e35d37ed8a1019664396515154803957fd0a968` | Performance, ancestral da candidata |
| `codex/atendimento-ferramentas-redimensionamento-20261027` | `a183ca9c0fb87cbb818c704597776f5b30ef7089` | Ferramentas nativas, ancestral da candidata |
| `codex/atendimento-visao-geral-canais-20261027` | `1da5bbfb0d438f26c86082db364c32ef3049b2d3` | Revisão anterior de atendimento, ancestral da candidata |
| `codex/atendimento-atribuir-completo-20261027` | `e4a6a007193988af3f314a902ec68531fd25a14a` | Candidata fundamentada para o próximo trabalho de integração Grupo JRC |
| `codex/servicedesk-overview-performance-20261026` | `2d07bc0f46ec786cbae9aad52da543c801eaf538` | SHA original não ancestral; quatro patches equivalentes já incorporados na candidata |
| `codex/precimech-contatos-hotfix-20261028` | `ca6b293e6902cb34ad2ae7f79d0a66f49501ca99` | Hotfix isolado de cliente/runtime; não selecionar como baseline Grupo JRC pela data |
| `codex/precimech-publish-ghcr-20261028` | `c12f4b8de21d5788cfe7fbb9eb68d214662e3b37` | Publicação isolada Precimech; mesmo limite de escopo |

`git merge-base --is-ancestor <ref> e4a6a007` retornou 0 para main, campanhas,
performance, ferramentas nativas e `1da5bbfb`; retornou 1 para `2d07bc0f`.
Ausência de ancestralidade do SHA original não significa ausência da mudança:
`git cherry e4a6a007 origin/codex/servicedesk-overview-performance-20261026
f6f999f37b86aea036e3efff08137f7b0cc44d88` marcou os quatro commits com `-`,
confirmando patches equivalentes já presentes. Não reaplicar essas quatro frentes.

| Original de Cláudio | Equivalente ancestral de `e4a6a007` | Fonte atual conferida |
| --- | --- | --- |
| `aaf70f416993d05a6cad522ca7879f9a43651a45` | `e5716f376b1c98bea8fb0f79db551813949d71b3` | `app/javascript/dashboard/routes/dashboard/serviceDesk/composables/useServiceDesk.js`: coalescência por `pendingRefresh` |
| `24064ed7fcf15d4c5c68e4b41d29572abd8e48f2` | `508ca3d47188845bba16a3633a4f709f2c9195e2` | `app/javascript/dashboard/helper/listReturn.js`: retorno limitado à mesma Account/lista |
| `4ac43ca85cfb59170b8e81a25f59012958ec47df` | `c72e586177178e56fb2e9a9f5c9524a89c3da72b` | `app/services/jrc_projects/comment_content.rb` e migration `20261026160000_add_rich_task_comments.rb` |
| `2d07bc0f46ec786cbae9aad52da543c801eaf538` | `d917c5c49b35e3e8e89898312ae5b071ce7ac72b` | `app/services/jrc_crm/commercial_financials.rb`: versão 3 separa mensalidade fixa; migration `20261026161000_add_proposal_financial_version.rb` |

A conferência não equivale a homologação funcional dessas quatro frentes nesta
data, nem a uma auditoria de todas as branches. Preservar as melhorias posteriores
da candidata em vez de restaurar os arquivos dos commits originais.

O worktree consultado
`New project/.worktrees/jrc-campaign-direct-audience-20261022` permanece em
`7e35d37e`. Seus snapshots locais `DateSeparator.spec.js.snap` e
`Spinner.spec.js.snap`, além de `.sessions/`, foram preservados. Iniciar a futura
implementação em isolamento a partir da candidata escolhida; não resetar esse
worktree para mudar a baseline.

## Contratos existentes que devem ser preservados

As fontes abaixo são idênticas entre `1da5bbfb` e `e4a6a007`, por comparação Git:
preparador e sender de campanhas, webhook delivery/trigger, serviço geral de
status e seu spec, e cliente nativo de Flow.

| Responsabilidade existente em `e4a6a007` | Âncora |
| --- | --- |
| Mensagem outgoing pública e correlação delivery/message/callback UUID na mesma transação | `app/services/jrc_campaigns/broker_message_sender.rb:6` |
| Reserva idempotente, validação de destino/revisões e persistência de `jrc_campaign_intent_id` | `app/services/jrc_campaigns/broker_intent_reservation.rb:6`, `:61`, `:117` |
| Revalidação de aprovação, campanha, destinatário, binding e adiamento antes do callback | `app/services/jrc_campaigns/broker_intent_reservation.rb:25` |
| Preparação antes de serializar/assinar/enviar o callback normal | `lib/webhooks/trigger.rb:72` |
| Estado de transporte e recibo de campanha com protocolo `chatwoot-campaigns/v1` | `app/services/jrc_campaigns/broker_connector.rb:2` |
| BFF de QR/controle com credencial server-side e bindings | `app/services/jrc_broker/`, `app/controllers/api/v1/accounts/jrc_broker_controller.rb` |
| Registro, sessões, editor, mídia e installation grants nativos separados do QR | `app/controllers/api/v1/accounts/jrc_flow_delegation_controller.rb`, `app/services/jrc_flows/native_client.rb:16` |

`Message#after_create_commit` continua existente (`app/models/message.rb:140`).
Isso não demonstra por si só a corrida histórica: o caminho de webhook de campanha
prepara e persiste o intent antes do envio do callback. Reutilizar também recovery,
callback UUID, deferral, fencing e UNKNOWN existentes; não substituir a campanha
por nota privada nem criar segundo emissor físico.

Dependências Broker do adapter de campanhas, sob
`/v1/integrations/chatwoot/control`:

- GET `/connections/:id/campaign-transport`;
- POST `/connections/:id/campaign-intents`;
- GET `/connections/:id/conversations/:display_id/campaign-messages/:message_id`;
- callback HTTPS explícito `/v1/integrations/chatwoot/:integrationId/events`,
  HMAC de timestamp/corpo e `X-Chatwoot-Delivery`;
- revisões destination/identity/owner, configuração/grants, filas e mídia privada.

O cliente nativo de Flow usa `/v1/flow-delegations`, configuração e autoridade
próprias. Não derivar autorização universal do editor a partir da chave QR/texto.
O par Broker `16a2a371e44de65a901cf1a9405bf4939ee1f213` + JRC `e4a6a007` é
candidato de teste, não par homologado por esta descoberta.

## Lacuna confirmada e próximo teste de status

Em `e4a6a007:app/services/messages/status_update_service.rb`, o guard geral ainda
impede somente `read → delivered`. O serviço chama
`JrcCampaigns::BrokerStatusJob.enqueue_for(message)` após atualizar. A proteção
específica do webhook contra falha tardia não garante todos os callers.

O mesmo guard limitado foi encontrado em main, `1da5bbfb`, candidata consolidada
`8637518b` e nas branches isoladas Precimech consultadas. Isso é evidência estática
do código, sem execução da suite Rails. O spec geral atual cobre status inválido,
atualizações comuns e read→delivered; não prova monotonicidade geral ou concorrência.

Próxima entrega pequena, na candidata lab2 e em banco isolado:

| Caso | Aceite do teste |
| --- | --- |
| `read → sent/delivered/failed` e `delivered → sent/failed` por evento tardio | Estado mais recente preservado; sem apagar erro/recibo por regressão |
| `sent → delivered → read` | Avanço legítimo mantido |
| `failed → sent` em retry legítimo | Permitido, com limpeza apropriada do erro |
| Dois callers com instâncias stale do mesmo registro | Revalidação serializada impede downgrade após confirmação concorrente |
| Atualização aceita e rejeitada no caminho de campanhas | Reconciliação enfileirada apenas conforme o efeito real; nenhuma nova mensagem física |

Usar `spec/services/messages/status_update_service_spec.rb` como entrada, preservar
o contrato de retorno do serviço e revisar callers/overlay Enterprise. Executar os
specs afetados de campanhas/receipts após a correção. Não declarar esse reparo
implementado a partir desta análise.

## Testes existentes e homologação pendente

Âncoras presentes na candidata, ainda sem reexecução neste documento:

- `spec/services/jrc_campaigns/broker_integration_spec.rb:83`: reserva antes do único
  callback; `:301`: correlação atômica; `:405–448`: revogação e falhas de reserva.
- `spec/services/jrc_campaigns/broker_recovery_spec.rb:205–260`: UUID, falha após
  commit e interrupção entre reserva e persistência; `:413–471`: fencing e mudança
  de estado durante HTTP.
- `spec/services/messages/status_update_service_spec.rb`: base para o novo RED.

Preparar laboratório explícito com Postgres/Rails e Sidekiq/Redis, fixar SHAs e
registrar restart real: a execução sintética com ActiveJob adiantado não comprova
recuperação dos consumidores após reinício. Verificar isolamento de duas contas,
bindings, callback HMAC, mídia, QR/Flow e mensagem/recibo com provider autorizado
em etapas próprias. A origem JRC já está definida; versão/customizações CCLX,
ambiente instalado e ativos externos continuam dependências distintas.
