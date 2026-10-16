# Handoff cooperativo — validação local

O Broker agora aceita um time cuja política de distribuição esteja explicitamente conhecida como true ou false. Estado desconhecido continua exigindo verificação. O nó continua selecionando um único destino; nenhum time, caixa ou bot foi configurado ou ativado no servidor.

O resultado canônico pode conter o time selecionado e um agente humano. Antes de confirmar, o serviço verifica novamente que esse agente pertence ao time e à caixa, sob a mesma revisão de credencial. Callbacks de controle compatíveis contabilizam a ativação humana da sessão; outras mensagens, revisão manual sem observação correspondente e destinos incompatíveis continuam interrompendo a operação. O bot permanece pausado.

## Evidência

- RED unitário inicial: 7 falhas/26 preservados. Uma falha refletia suposição nova incompatível com o contrato existente de conclusão manual e foi retirada com decisão registrada no plano.
- RED PostgreSQL inicial: os 3 novos casos falharam pelo bloqueio da política de time.
- RED após liberar a política no serviço: os callbacks humanos chegaram ao ledger e falharam em HANDOFF_HUMAN_CONTROL_CHANGED, confirmando a necessidade de contabilizar a revisão de sessão. Dois casos legados detectaram a restrição indevida da conclusão manual; comportamento preservado.
- GREEN PostgreSQL: **32 testes**, incluindo os novos casos de atribuição automática, agente fora do time e timeout com reconciliação GET, além de intervenção humana, concorrência e isolamento anteriores.
- `tsc -b --pretty false`: aprovado.
- `npm test -- --reporter=dot`: **408 arquivos / 3123 testes aprovados**, em 313,77 s.
- Nenhuma alteração em contrato público do nó, migrations, Compose ou ENV.

Limite: o Chatwoot externo não oferece compare-and-set para atribuição. Leitura canônica confirma o resultado, não autoria exclusiva. Nenhuma mutação é repetida durante reconciliação; resultado exato já concluído manualmente pode ser reconhecido como CANONICAL_RECONCILIATION. Apenas abertura sem destino concluído continua incerta.

Este é um incremento local do programa. Não houve push, publicação de imagem, deploy ou ativação de automação. O fechamento completo e a homologação no novo servidor permanecem pendentes.
