# P3: ações conversacionais e mídia — evidência Broker

Este registro cobre o incremento ainda em integração sobre `4a7decdd4e57dc2c25e37b6089fa6f2fcfe571f6`. Não comprova publicação de imagem, instalação externa nem produção. Contrato e decisões estão no [desenho aprovado](../superpowers/specs/2026-10-15-p3-acoes-midia-integradas-design.md).

## Contrato implementado

- Novas ações usam marcador 2 e `waitId === outboxId`. Um callback interno só retoma a espera correspondente com fato persistido; retomada manual e reclassificação manual de UNKNOWN não autorizam novo envio. Leitura histórica v1 é preservada.
- As quatro ações centrais usam `jrc-conversation-effects/2`: contexto autenticado antes da admissão, intenção durável antes do POST único, recibo imutável com hashes e pins de escopo/ator/destino/revisão. Reconciliação consulta GET; não repete o POST.
- Recibo confirmado registra o fato mesmo quando uma tomada humana cancelou a execução. Continuar exige autoridade atual, revisão remota esperada e cadeia local de observações comprovadas. Metadata isolada não concede autoridade.
- `resolve` confirma o recibo antes de resolver o atendimento e concluir o ciclo. Não agenda o próximo efeito. UNKNOWN permanece pendência durável.
- Nota local é privada e não cria mensagem pública/outbox de transporte. Etiquetas e atributos usam estado local por conversa; a projeção privada é entregue pelo DTO de conversa existente.
- Mídia usa armazenamento privado e o transporte canônico. Enfileirar não confirma envio. A verificação de autoridade exclui somente o mirror da própria intenção persistida; outro mirror incerto continua bloqueando. Confirmação tardia conserva HUMAN e execução cancelada.

## Migração 0063 e lifecycle

`0063_conversation_effect_protocol.sql` conserva linhas anteriores como protocolo 1, acrescenta contexto/request/recibo do protocolo 2 e protege os campos de prova com trigger. A restrição de prova rejeita NULL indevido; um índice parcial limita a uma intenção aberta por conversa.

`automation_effect_control_steps` mantém a cadeia antes/depois das observações. Possui FKs compostas de organização/outbox/conversa, RLS forçada, owner `jrc_migrator` e apenas SELECT/INSERT para `jrc_app`. A política de migrator permite a limpeza lifecycle. A tabela está no `lifecycle_purge_catalogue`; o purgador existente ordena as tabelas pelos FKs. A dependência é steps → observations → effects, sem ciclo novo. A remoção de canal/conversa usa os FKs existentes e CASCADE do ledger. A inspeção estática não substitui o gate de purge da suíte integrada.

O probe obrigatório verifica tabela/política/privilégios, colunas, constraint validada, trigger habilitado e índices. A baseline do runtime, journal, inventário e testes de baseline apontam para 0063. O índice de notas `(organization_id,channel_id,conversation_id,created_at DESC,id DESC)` atende a projeção privada das últimas 100 notas.

## Evidência focal recebida do executor root

| Gate | Resultado confirmado |
| --- | --- |
| Cliente Chatwoot protocolo 2 | 5 testes GREEN após RED |
| Helper Node de hash/schema/receipt matcher | 19 testes GREEN |
| Motor P3 e captura 0061 | 8 + 9 testes GREEN |
| Central + persistência PostgreSQL, usuário jrc_app | 10 testes GREEN, 31,32 s |
| Mídia + regressões central dispatcher/attendance observations | 52 PASS; o único caso com falha de fixture SQL passou isolado após casts UUID explícitos |
| Recuperação e mídia em subflow, PostgreSQL real | 3 testes GREEN: lease ativa/claim expirado; ACK antes do mirror; asset da definição filha |
| Prova de metadata/IDs/cadeia de revisão | 3 testes GREEN, incluindo UUID malformado sem consulta SQL |
| Typecheck workspace | exit 0 |
| Addon JRC com PostgreSQL real | 38 testes GREEN; evidência detalhada no repositório JRC |
| BFF JRC recursos | 6 testes puros GREEN |

O executor confirmou RED adicional para claim expirado sem intenção (UNKNOWN em vez de FAILED), metadata UUID malformada (consulta SQL indevida) e mídia confirmada antes do mirror (WAITING em vez de QUEUED). Após correções, os três focais PostgreSQL e os três testes de prova passaram. A recuperação trava canal, execução e outbox, revalida lease expirada e ausência de admissão, registra REJECTED e encerra FAILED sem redispatch. Lease ativa permanece intacta; retomada por error ainda exige autoridade atual. O bridge revisita CONFIRMED com a mesma espera ativa após o mirror terminar. O teste de subflow confirma asset pertencente à definição filha com autoridade da execução raiz.

Arquivos reproduzíveis: `apps/api/tests/integration/automation-conversation-{central,persistence,media}.test.ts`, `apps/api/tests/unit/automation-conversation-protocol.test.ts`, `apps/api/tests/unit/chatwoot-conversation-effect-client.test.ts` e regressões de central dispatcher/attendance observations. O coordenador executa os runners com um worker, em bancos descartáveis; não é necessário nenhum arquivo ignorado para reproduzir os testes versionados.

O coordenador habilitou as cinco entradas de criação após esses gates focais. A suíte integrada obrigatória, CI/imagem, purge integrado e homologação externa continuam separados desta evidência. Produto e testes estão congelados para a validação final do corte; nenhum deploy de produção foi executado.
