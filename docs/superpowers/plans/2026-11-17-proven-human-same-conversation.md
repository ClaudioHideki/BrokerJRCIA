# Reparo da resposta humana bloqueada — plano de execução

> Executar inline com systematic-debugging, TDD e executing-plans. Concluir revisão do diff e verificação antes de publicar.

**Objetivo:** restaurar o JRC integrado e entregar uma intenção humana comprovada sem repetir a cópia antiga incerta.

**Arquitetura:** manter fila/UNKNOWN e identidades; admitir somente um novo efeito idempotente após prova canônica e mesmo escopo/ciclo. Nenhuma migração ou mudança de engine.

**Spec:** ADR0004 e diagnóstico somente leitura de 17/11, conversa426. Usuário autorizou reparo, testes, publicação e teste WhatsApp real. Não registrar payloads, telefones ou credenciais no Git.

## Execução

- [x] Conferir main remota e ancestralidade: LAB2d468 preserva5d57; main8977 é somente documentação posterior. Broker main d4a permanece no código966.
- [x] Restaurar somente digest integrado LAB2; init0 e SHA d468 observados. Conferir Rails/Sidekiq e saúde ao fechar.
- [ ] RED: em chatwoot-human-intents.test.ts reproduzir entrada incerta na mesma conversa, tentativa UNKNOWN, nova intenção assinada, uma saída esperada e UNKNOWN inalterado. Adicionar concorrência/reentrega e casos negativos de direção, ciclo, prova e controle.
- [x] Executar RED em PostgreSQL descartável GitHub Actions antes de editar produto. Run44084009424/job134041564232:42 testes,40 aprovados/2falhas esperadas (nenhuma saída e nenhuma releitura no caso positivo). Demais testes e negativos preservados. Produto ainda inalterado nesse commit83431af.
- [ ] GREEN: ampliar somente independentHumanReply em chatwoot-worker.ts com prova restrita ADR0004; revalidar antes do enqueue após GET canônico. Não alterar a regra de campanhas ou a tentativa antiga.
- [ ] Rodar npm test, integração focada/ampla, typecheck/build e E2E com LAB2d468. Rever diff/segredos/licenças e main concorrente.
- [ ] Publicar imagem Broker por SHA/digest; aplicar somente serviços de produto no Dokploy, sem maintenance/provision.
- [ ] Conferir uma única saída para a intenção original nunca despachada, confirmação do provedor e presença no WhatsApp. Preservar UNKNOWN antigo e provar ausência de duplicata.
- [ ] Registrar versões, CI, runtime e limites nas tarefas/checkpoint/relatório.

## Rulings

- O pedido atual autoriza reparar o caso restrito de mesmo contato, substituindo a restrição conservadora anterior apenas sob a prova ADR0004.
- As respostas PENDING com zero tentativas são intenções nunca despachadas. Processá-las pelo ID original é primeiro despacho, não replay de SEND_MESSAGE incerto. Não criar novas mensagens de cliente ou limpar jobs manualmente.
