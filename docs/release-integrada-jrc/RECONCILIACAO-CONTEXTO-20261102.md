# Reconciliação e mudança concorrente de inbox

## Defeito de backend comprovado

O fluxo `reconcileJob` capturava conta, destino e inbox, consultava a central por GET e liberava o job UNKNOWN sem conferir novamente esse contexto. No PostgreSQL isolado, sete alterações confirmadas durante a consulta — credencial, revisão do destino, revogação, conta, inbox, suspensão de conta e pausa da conexão — ainda retornavam sucesso. RED: 7 falhas e 2 passes, 29,30s, exit1 (`output/chatwoot-reconciliation-context-red.log`). Não é evidência de que um job produtivo específico sofreu essa corrida.

A correção mantém a consulta HTTP fora da transação. Antes da liberação, adquire o lock de destino e locks de leitura das linhas de destino, conta e conexão; compara as identidades e o estado observado. Mudança retorna `CHATWOOT_CONTEXT_CHANGED`/409, preservando UNKNOWN, payload, timestamps e ausência de auditoria de sucesso. O UPDATE também compara integração, mensagem, tipo e payload capturados, impedindo sobrescrever uma reconciliação concorrente. Não há novo POST remoto, replay automático ou endpoint.

O teste acrescentado de payload concorrente exige manter a alteração mais recente e retornar `JOB_REQUIRES_RECONCILIATION`. Revisão independente do caminho de locks não identificou ciclo nesse fluxo. GREEN PostgreSQL: **10/10, zero falhas, 17,58s, exit0** (`output/chatwoot-reconciliation-context-green.log`), incluindo as sete mudanças, contexto estável, isolamento entre tenants e alteração concorrente do payload. O contexto estável produz uma auditoria e nenhum POST; uma segunda reconciliação é recusada.

## Defeito de interface comprovado

A lista de atendentes usava apenas o ID da conexão como identidade React. Após remapear essa conexão para outra inbox, permaneciam escolhas carregadas ou recebidas atrasadas da inbox anterior. RED: 2/2 cenários falharam por manter o checkbox antigo (`output/integral-inbox-agent-context-red.log`).

A identidade do componente agora inclui conexão, inbox, conta, revisão do destino e URL. A troca desmonta o contexto anterior, descarta escolhas e ignora seu resultado atrasado; consultar novamente é uma ação GET normal. Autorização de backend e papéis permanecem intactos. GREEN: 29/29 em três arquivos de painel/diagnóstico, 16,72s, exit0 (`output/integral-inbox-agent-context-green.log`). Nenhuma atribuição ou chamada produtiva foi executada.

## Compatibilidade e limites

Sem migration nova. O erro 409 de contexto já existe no contrato e tem mensagem de interface. O registro de configuração precisa permanecer estável apenas até a transação de reconciliação concluir; uma configuração modificada posteriormente continua sujeita às verificações normais do worker. A consulta limitada de uma página não prova ausência de mensagem remota. Resultados UNKNOWN sem evidência suficiente continuam sem autorização de reenvio.

Esses testes não substituem regressão integral, CI do novo SHA, homologação da instalação externa ou sessões WhatsApp reais. Nenhuma alteração deste incremento foi aplicada à produção.
