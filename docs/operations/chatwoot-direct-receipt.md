# Conciliação de uma resposta humana entregue pela Evolution direta

Comando local de administração para um trabalho `CHATWOOT_REPLY` cujo original de texto individual já saiu por uma integração Evolution–Chatwoot. A conclusão altera somente o trabalho Broker. O recibo de estado para o Rails fica disponível depois do commit. A ferramenta não cria mensagem ou canônico e não acessa HTTP, WhatsApp ou o outbox.

## Proteção durante o levantamento

Em todos os workers que podem reivindicar a fila, a configuração `CHATWOOT_DIRECT_TRANSPORT_REVIEW_INTEGRATIONS` aceita UUIDs de integração separados por vírgulas. Cada caixa listada mantém trabalhos de resposta humana, legada, automática e de grupo em espera; o filtro permite a continuação dos espelhos elegíveis. Antes de qualquer aplicação, verificar o SHA/digest e a configuração efetiva de **todos** os consumidores, o encerramento de processos da revisão anterior e a ausência de reserva em andamento. A CLI confere a sua própria configuração. O estado dos demais processos e a exclusividade do transporte precisam de verificação operacional.

Na união das duas listas de integrações, o webhook com `source_id` começando por `WAID:` preserva a observação sem enfileirar nova resposta. Nessa mesma união, o trabalho com intenção nativa compara a origem do original persistido antes da saída. A configuração `CHATWOOT_DIRECT_SOURCE_GUARD_INTEGRATIONS` exige consulta canônica também para pendências legadas e de grupo na integração listada. Origem presente ou campo omitido interrompe o envio. API e todos os workers devem receber as mesmas listas de UUIDs. A API protege o ingresso e o worker protege a reserva, a leitura canônica e a saída. Com ambas vazias, o WAID preserva o comportamento da base para os tenants fora da operação. Um `source_id` explicitamente nulo só permite prosseguir nas verificações normais da caixa. Uma consulta ao Rails não serializa um emissor Evolution independente: manter a quarentena enquanto o transporte antigo puder enviar simultaneamente ou restarem trabalhos sem identificação. O mapa do destino e a revisão da credencial são revalidados e bloqueados na transação de saída.

## Fontes já autorizadas

* `DATABASE_URL` aponta para o Broker com papel direto `jrc_app`. O comando usa transação de organização e RLS.
* `CHATWOOT_DIRECT_RAILS_READ_URL` e `CHATWOOT_DIRECT_EVOLUTION_READ_URL` apontam para o JRC correto e o banco histórico efetivamente responsável pelo envio. Utilizar acesso existente de leitura. O verificador abre transações repetíveis `READ ONLY` e limita cada consulta a 12 segundos.
* `CHATWOOT_DIRECT_CUSTODY_FILE` aponta para um registro privado do vínculo histórico já confirmado. Seus campos são `organizationId, integrationId, channelId, origin, accountId, inboxId, instanceId, generation, brokerInstanceId, validFrom, validUntil`. Os dois últimos são instantes UTC ISO-8601 e definem intervalo semiaberto. `instanceId` identifica a linha Evolution antiga. `brokerInstanceId` vem da obrigação Rails. Nomes de caixa e de instância podem se repetir. `CHATWOOT_DIRECT_CUSTODY_SHA256` deve vir de uma fonte de custódia independente e confiável. Criar o arquivo e seu hash a partir das mesmas conjecturas não estabelece o vínculo.
* Um JSON privado por original segue o esquema estrito em [direct-receipt-contract.ts](../../apps/api/src/modules/integrations/direct-receipt-contract.ts). O exemplo sintético executado está em [chatwoot-direct-stores.test.ts](../../apps/api/tests/integration/chatwoot-direct-stores.test.ts). A estrutura contém as quatro identidades de escopo, as revisões, a tripla JRC, `delivery_id` e intenção Rails (ou null), origem WAID, hash SHA-256 UTF-8 do texto sem normalização, e IDs de linha, instância, chave, direção e peer para a mensagem e a atualização Evolution. O registro histórico e seu digest ficam separados do manifesto individual. A CLI consulta novamente as duas bases e recusa discrepâncias. Nenhuma nova chave ou autoridade de assinatura é necessária.

