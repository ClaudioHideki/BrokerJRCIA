# Transferência cooperativa para times

Parte P0 do programa aprovado de integração JRC/NICO/Broker. Desenvolvimento e testes somente locais; não publicar branch/imagem nem ativar bots até concluir o programa consolidado.

## Problema e comportamento

O handoff atual impede publicação/execução para times cujo `allow_auto_assign` é verdadeiro e só confirma time sem agente. Times reais do JRC distribuem automaticamente, portanto essa exigência impede a operação normal.

Manter a seleção de um único destino no editor. Aceitar time com política explicitamente conhecida, false ou true; política ausente continua erro de configuração. Não alterar saudação/autoatribuição da caixa nem concorrência de AgentBot neste incremento.

Após o POST de atribuição, consultar a conversa canônica. Para time: exigir o mesmo time e estado aberto; se houver agente, exigir tipo humano consistente e validar novamente seu vínculo com o time e com a caixa usando o serviço autorizado da central. Revalidar a revisão da credencial e a autoridade local antes de confirmar. Um agente não verificado não conta como transferência concluída.

Os callbacks de controle resultantes podem conter time sem agente ou time com humano. Esses callbacks podem justificar avanços de revisão para liquidação; mensagens humanas, estados/times diferentes e revisões manuais sem observação correspondente continuam invalidando a operação. Não emitir nova mutação durante reconciliação. Preservar o contrato existente: quando um humano já concluiu exatamente o destino solicitado, a reconciliação pode reconhecer o resultado por leitura canônica, identificada como CANONICAL_RECONCILIATION, sem alegar autoria do POST. Apenas observar a abertura, sem o destino final, continua UNKNOWN.

O protocolo não prova autoria de alterações no Chatwoot externo, que não oferece CAS/correlação na atribuição. Ele confirma o resultado observado sem sobrescrever atendimento humano. Após atribuição não há mais escrita remota; modo humano é preservado.

## Arquivos e validação

Alterar readiness, serviço de handoff e liquidação do repositório. Não há mudança de schema, contrato público de nó, configuração ou servidor. Testes sintéticos cobrem: publicação com time automático, confirmação com membro válido, recusa de agente fora do time/caixa, credencial alterada, tipo não humano, callback real no PostgreSQL, timeout com reconciliação GET, fase anterior à atribuição e intervenção humana.
