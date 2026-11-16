# Proteção de histórico e release Broker/LAB2

**Objetivo:** fechar o risco de exclusão parcial, concluir os gates da candidata e publicar os dois sistemas autorizados pelo usuário em 16/11/2026.

**Arquitetura:** preservar recibos, mensagens, escrow e objetos KEEP. A remoção de conexão continua distinta do expurgo. Rejeitar exclusão destrutiva protegida antes do enqueue e antes de qualquer limpeza, com resposta de conflito compreensível. Manter as restrições de banco; nunca usar CASCADE para liberar a exclusão.

**Referências:** ADR LAB2 `0002-recibo-live-custodia-broker.md`, desenho de lifecycle de 11/11 e plano `2026-11-16-whatsapp-delivery-reliability.md`.

## Escopo autorizado e invariantes

- O pedido atual autoriza código, testes, publicação e deploy Broker/Grupo JRC; substitui o limite de candidata local dos documentos anteriores para esta release.
- Não executar backup, dump, restore, envio real, pareamento, replay de UNKNOWN, limpeza de dados ou alteração de outros clientes.
- CI em runners descartáveis GitHub; não forçar reinício do Docker local.
- Preservar autoria e todos os commits novos; reconferir main antes da promoção.
- Testes sintéticos, imagem publicada, runtime e aceite físico são provas diferentes.

## Etapas e provas

1. [x] Buscar as duas mains e comprovar ancestry: Broker `c3bae632`, LAB2 `a24adc6d`, já contidas nas candidatas. Nenhum commit novo observado nesta consulta.
2. [ ] LAB2 TDD: testes reais para API/worker, mensagem/anexo, pendência de mídia, isolamento e corrida; demonstrar RED antes da correção.
3. [ ] LAB2 implementação mínima: serviço de retenção, preflight antes do enqueue e do cleanup, transação/fence correspondente, erro409 em PT-BR. Manter exclusão normal de registros sem custódia.
4. [ ] Auditar lifecycle/expurgo Broker e corrigir somente lacunas demonstradas, com TDD.
5. [ ] Revisão independente e CI Rails/frontend/Broker, E2E conjunto pinado no novo SHA, sem backup/recovery.
6. [ ] Publicar imagens pelos workflows existentes com commit e digest imutáveis; promover main preservando ancestry.
7. [ ] Inventariar Compose/runtime atual no Dokploy; aplicar receiver/schema LAB2 antes de produtor Broker. Preservar env, volumes, limites e engine se não houve alteração dela. Não habilitar captura/ownership por inferência.
8. [ ] Conferir init/migrations, Rails/Sidekiq, API/workers/web Broker, health e interface Minhas. Registrar exatamente o que foi e não foi comprovado.

## Revisão obrigatória

- Nenhuma associação é apagada/enfileirada antes da recusa; worker revalida jobs já existentes.
- Custódia criada entre solicitação e execução, ou durante limpeza, não permite apagamento parcial.
- PRIVATE media e recibos permanecem íntegros; delete de mensagem/anexo não ignora o guard.
- Erro não expõe conteúdo, telefone, token ou dados de outra empresa.
- Reversão preserva schema e evidências; binário antigo incompatível não é rollback válido.

## Evidência incremental

- Acesso Dokploy autenticado confirmado nesta execução; nenhuma mutação produtiva realizada na preparação.
- Base E2E anterior: Broker `e26e5f7` + LAB2 `982f1541`, run43957172112, cinco suítes/seis cenários aprovados. Essa prova antecede a nova proteção e não substitui o seu gate.
