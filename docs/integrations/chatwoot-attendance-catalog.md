# Catálogo de atendimento do Broker

O Broker consulta os recursos da central vinculada para preencher os seletores de configuração dos bots. A consulta não cria robôs, não altera filas e não transfere uma conversa.

`GET /v1/integrations/chatwoot/connections/:id/attendance-catalog` exige sessão vigente com papel OWNER ou ADMIN. O servidor resolve empresa, conexão, destino aprovado, Account e Inbox a partir dos vínculos persistidos. IDs remotos informados em query string não são aceitos. A resposta usa `Cache-Control: no-store` e contém observação temporal, revisão do destino e da credencial.

O catálogo retorna times, nomes dos agentes e participação na caixa, etiquetas, definições de atributos, horário/fuso, robô observado e configurações de saudação/atribuição automática. E-mail, token e segredo do webhook não são retornados. Um agente da Account pode aparecer com `inboxMember=false`; isso não autoriza atribuir a conversa a ele. A transferência deve revalidar time, agente e participação antes da ação.

A leitura confirma acesso administrativo à Account. Ao terminar as chamadas remotas, confere novamente vínculo, revisão e credencial; uma mudança durante a leitura invalida o resultado. Não há transação distribuída com Chatwoot: o catálogo não constitui autorização duradoura para um envio ou transferência posterior.

Recursos opcionais ausentes (HTTP 404/405/501) são marcados `UNSUPPORTED`. Autenticação revogada, timeout ou resposta inválida falham sem retornar um catálogo parcial. `remoteBot=null` só significa ausência observada quando `capabilities.agentBot=SUPPORTED`; com `UNSUPPORTED` não foi possível verificar. O campo `agent_bot` precisa estar explicitamente presente na resposta remota.

Horários são considerados utilizáveis somente com fuso reconhecido e, quando habilitados, uma semana completa de dias únicos com intervalos válidos. Dados incompletos ficam `UNVERIFIED`. A leitura de metadados não prova suporte a início em `pending` ou eventos de controle humano: `initialPending` e `controlEvents` permanecem `UNVERIFIED` até as provas correspondentes de runtime/homologação. Assinatura usa a evidência já vinculada à revisão exata da credencial/destino.

As formas das respostas foram verificadas em 30/09/2026 no código oficial do Chatwoot. A branch develop consultada não comprova compatibilidade com todas as versões ou forks instalados. A homologação por instalação continua necessária:

- [Times](https://github.com/chatwoot/chatwoot/blob/develop/app/views/api/v1/accounts/teams/index.json.jbuilder) e [campos de time](https://github.com/chatwoot/chatwoot/blob/develop/app/views/api/v1/models/_team.json.jbuilder).
- [Etiquetas](https://github.com/chatwoot/chatwoot/blob/develop/app/views/api/v1/accounts/labels/index.json.jbuilder).
- [Definições de atributos](https://github.com/chatwoot/chatwoot/blob/develop/app/views/api/v1/models/_custom_attribute_definition.json.jbuilder).
- [Configuração de Inbox](https://github.com/chatwoot/chatwoot/blob/develop/app/views/api/v1/models/_inbox.json.jbuilder) e [horários](https://github.com/chatwoot/chatwoot/blob/develop/app/models/working_hour.rb).
- [Membros de time](https://github.com/chatwoot/chatwoot/blob/develop/app/controllers/api/v1/accounts/team_members_controller.rb).

Esta entrega é a base R3a. Eventos de controle, início remoto em pending, transferência humana persistente e consumidores do catálogo têm tarefas próprias no programa Broker primeiro. Não declarar R3 ou BROKER_READY concluídos somente por esta consulta.
