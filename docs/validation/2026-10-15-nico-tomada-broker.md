# NICO: tomada distribuída no Broker — validação local

Implementação candidata, sem commit, imagem publicada ou alteração de produção nesta etapa. Somente PostgreSQL descartável local (`127.0.0.1:55464`) e dados sintéticos. A integração com o JRC/host externo real continua pendente de decisão do usuário.

## Contrato entregue

Sob `/v1/integrations/chatwoot/control/connections/:integrationId/conversations/:remoteConversationId`: snapshot `GET /attendance`, begin `POST /takeovers`, consulta `GET /takeovers/:id`, `POST /takeovers/:id/complete` e cancelamento `POST /takeovers/cancel`. Autoridade API_KEY vinculada a `chatwoot:manage`; ator decimal apenas atribui a ação do BFF confiável. Não há envio pelo Broker.

Request UUID estável, fingerprint multiplataforma e revisões são persistidos. Cancelamento por requestId grava tombstone mesmo antes do begin; uma chamada tardia não reabre o fence. A Message canônica deve ser pública, outgoing/User, no destino e ator esperados, com conteúdo aprovado e metadata da operação. A leitura autenticada ocorre fora de transação e é revalidada antes de encerrar. Complete e cancel são idempotentes sem novo header; begin exige `Idempotency-Key=requestId`.

Migration0062 instala RLS forçada, grants mínimos, recibos imutáveis, unicidade de request/Message, integração ao purge/lifecycle e readiness. OPEN impede retomada da conversa e alterações de owner/binding do canal. Reservas de cutover e bind remoto também são bloqueadas antes do despacho remoto; begin recusa uma reserva preexistente. A guarda é de manutenção do canal, mas as outras conversas continuam executando sob o proprietário existente.

## Fontes de efeitos em voo

`takeoverHasUnsettledWork` consulta cada fonte abaixo, sem inferir ausência a partir de uma tabela principal vazia.

| Fonte | Antes do despacho | Em voo ou incerta | Teste NICO local | Caminho existente/limite |
| --- | --- | --- | --- | --- |
| `automation_outbox` | PENDING cancelado pela tomada existente | SENDING/UNKNOWN bloqueiam | Handoff PREPARED/UNKNOWN e mídia PREPARED/SENDING com outbox cancelado; demais ledgers isolados com outbox SENT | Worker/diagnóstico de outbox; nunca replay por timeout |
| `messaging_messages` | ACCEPTED automático vira FAILED e perde outbox | SENDING/UNKNOWN automático bloqueia | UNKNOWN → fato DELIVERED libera PAUSED | Dispatcher/ACK/canonical receipt |
| `messaging_bot_jobs` | PENDING vira PAUSED | RUNNING vira UNKNOWN; UNKNOWN continua bloqueando | Caminho existente inspecionado; sem caso novo dedicado de job nesta rodada | Resultado incerto não tem nova prova criada pelo NICO; cancelamento da intenção permite sair sem enviar, conservando HUMAN |
| `attendance_handoff_operations` | PREPARED fica ACTION_REQUIRED e outbox é cancelado | OPEN_DISPATCHED/ASSIGNMENT_DISPATCHED PENDING/UNKNOWN/ACTION_REQUIRED bloqueiam | Três fases, inclusive outbox já SENT | `handoff-service.reconcileOnce`: leitura canônica confirma APPLIED; falha conserva UNKNOWN |
| `attendance_resume_operations` | PENDING/PREPARED vira CANCELED, lease invalidada | Fase posterior PENDING/UNKNOWN/ACTION_REQUIRED bloqueia | PREPARED versus CLEAR_AGENT | `resume-worker`: leitura canônica não prova autoria; ACTION_REQUIRED preserva a necessidade de prova/ação operacional |
| `chatwoot_mirror_attempts` | RESERVED vira REJECTED | DISPATCHED/UNKNOWN automático bloqueia | Três estados com mensagem já DELIVERED | `central-dispatcher` reconcilia ACK/recibo canônico; não repete POST incerto |
| `chatwoot_attendance_observations` | — | ECHO_PENDING/RECONCILE bloqueiam | RECONCILE sem mensagem/outbox em voo | Classificador/reconciliação existente de observações |
| `qr_dispatch_attempts` | — | DISPATCHED/UNKNOWN automático bloqueia | Ambos estados com mensagem DELIVERED; CONFIRMED libera | `qr-outbound-observation`: ACK/prova correlacionada e abandono administrativo auditado existente |
| `qr_outbound_observations` | — | `blocking=true` bloqueia | Observação isolada | Reconciliação/abandono auditado existente |
| `automation_conversation_effects` | PREPARED vira REJECTED e outbox é cancelado | DISPATCHED/UNKNOWN bloqueiam | Mídia em três estados com outbox isolado | Proteção do ledger0060/0058; esta tarefa não implementa runtime futuro de mídia/ações nem inventa reconciliação automática |

UNKNOWN permanece um fato incerto. O cancelamento NICO fecha somente a intenção irrevogavelmente cancelada no JRC; não apaga esses ledgers, não comprova entrega e não reativa BOT. Nenhuma pendência seguramente anterior ao despacho dos ledgers tratados mantém DRAINING por sua própria marca cancelada.

## Evidência

- RED HTTP inicial: rotas inexistentes (3 falhas); GREEN após wiring.
- RED PostgreSQL inicial: tabela ausente e serviço ainda não implementado; primeira versão GREEN10, depois GREEN17.
- RED owner: UPDATE para EXTERNAL era aceito após PAUSED. Guard de owner/binding corrigido e validado.
- RED cutover: begin devolvia PAUSED com reserva REQUESTED preexistente. Guard de reserva/trigger corrigido e validado.
- RED int8 canônico: IDs decimais retornavam CHATWOOT_INVALID_RESPONSE. Normalização restrita corrigida; 16 testes do cliente + 4 HTTP = 20/20.
- `nico-takeovers.test.ts` (34), `migrations.test.ts` e `runtime-schema-readiness.test.ts`: 58/58, duração97.02s. Inclui upgrade do baseline antigo, ownership/grants/policies, probe jrc_app, mutação/DELETE recusados, cancel versus begin, replay tardio, escopo/credencial/contato, HTTP fora de transação, hash/metadata/ator, recibo não reutilizável, callbacks humanos e os ledgers acima.
- Focal final de recibo repetido: RED retornava PostgreSQL23505; GREEN1/1 (33 não executados) retorna `NICO_TAKEOVER_RECEIPT_CONFLICT`, HTTP409, preservando o índice único. O factory canônico verifica que não há transação aberta mesmo quando a resposta HTTP é mockada.
- `npx tsc -b apps/api --pretty false`: exit0. Unidades adjacentes de resume/manual takeover/diagnóstico/fingerprint:9/9. `git -c diff.ignoreSubmodules=all diff --check`: limpo.
- Não foi executada suíte global por este agente; o coordenador fará a validação consolidada antes de commit.
