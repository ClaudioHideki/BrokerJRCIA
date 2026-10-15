# Candidato NICO/Broker de 15/10/2026

## Escopo e publicação

Branch de homologação autorizada: codex/nico-broker-coordenado-20261015.

Bases: Broker 0620ecd0c03ec22252f8518d3a76b6414f6d6cf0 e JRC b58e093dd3a32fe97829a4566660b83ee48b9eca. A instrução de branch separada substitui a entrega direta na main para este candidato. Nenhuma alteração no servidor foi aplicada por este desenvolvimento.

## Incremento inicial Broker

A consulta do histórico também lê o estado atual da conversa e atualiza o rótulo bot/humano. Escopo de conversa/caixa e guards de tenant/aborto são verificados antes de apresentar os dados. O rascunho é preservado.

Uma revisão de mutação local impede que uma resposta GET iniciada antes de uma tomada humana desfaça o modo confirmado. Atualizar histórico não faz PATCH nem envia mensagem.

Evidência TDD:
- Duas regressões iniciais falharam no código original, por modo obsoleto e ausência da consulta do estado.
- Uma regressão adicional falhou ao aplicar BOT antigo depois da tomada humana confirmada.
- Após a correção, Messaging.test.tsx: 34 testes aprovados.
- npm run typecheck: aprovado.
- npm test -- --maxWorkers=2 --reporter=dot: 375 arquivos, 2.884 testes aprovados.
- As restrições iniciais de esbuild/Git/Docker foram resolvidas por execução autorizada dos comandos locais; não foram removidos gates.

## Incremento inicial JRC/NICO em verificação

Foram escritos sete cenários sobre janela recente, mensagens privadas, conversa/Account e claim da entrada mais recente. No fonte original: sete exemplos, seis falhas correspondentes ao defeito e uma aprovação de isolamento.

Seis consultas foram alteradas em OperatorSession, ToolExecutor, CustomerTurnJob e ContextBuilder, substituindo order acumulado por reorder. O restante da autorização, formato e limites foi preservado.

Regressões e fluxos existentes de comandos/delegação estão em execução no laboratório Rails/PostgreSQL/Redis descartável. O resultado final será acrescentado após sua conclusão. Não há alteração de provedor, modelo, orçamento ou runtime NICO nesta correção.

## Continuidade e instalação

A tomada coordenada NICO/Broker, os executores de ações/mídia, timeout do Flow, distribuição QR/Flow e demais critérios P0–P10 continuam no programa. A correção da tela não entrega o protocolo distribuído de tomada, e corrigir histórico não torna todos os módulos NICO homologados.

A publicação das branches e imagens candidatas será registrada com CI e digests efetivos. Nenhuma imagem é considerada publicada por existir um Dockerfile ou um commit. O usuário acompanha o candidato antes de qualquer alteração no Dokploy.

