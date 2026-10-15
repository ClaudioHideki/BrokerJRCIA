# Tomada de conversa NICO e Broker — contrato do candidato

Decisão do usuário: apresentar destinatário e conteúdo; pedir confirmação para assumir e pausar o bot; enviar uma vez; continuar humano. A confirmação não altera o executor de toda a caixa.

## Fronteiras

- JRC autentica o operador, Account, acesso à conversa e às ferramentas. A credencial por Account permanece no backend e não chega ao navegador/modelo.
- Broker autentica a credencial de serviço vinculada à organização, Account, origem, revisão do destino e integração. `X-JRC-External-Actor` é atribuição de auditoria, não prova independente de permissão do usuário.
- Usar o canal já responsável pelo transporte. Não abrir outra sessão WhatsApp nem chamar o provedor diretamente do NICO.
- Uma conversa ainda executada por Flow Rails ou delegação NICO não pode ser assumida através de um recibo que confirma apenas a pausa Broker. Interromper e confirmar o executor correspondente primeiro.
- Nenhuma chamada HTTP dentro de Account/session/command/conversation transaction. Persistir a intenção e despachar fora dos locks.

## Contrato por integração

Base: `/v1/integrations/chatwoot/control/connections/:integrationId/conversations/:remoteConversationId`.

1. `GET /attendance`: snapshot de organização implícita, integração, Account/caixa, IDs locais/remotos, ownerRevision, attendanceRevision e controlRevision. Resposta sem segredo/texto de cliente. Somente conversa mapeada na integração atual.
2. `POST /takeovers`: chave UUID de idempotência e revisões esperadas do snapshot. Dentro da mesma transação: revalidar credencial/mapeamento, travar canal antes das execuções, impedir retomada concorrente, aplicar a interrupção existente, persistir operação/fence por conversa e recibo. Um replay do mesmo pedido conserva a operação; conflito de conteúdo/ator é rejeitado.
3. `GET /takeovers/:id`: revalidar autoridade e vínculos; informar `DRAINING`, `PAUSED`, `STALE` ou `COMPLETED`. `PAUSED` exige modo humano, revisions esperadas e ausência de efeitos automáticos em voo/incertos. Não inferir recall de mensagem já entregue ao transporte.
4. `POST /takeovers/:id/complete`: receber o ID de mensagem criado uma vez no JRC, confirmar por leitura autenticada ao host que é mensagem pública do operador/conversa esperados e pertence a esta operação, e encerrar o fence preservando HUMAN. O recibo imutável contém takeover_id, request_id e fingerprint do conteúdo/destino aprovado; uma Message não pode concluir duas operações, nem uma mensagem histórica servir de recibo. Leitura externa fora da transação; revalidação e conclusão em nova transação.

A operação aberta é um fence da conversa contra retomada. Mudança de revisão/credencial/Account, saída incerta ou timeout não expira silenciosamente a proteção nem autoriza novo envio. Reconciliação consulta a mesma operação/mensagem. Não repetir POST de envio por tempo decorrido.

## JRC e NICO

- `send_message` público em caixa Broker prepara um snapshot do destinatário e do Broker. A prévia diz que a confirmação assume esta conversa e pausa o bot. Pedido de análise permanece privado no Quick.
- Confirmar grava uma operação local ligada ao Command, Account, user, Inbox, Conversation, conteúdo e snapshot. O job só é enfileirado depois do commit. Confirmar duas vezes não cria operação/mensagem adicional.
- O worker reconstrói e revalida acesso atual, configuração e destinatário. Solicita a pausa com o request_id estável e consulta até o recibo `PAUSED`. Não usa estado de UI como autorização.
- Depois da pausa, revalidar acesso e destino sob os locks locais; encerrar delegação local e atribuir atendimento humano pelos serviços existentes; criar Message e recibo único na mesma transação. A entrega continua pelo canal/evento normal da central.
- Reinício consulta o recibo Message da operação; nunca cria outra Message quando o fato já existe. Falha de permissão depois da pausa não envia e conserva humano.
- Finalizar informa ao Broker a mensagem já criada e mostra estados distintos: registrada, enviada, entregue, falhou ou resultado incerto. Não declarar entrega no instante do enqueue.
- Eventos de mudança humana causados pela própria tomada podem alterar revisions. A conclusão verifica o fato da mensagem e a conversa humana atual, sem reativar a execução cancelada.

## Testes de aceitação do contrato

Prévia sem mutação; confirmação duplicada; reinício em cada fronteira; HTTP fora de transação; revogação/Inbox/Account iguais em empresas distintas; destinatário alterado; revisão da confirmação obsoleta; efeito automático em voo/UNKNOWN; mudança humana concorrente; permissão revogada após pausa; uma mensagem e um recibo mesmo com ACK perdido; recibo histórico/outra operação recusado; outra conversa conserva bot; fim preserva HUMAN e retomada continua explícita.

Este documento define o incremento a implementar. Não é evidência de endpoint, imagem ou jornada já existente.
