# Ciclos físicos Chatwoot — atualização candidata

Status: implementação e verificações locais; sem push, imagem, deploy ou ativação de bot. Não equivale ao fechamento do programa.

## Comportamento

Uma resposta humana autenticada numa nova conversa central do mesmo contato/source/caixa verificados cria outro ciclo físico HUMAN. Preserva a associação antiga, seus jobs, mensagens e recibos. Entradas físicas seguintes encontram somente a conversa atual de chave nula. Não funde contatos por semelhança de telefone nem promove grupos ou transporte central.

Envios anteriores ACCEPTED/SENDING/UNKNOWN e operações de controle incertas adiam a promoção; pausa e job durável PENDING são confirmados juntos. A drenagem não repete o envio anterior. Retomada, execução automática e nova tomada NICO num ciclo retirado são negadas.

Uma resposta humana histórica pausa imediatamente o ciclo corrente na admissão, antes do worker. Enquanto seu job ou envio estiver pendente, bloqueia retomada/automação corrente. Uma nota privada também pausa, sem envio ao WhatsApp. Atividades/eco e respostas automatizadas não ganham autoridade humana. O envio manual numa conversa substituída durante a operação é recusado após aquisição do lock.

## Evidência local

- RED inicial: três falhas reais após corrigir o envelope sintético do GET de contato; erro de associação e ausência de fences reproduzidos na base.
- GREEN inicial: seis testes; extensão de settlement reproduziu ACTION_REQUIRED externo ignorado e foi corrigida.
- Revisão: três achados Important, cada qual reproduzido com teste antes da correção.
- GREEN final dos ciclos: **18 testes PostgreSQL**, inclusive deduplicação, retomada/NICO negados, envio incerto e restart, pausa antes do worker, nota privada, resposta automatizada, concorrência, recibo antigo na rota 51, mudança de source/credencial e isolamento entre empresas com IDs remotos iguais.
- Regressões após correções da revisão: **87 testes em quatro arquivos** (13 ciclos naquele momento, observações, QR/storage e takeovers).
- Regressões de schema/migrations/retomada anteriores: rodada de sete arquivos, **111 testes aprovados**.
- Interface: **41 testes em dois arquivos**, incluindo orientações de conversa substituída/entrega pendente sem anunciar bot ativo.
- TypeScript aprovado após as correções de produto.
- Fixtures de repositório e expectativas da migration0066: **48 testes aprovados**. A primeira suíte geral identificou oito falhas nesses mocks/expectativas; foram atualizados preservando asserções de consentimento, pausa e cadeia completa.
- Suíte geral após essas correções: **408 arquivos / 3125 testes aprovados**, em 331,05s. A correção subsequente do histórico abaixo recebeu verificações focais próprias; não se declara que a suíte inteira foi repetida após ela.
- Histórico após ciclos: a nova regressão reproduziu QR_HISTORY_ID_CONFLICT ao reencontrar uma mensagem legítima do atendimento anterior. Deduplicação agora aceita somente mesma direção e mesmo contato físico de um ciclo retirado, preservando seu conversation_id. Contato diferente continua conflitando. Contrato da ingestão permanece void.
- Verificação após essa última mudança: typecheck, **17 testes unitários QR** e **10 testes PostgreSQL de histórico aprovados**.

## Banco e implantação futura

0066_physical_conversation_cycles acrescenta somente índice. Probe recusa índice ausente, inválido, parcial, com colunas ou ownership divergentes. Migration executada em bases descartáveis com as roles reais e RLS. Schema esperado passa a 0066; servidor existente não foi alterado. Aplicar migrations apenas no futuro corte de homologação aprovado, com backup e imagem correspondente; não executar agora.

## Limites

Não importa histórico integral do aparelho, não comprova capacidade de dez mil conexões, não homologa Meta/calls/Chatwoot externo e não configura bots. Callback novo de identidade ainda não verificada precisa do GET canônico antes de qualquer associação. Não oferece ordenação absoluta de callbacks remotos atrasados nem resolve resultado externo UNKNOWN por suposição.
