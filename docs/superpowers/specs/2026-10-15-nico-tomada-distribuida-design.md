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

1. `GET /attendance`: snapshot de organização implícita, integração, Account/caixa, IDs locais/remotos, remoteContactId, ownerRevision, attendanceRevision, controlRevision, destinationRevision e credentialRevision. Resposta sem segredo/texto de cliente. Somente conversa mapeada na integração atual.
2. `POST /takeovers`: chave UUID de idempotência e revisões esperadas do snapshot. Dentro da mesma transação: revalidar credencial/mapeamento, travar canal antes das execuções, impedir retomada concorrente, aplicar a interrupção existente, persistir operação/fence por conversa e recibo. Um replay do mesmo pedido conserva a operação; conflito de conteúdo/ator é rejeitado.
3. `GET /takeovers/:id`: revalidar autoridade e vínculos; informar `DRAINING`, `PAUSED`, `STALE`, `COMPLETED` ou `CANCELED`. `PAUSED` exige modo humano, revisions esperadas e ausência de efeitos automáticos em voo/incertos. Não inferir recall de mensagem já entregue ao transporte.
4. `POST /takeovers/:id/complete`: receber o ID de mensagem criado uma vez no JRC, confirmar por leitura autenticada ao host que é mensagem pública do operador/conversa esperados e pertence a esta operação, e encerrar o fence preservando HUMAN. O recibo imutável contém takeover_id, request_id e fingerprint do conteúdo/destino aprovado; uma Message não pode concluir duas operações, nem uma mensagem histórica servir de recibo. Leitura externa fora da transação; revalidação e conclusão em nova transação.
5. `POST /takeovers/cancel`: o BFF confirma irreversivelmente no próprio banco que nenhum worker poderá criar a Message e invalida seu lease. Envia requestId e fingerprint; o Broker registra CANCELED mesmo se a solicitação inicial ainda não chegou. O mesmo lock de idempotência serializa begin/cancel. A marca impede que um begin atrasado reabra a intenção. COMPLETED nunca é desfeito; o modo efetivo distingue ausência de pausa de pausa já aplicada.

A operação aberta é um fence da conversa contra retomada. Mudança de revisão/credencial/Account, saída incerta ou timeout não expira silenciosamente a proteção nem autoriza novo envio. Reconciliação consulta a mesma operação/mensagem. Não repetir POST de envio por tempo decorrido.

### Identidade e cancelamento durável

- As rotas aceitam somente API_KEY vinculada a `chatwoot:manage`. `X-JRC-External-Actor` é um ID decimal positivo canônico. O BFF valida usuário e Inbox antes da chamada; o header atribui auditoria.
- O snapshot inclui `remoteContactId` do mapeamento, `destinationRevision` e `credentialRevision`. O JRC compara contato/Inbox/Conversation atuais novamente antes da prévia, confirmação e criação da Message.
- O JRC escolhe `requestId=Command.request_id`; `Idempotency-Key` no begin deve ser o mesmo UUID. O corpo inclui fingerprint e as cinco revisões esperadas (`expectedOwnerRevision`, `expectedAttendanceRevision`, `expectedControlRevision`, `expectedDestinationRevision`, `expectedCredentialRevision`). Complete recebe `{messageId}` sem outro header idempotente.
- Fingerprint: SHA256 dos bytes UTF-8 de `jrc-nico-send-v1\n{organizationId}\n{accountId}\n{inboxId}\n{remoteConversationId}\n{externalActorId}\n{sha256(content)}`. Sem newline terminal, serialização JSON ou normalização do texto. A Message pública outgoing/User contém `content_attributes.jrc_nico_takeover={takeoverId,requestId,fingerprint}`.
- `POST /takeovers/cancel` recebe `{requestId,fingerprint}`. Antes de chamar, o JRC persiste CANCELING sob Command→op, invalida a lease e torna impossível criar a Message; a chamada é uma atestação da credencial de serviço. O Broker serializa cancel e begin pela mesma identidade, grava CANCELED mesmo sem begin anterior e devolve tombstone para um begin tardio. ACK perdido repete apenas cancel; COMPLETE não aceita tombstone. COMPLETED é preservado.
- Cancel antes de qualquer pausa conserva o modo existente. Cancel após a pausa conserva HUMAN. O recibo inclui modo real e contato mapeado no snapshot da operação; não autoriza enviar após cancel. Revogação da credencial ainda exige recuperação por serviço atualmente autorizado à mesma Account/integração/ator.
- Owner NONE ou conversa já HUMAN são permitidos; executor externo/remoto é recusado. Enquanto OPEN, alterações de owner/binding do canal também são bloqueadas para impedir iniciar outro executor entre PAUSED e a criação da Message. Outras conversas continuam executando normalmente.
- A identidade, fingerprint, pedido e snapshot são imutáveis. Estados terminais e message_id também são imutáveis; índice único impede que uma Message remota conclua duas operações da mesma origem/Account.

