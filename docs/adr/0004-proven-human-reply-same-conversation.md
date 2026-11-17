# ADR 0004: Resposta humana comprovada na mesma conversa de um espelhamento incerto

- Status: Aceita para o reparo autorizado em 17/11/2026.
- Contexto: uma intenção humana durável, autenticada e ainda nunca enviada fica bloqueada por um MIRROR_MESSAGE/SEND_MESSAGE anterior da mesma conversa. O efeito incerto é a cópia de uma entrada do WhatsApp para o JRC, não o envio da resposta ao WhatsApp.
- Decisão: permitir apenas a nova intenção HUMAN_PUBLIC, após releitura canônica exata, quando o bloqueio tem mensagem INCOMING/CONTACT, mapa e tentativa UNKNOWN no mesmo tenant, canal, integração, destino, conta, caixa, conversa física/remota e ciclo, com controle humano atual. Não liberar outros ciclos, mensagens de saída, bot/legado, contexto ausente ou operação diferente. Todos os UNKNOWN da integração precisam satisfazer a regra existente de independência ou essa prova restrita.
- A tentativa anterior continua UNKNOWN, sem replay, alteração de resultado ou descarte de dados. A nova resposta usa o job/intent/idempotency_key já existentes; callbacks e workers concorrentes não criam outra saída.
- O recibo físico dessa resposta pode retornar pelo PATCH idempotente ao ID central já mapeado, exigindo o job humano durável SUCCEEDED, mapa de conversa/mensagem exato, destino atual e confirmação do provedor (ou falha explícita). Não admite outro POST de mensagem nem replay da cópia incerta.
- Revalidar a admissão após o GET canônico, na transação protegida pelo lock do canal e pelas revisões atuais. Mudanças de contexto ou prova abortam o enqueue.
- Esta decisão amplia somente o caso antes conservador de mesmo contato da fase 16/11; não revoga os bloqueios de espelhamento, campanhas ou transporte físico incerto.
- Aceite: RED/GREEN com PostgreSQL real; suíte geral; matriz de escopo, controles, conteúdo e concorrência; imagem/CI e validação física. Publicação autorizada pelo pedido explícito atual. Nenhum backup/dump/restore faz parte do reparo.