## Ensaio e aplicação por original

Os exemplos requerem caminhos privados e UUIDs reais de um original conferido. A revisão histórica ou um relatório agregado não autoriza aplicar o comando.

```text
node apps/api/dist/commands/reconcile-direct-reply.js --org <uuid-organizacao> --job <uuid-trabalho> --proof <arquivo-do-original>
node apps/api/dist/commands/reconcile-direct-reply.js --org <uuid-organizacao> --job <uuid-trabalho> --proof <arquivo-do-original> --apply <mesmo-uuid-trabalho> --receipt
```

A primeira execução exercita as mesmas verificações e reverte a transação. O comando com confirmação individual devolve `APPLIED` ou `UNCHANGED`. A opção `--receipt` inclui identificadores particulares e deve ser usada apenas num canal privado. O registro de entrega é `integration_jobs.payload.directEvolutionReceipt` em trabalho `SUCCEEDED`, sem `message_id` local. Aumentar de entregue para lido exige a mesma identidade e outra atualização Evolution exata. Uma evidência tardia de menor nível preserva o estado mais alto.

O serviço exige o mesmo destinatário individual no contato/caixa e conversa Rails e no mapa de telefone e conversa do Broker; uma única mensagem pública humana, texto integral idêntico no Rails, trabalho e Evolution; obrigação íntegra; atributos Rails JSON ou JSONB que decodifiquem como objetos, obrigação entregue com binding e URL atuais, original sem marca de exclusão, uma única linha de mensagem da instância e um `MessageUpdate` com FK, chave, peer e direção concordantes. Havendo observação local, exige `APPLIED`, mapa, autor, escopo e intenção correspondentes. Admite apenas `DELIVERY_ACK` e `READ`. Para `key.remoteJid=@lid`, registrar o LID em `evolution.remoteJid` e `ack.remoteJid`, mantendo `peer` como o telefone JID. A mesma linha de mensagem deve trazer `key.remoteJidAlt=peer` e a atualização deve trazer o LID original. Qualquer associação contraditória em uma das duas direções na mesma instância e intervalo de geração invalida a prova. O status isolado da Evolution, `SERVER_ACK`, ausência de chave, grupos, LID sem telefone exato, mídias, multipartes, `WAITING_MAP`, trabalho reservado, canônico conflitante ou tentativa QR incerta conservam o original para revisão. Em caso de timeout, o comando pode ser repetido pelo mesmo UUID após conferir o resultado anterior.

O Broker serializa com a rotação de destino, bloqueia canal e conexão e relê os trabalhos do original sob lock. Uma reivindicação que venceu a corrida impede o encerramento administrativo. Após confirmação, o mesmo dedupe key continua ocupado, e um novo trabalho em revisão posterior da mesma origem/conta/caixa é rejeitado antes da saída. Em caso de mudança de titularidade da integração, a aceitação de novos trabalhos requer revalidar a relação histórica. O encerramento no Broker precede qualquer atualização visual no Rails.

## Recibo consumido pelo Rails

A resposta com `--receipt` inclui `result` e `receipt`. Dentro de `receipt` estão os seguintes campos:

```text
protocol = DIRECT_EVOLUTION_RECEIPT_V1
organizationId, integrationId, channelId, jobId, origin
accountId, inboxId, conversationId, messageId, destinationRevision, credentialRevision
obligationId = delivery_id da obrigação; intentId = UUID nativa ou null
instanceId, generation, peer, sourceId, providerMessageId, state, evidenceSha256
```

O consumidor autenticado deve conferir o registro comprometido no Broker, identificar e bloquear a mesma obrigação e o mesmo original no Rails, preservar a distinção entre transporte direto e canônico Broker e atualizar apenas a projeção de estado. `evidenceSha256` é o hash dos bytes exatos do manifesto privado revalidado nas bases. Não substitui a verificação no provedor. O comando Broker não contém a projeção Rails.
