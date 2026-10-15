# Plano inline — respondedores nativos por Inbox

Design aprovado: ../specs/2026-10-15-native-inbox-responder-fence-design.md. Respeitar TDD, investigação antes de corrigir e verificação antes de alegar conclusão. O root autorizou esse escopo após o GREEN do lote atual15; nenhum arquivo de produto desse incremento foi editado na preparação do plano.

1. [ ] Concluir os15 focais atuais (Identity/heartbeat/probe/webhook) no laboratório próprio, sem Rails concorrente. Congelar o lote atual e comunicar o resultado real.
2. [ ] Escrever/observar RED do schema/adaptador NativeOwnership com par botID/callback e null QR. Propagar somente contexto canônico já observado; testar adulteração/revogação. Não mudar service.ts, STOCK ou IDs dos alvos.
3. [ ] Fixar nomes reais de guard no contrato existente com testes de proof antigo incompleto. Coordenar packages/contracts com root P3 antes do hunk.
4. [ ] Escrever RED Rails para fence de Inbox A/B, regra mixed message/label/assign, bot de Inbox/Conversation, callback canônico e ator API autenticado. Acrescentar160000 e helpers mínimos, medir serialização em PostgreSQL; não aceitar atributos autodeclarados como credencial.
5. [ ] Guardar executores reais e transportes assíncronos com os ledgers existentes. RED/GREEN de queued cancelável versus UNKNOWN durável, retries, revogação e fence durante HTTP sem tx. Preservar branches de entrega NICO/ServiceDesk/Survey/Flows.
6. [ ] Guardar reconfiguração AgentBotInbox/AgentBot/assignee_bot/policy sob scope, com triggers e testes de corrida. Verificar schema instalado antes de capabilities; heartbeat/probe medem hooks novos de todos os PIDs.
7. [ ] Regenerar guard/manifests após freeze BFF+editor do root, verificar blobs b58 reais e distribuição fonte em cópia isolada. Não regenerar bundle antigo. Não afirmar prova instalada por testes de fixtures.
8. [ ] Rodar somente arquivos focais e diff --check; publicar logs/resultados/limites ao root. Root faz commit candidato e CI Linux consolidada; imagem/deploy aguardam os gates e autorização já coordenada.