## JRC e NICO

- `send_message` público em caixa Broker prepara um snapshot do destinatário e do Broker. A prévia diz que a confirmação assume esta conversa e pausa o bot. Pedido de análise permanece privado no Quick.
- Confirmar grava uma operação local ligada ao Command, Account, user, Inbox, Conversation, conteúdo e snapshot. O job só é enfileirado depois do commit. Confirmar duas vezes não cria operação/mensagem adicional.
- O worker reconstrói e revalida acesso atual, configuração e destinatário. Solicita a pausa com o request_id estável e consulta até o recibo `PAUSED`. Não usa estado de UI como autorização.
- Depois da pausa, revalidar acesso e destino sob os locks locais; encerrar delegação local e atribuir atendimento humano pelos serviços existentes; criar Message e recibo único na mesma transação. A entrega continua pelo canal/evento normal da central.
- A autorização no commit precisa estabilizar as linhas efetivas de usuário, membership, papéis e grants, sem manter HTTP sob locks. A rota da prévia fixa também ContactInbox/source_id. Offline não é revogação; usuário sem autenticação ativa ou sem autorização não envia.
- O ledger pertence à Account e sobrevive à exclusão de Command/User. O ator original e o fato de criação da Message são preservados; sem usuário/comando antes desse fato, somente cancelamento/reconciliação são permitidos. Depois do fato, não existe autorização para recriar a Message, mesmo se o registro ou sender forem removidos.
- Reinício consulta o recibo Message da operação; nunca cria outra Message quando o fato já existe. Falha de permissão depois da pausa não envia e conserva humano.
- Cancelar antes da Message grava CANCELING local antes de qualquer HTTP; o worker somente reconcilia o cancelamento até CANCELED. Um callback tardio não pode reutilizar o lease anterior. Registro de Message ausente depois de uma criação comprovada exige reconciliação manual e não autoriza recriar ou declarar o envio desfeito.
- Finalizar informa ao Broker a mensagem já criada e mostra estados distintos: registrada, enviada, entregue, falhou ou resultado incerto. Não declarar entrega no instante do enqueue.
- Eventos de mudança humana causados pela própria tomada podem alterar revisions. A conclusão verifica o fato da mensagem e a conversa humana atual, sem reativar a execução cancelada.

## Testes de aceitação do contrato

Prévia sem mutação; confirmação duplicada; reinício em cada fronteira; HTTP fora de transação; revogação/Inbox/Account iguais em empresas distintas; destinatário alterado; revisão da confirmação obsoleta; efeito automático em voo/UNKNOWN; mudança humana concorrente; permissão revogada após pausa; uma mensagem e um recibo mesmo com ACK perdido; recibo histórico/outra operação recusado; outra conversa conserva bot; fim preserva HUMAN e retomada continua explícita.

Este documento define o contrato do candidato. Código, testes, CI, imagem publicada e jornada instalada são evidências distintas, registradas no relatório do incremento; a especificação por si só não comprova essas etapas.
