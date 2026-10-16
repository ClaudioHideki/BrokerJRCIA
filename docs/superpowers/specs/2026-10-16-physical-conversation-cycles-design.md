# Ciclos de conversa central no transporte físico

Objetivo P0 autorizado: receber uma nova conversa Chatwoot do mesmo contato/caixa sem sobrescrever o destino das mensagens e operações do ciclo anterior. Nenhum bot ou conexão será ativado em produção. Somente código e testes locais.

## Modelo e invariantes

Reutilizar `messaging_conversations.remote_conversation_key` e os índices parciais existentes. A conversa física corrente tem chave nula. Ao receber resposta humana autenticada de outra conversa central para o mesmo contato e source_id verificados, retirar a conversa anterior da rota corrente usando a chave reservada `chatwoot-cycle:INTEGRATION_ID:REMOTE_ID`. Criar outra conversa física corrente com chave nula e mode HUMAN; mapear o novo ID central nessa nova conversa. As duas linhas de chatwoot_conversations permanecem imutáveis. Mensagens, jobs de espelhamento, recibos e operações antigas continuam referenciando seus IDs anteriores.

Não reaproveitar essa promoção em CENTRAL_TRANSPORT ou grupos. O transporte central já identifica suas conversas pela chave remota; grupos seguem sua identidade e política próprias. Não promover se contact_id/source_id da central divergirem do vínculo anterior; isso é revisão de identidade, não fusão automática por telefone.

## Coordenação

O caller obtém e valida conversa/contato/caixa na central antes da transação. Dentro da transação, trava o canal e revalida escopo/credencial/lease atuais. Uma nova resposta humana pausa/cancela o bot anterior pelos serviços existentes. Se houver envio físico antigo ACCEPTED/SENDING/UNKNOWN ou retomada/handoff remoto incerto, manter a nova resposta durável PENDING, sem consumir retries de transporte e com próxima conferência em trinta segundos. A pausa deve ser efetivamente commitada mesmo nesse caso. Nunca repetir POST remoto de resultado desconhecido.

Depois de drenar essas operações, promover o novo ciclo atomicamente e encaminhar a resposta humana uma vez. A promoção não retoma bot. Retomada exige ação explícita na conversa corrente; conversa retirada não pode retomar nem executar Flow ou tomada NICO nova. O contexto visual deve explicar a substituição quando aplicável.

Resposta humana posterior em um ciclo antigo não troca a rota corrente de volta. Mantém o destino antigo de seus recibos e pausa o atendimento automático corrente do mesmo contato. Envios humanos pendentes de ciclos antigos impedem retomada/execução automática corrente até sua definição. Eventos de sistema/eco antigos não recebem essa autoridade.

Não prometer ordenação temporal absoluta entre callbacks remotos atrasados. A prioridade de uma ação humana autenticada é conservadora; pode exigir nova retomada explícita. Importação histórica continua sendo um programa separado, sem ativação por mensagens históricas.

## Migração e prova

Sem nova tabela de roteamento: os índices parciais já garantem uma conversa corrente por contato/canal. Considerar índice adicional por organização/canal/contato para consultas entre ciclos; se necessário, migração aditiva com probe e upgrade próprios. Não alterar dados históricos nem privilégios existentes.

Testes: primeiro vínculo inalterado, novo ciclo, preservação dos dois mapas/IDs antigos, recebimento físico seguinte no ciclo novo, deduplicação, bloqueio durável por resultado desconhecido, retomada e runtime de ciclo retirado negados, resposta humana antiga sem troca de rota, isolamento entre empresas, CENTRAL_TRANSPORT/grupos preservados. Regressões de QR/Chatwoot, controle, retomada, takeovers, runtime/schema e migrations. Revisão final antes de qualquer publicação.
