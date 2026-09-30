# Evidências de integração do atendimento — Chatwoot

Consulta técnica em 2026-09-30. Esta nota orienta R1c/R3/R4/R5; não certifica entrega na instalação do cliente.

## Versão e limite da evidência

O print da instalação JRC mostra 4.16.2, build próprio 9c4f08b. O código público da tag Chatwoot v4.16.2 aponta ao commit 70e284a044f00326725f65f703162745371075ec. Isso permite comparar o contrato upstream; não prova que o fork JRC tem comportamento idêntico. Homologação com destino e credencial autorizados continua obrigatória.

Fontes abaixo estão fixadas nesse commit. A leitura anterior de develop foi suplementar; não usar seu comportamento como garantia da instalação 4.16.2.

## Atribuição, estado e concorrência

1. O controller de assignments escolhe a atribuição de agente quando assignee_id está presente; somente no ramo alternativo usa team_id. Uma chamada contendo ambos não configura os dois. Fazer etapas persistidas, reler estado e registrar resultado incerto.
2. AssignmentService dessa versão atribui o agente e remove assignee_agent_bot; não muda automaticamente pending para open. A versão develop consultada possui outra política, portanto o adaptador não pode inferir esse efeito entre versões.
3. Ao alterar time, AssignmentHandler pode retirar um agente que não pertence ao time e escolher outro quando allow_auto_assign está habilitado. Configurar time antes do agente específico e conferir ambos após a operação. Time sem agente pode resultar em atribuição automática: respeitar a política escolhida e não inventar uma posição de fila.
4. toggle_status para open, autenticado como User, remove o bot da conversa e pode atribuir o próprio usuário se ele for agente. O perfil da credencial influencia o resultado. A releitura deve detectar atribuição concorrente; não sobrescrever uma assunção humana observada.
5. AgentBot pode ser associado à caixa ou à conversa. Observar apenas o robô da caixa não basta para autorizar efeitos de uma sessão. R1c deve considerar ambos e nunca desconectar um robô alheio para recuperar a operação.
6. Nenhuma dessas leituras fornece uma transação distribuída com o Broker. Revalidar imediatamente antes do despacho reduz a janela de corrida, sem prometer cancelamento de uma requisição já enviada.

Fontes:
- [AssignmentsController](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/controllers/api/v1/accounts/conversations/assignments_controller.rb)
- [AssignmentService](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/services/conversations/assignment_service.rb)
- [AssignmentHandler](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/models/concerns/assignment_handler.rb)
- [ConversationsController](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/controllers/api/v1/accounts/conversations_controller.rb)
- [Conversation](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/models/conversation.rb)

## Criação e retorno de conversa

ConversationBuilder aceita status explícito na criação. Com lock_to_single_conversation, pode devolver a conversa anterior do contact_inbox; parâmetros de criação não comprovam alteração dessa conversa existente. O modelo também considera contato bloqueado, campanha e bot ativo.

Consequências:
- Só afirmar início pending após ler o resultado canônico, escopo e responsável.
- Manter a assunção humana de conversa existente; não apagar agente para iniciar o bot.
- Não identificar o ciclo apenas por contato ou número. Registrar o mapeamento por empresa, instalação, caixa e ciclo, e distinguir nova conversa de reabertura.
- Criar conversa e perder a resposta exige reconciliação do resultado antes de repetir.

Fonte: [ConversationBuilder](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/builders/conversation_builder.rb) e modelo Conversation acima.

## Eventos de transporte e controle

WebhookListener encaminha eventos de conversa e mensagem ao callback de caixas API. Webhooks de conta dependem de assinatura dos eventos. AgentBotListener tem entrega própria e pode alcançar tanto o robô da conversa quanto o da caixa. Isso reforça que transporte e executor são responsabilidades distintas; não instalar dois executores para a mesma caixa.

Message.webhook_data contém remetente, tipo, privacidade, escopo e mensagem. Os remetentes upstream User e AgentBot usam respectivamente user e agent_bot. A ausência de remetente deve permanecer inconclusiva para controle, não ser convertida em humano por conveniência.

Regras automáticas identificam-se por `content_attributes.automation_rule_id`; campanhas usam `additional_attributes.campaign_id`. O remetente User, sozinho, não comprova atividade humana. Essa diferença de campo foi conferida em Message#human_response? e tem fixture de regressão no classificador.

Regras para R3:
- Validar assinatura e escopo antes da classificação.
- Distinguir mensagem pública humana, bot externo, reflexo Broker, nota privada e atividade de sistema.
- Um marcador jrc_broker_message_id isolado não prova reflexo autorizado: conferir o vínculo persistido/canônico.
- Nota privada nunca vira mensagem de WhatsApp.
- Deduplicar transporte e controle por identidade própria; evento atrasado não retoma bot.
- Evento de atribuição é pista para reconciliação. Quando o destino não oferecer eventos necessários, informar a limitação e exigir observação canônica antes de efeitos.
- Não anunciar assunção imediata quando a instalação depende de consulta periódica.

Fontes:
- [WebhookListener](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/listeners/webhook_listener.rb)
- [AgentBotListener](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/listeners/agent_bot_listener.rb)
- [Message](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/models/message.rb)
- [User](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/models/user.rb)
- [AgentBot](https://github.com/chatwoot/chatwoot/blob/70e284a044f00326725f65f703162745371075ec/app/models/agent_bot.rb)

## Testes de contrato necessários

- Atribuição conjunta é recusada pelo adaptador ou decomposta em etapas verificáveis.
- Configurar agente em pending não é tratado como transferência concluída.
- Alterar time pode alterar agente; releitura detecta resultado diferente.
- Abrir usando credencial de agente não substitui silenciosamente destino solicitado.
- Bot apenas na conversa bloqueia despacho incompatível.
- Criar com pending e receber conversa antiga open/humana mantém controle humano.
- Timeout após atribuição não autoriza nova nota/aviso ou reenvio automático.
- Evento humano entre reserva e releitura invalida efeitos ainda não despachados.
- API inbox e AgentBot recebem eventos repetidos sem duplicar saída.
- Fixtures usam somente dados sintéticos, nunca payloads com credenciais reais.

