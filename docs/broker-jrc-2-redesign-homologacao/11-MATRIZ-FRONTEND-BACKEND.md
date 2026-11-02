# 11 — Matriz frontend/backend

Fonte: código do checkout auditado em 30/10/2026. Matriz voltada a UX, contratos consumidos e piloto; não substitui o catálogo exaustivo OpenAPI ou auditoria de todas as autorizações.

## Superfícies e contratos

| Superfície | Contrato observado | Fonte frontend / backend | Estado e limite |
|---|---|---|---|
| Saúde operacional | GET `/v1/operations/health` → schemaVersion, observedAt, overall, components, alerts | `pages/OperationalHealth.tsx`; `http/routes/observability.ts`; `modules/observability/service.ts` | API existente; JWT de membro atual; no-store; query vazia estrita. Front usa tipo local sem parse runtime no baseline. |
| Resumo e relatórios | GET `/v1/organization/overview?days=N` → `BrokerOverviewSchema` | `broker/use-overview.ts`, `pages/Dashboard.tsx`, `Operations.tsx` | Front valida schema e cancela/purga por tenant. Período é criação da mensagem; estado pode mudar depois. |
| Empresa/uso | GET `/v1/organization/operations` | `pages/Company.tsx`, `Usage.tsx` | Limites/estado efetivos; não inferir cobrança completa nem capacidade validada. |
| Canais | GET/POST `/v1/channels`; GET/PATCH `/v1/channels/:id`; status, pair, reconnect, disconnect, automation, destination, operation-profile | `channels/api.ts`, `pages/ChannelDetail.tsx`; contratos `Channel*Schema` | Fronteira unificada QR/Meta/central; gestão e pareamento têm papéis/capabilities diferentes. |
| Integração central | GET `/v1/integrations/chatwoot`; sources, inboxes, connections e jobs | `Integrations.tsx`, `ChatwootPanel.tsx`; `http/routes/integrations.ts` | Leitura JWT membership; escrita OWNER/ADMIN no guard. Fontes/inboxes são consultadas condicionalmente no front. |
| Diagnóstico de entregas | GET `/v1/integrations/chatwoot/jobs/summary` → `IntegrationDeliverySummarySchema` | `integrations/DeliveryDiagnostics.tsx`; `integrations.ts:320`; `packages/contracts/src/integrations/schemas.ts:75` | Agrupamento FAILED/UNKNOWN, code, total, firstSeenAt, lastSeenAt. Front exibe contagem/código/ação, ainda não datas. |
| Jobs centrais | GET `/v1/integrations/chatwoot/jobs`; POST `/v1/integrations/chatwoot/jobs/:id/retry` com reason | `ChatwootPanel.tsx`; `integrations.ts` | Lista recente separada do agregado histórico; mutação já existe e não deve ser acionada pelo piloto. Retry não se confunde com replay de webhook parceiro. |
| Saúde de conexão | `ConnectionHealthSchema`: integração, sessão, identidade, callback, inbound/outbound, allowedActions | `ConnectionHealthSummary.tsx`; `http/routes/chatwoot-control.ts`, `chatwoot-embed.ts`; `contracts/src/integrations/control.ts` | Mais específica que o health global; depende da sessão de controle/embed e seus grants. Não buscar por UUID arbitrário para contornar autorização. |
| Automações | `/v1/automations`, `/:id/validate`, `/:id/versions`, `/v1/executions`, `/v1/automation-nodes` | `automations/api.ts`, `pages/AutomationStudio.tsx` | Draft/versionamento/revisões e resultados próprios. Leitura de health não autoriza reconciliar execução. |
| Staff/empresas | Cliente de plataforma e `/organizations/:id/*` no namespace próprio | `pages/Platform.tsx`, `platform/CompanyWorkspace.tsx`; `http/routes/platform.ts` | Sessão SUPER_ADMIN/SUPPORT distinta, motivo e proteções CSRF/origin. Não reutilizar JWT tenant para administração. |
| Diagnóstico staff | GET `base+'/jobs/summary'` com base da empresa/Chatwoot | `CompanyWorkspace` → `ChatwootPanel`; `platform.ts:526` | Mesmo schema de resumo; contexto da empresa selecionada e autorização staff. |
| Chaves/API | UI de emissão/revogação, escopos explícitos; `media:archive` já presente | `pages/ApiKeys.tsx`, `api-keys/*` | Checkbox não significa fluxo de custódia no console. Chaves antigas não recebem scope automaticamente. |
| Custódia/replay parceiro | Rotas canônicas e contratos existem no backend | `modules/media-custody`, `modules/partner-events`, contratos correspondentes | Auditoria anterior identifica ausência de UI própria. Não adicionar botão usando endpoint errado de jobs Chatwoot. |

## Payload de saúde e significado

`HealthComponent = {key,label,state,code,observedAt,metric?,unit?}`. Estados: UP, DEGRADED, DOWN, UNKNOWN. O backend agrega overall como DOWN se qualquer componente DOWN; caso contrário DEGRADED se houver DEGRADED ou UNKNOWN; senão UP. O frontend deve preservar esse resultado e qualificar a interpretação, sem criar uma média/percentual.

| Componentes | Fonte/regra atual | O que o front pode afirmar |
|---|---|---|
| API / DATABASE | Resposta da operação e sucesso das consultas SQL. | Consulta respondeu; não SLO de disponibilidade ou capacidade. |
| SCHEMA | `schemaCurrent` ou default do serviço; código de objetos exigidos. | Resultado do verificador configurado; não migração/restore completo. |
| REDIS | `probeRedis`, com falha/ausência tratada como false. | Resultado do probe; não durabilidade, memória, evictions ou saúde de todas as filas. |
| MESSAGING_WORKER / AUTOMATION_WORKER / AUTOMATION_IO_WORKER / SCHEDULER | Último heartbeat por componente; >45s default vence. | Última observação e idade. `AUTOMATION_RUNTIME_DISABLED` é pausa declarada, diferente de ausência. |
| EVOLUTION / META | `instances.status=CONNECTED` / `meta_connections.status=READY`. | Quantidade de registros conectados/prontos. Não é sondagem fim a fim. |
| CHATWOOT | Destinos APPROVED; degradação em `chatwoot_connection_health`. | Configuração e estado persistido consultados, não prova universal de mensagens entregues. |
| QUEUE | `messaging_outbox` + `automation_outbox` PENDING; alerta >1000. | Quantidade nesse recorte; não toda fila de integração/parceiro/importação. |
| OUTBOX_AGE | Mais antiga entre messaging e automation PENDING/UNKNOWN; alerta >300s. | Idade no recorte; não latência p95/p99. |
| FAILED_EXECUTIONS / UNKNOWN_EXECUTIONS | Todas as execuções com esses estados, sem janela. | Histórico persistido; não evolução temporal apesar de código `UNKNOWN_GROWTH`. |
| INTEGRATION_FAILURES / INTEGRATION_UNCERTAINTY | Todos os `integration_jobs` FAILED/UNKNOWN, sem janela. | Totais do histórico da integração central. Não mensagem WhatsApp nem delivery parceiro. |
| QR_IDENTITY_PENDING | `qr_identity_pending_events` WAITING/CONFLICT/STALE. | Fatos aguardando identificação/reconciliação no recorte, não descartar eventos. |

Total de componentes no baseline: 18. Uma futura adição não deve ser omitida nem interpretada como sucesso por falta de rótulo conhecido. Manter fallback textual e código técnico seguro.

## Cobertura necessária para o piloto sem backend novo

| Caso | Evidência esperada |
|---|---|
| Infra UP + integration FAILED/UNKNOWN | Componentes de transporte/histórico continuam em atenção; texto não declara entrega saudável. |
| Refresh falha depois de sucesso | Sem falsa atualidade; última consulta válida identificada e retry somente GET. |
| Retorno inválido | Erro de consulta/contrato, sem render crash nem contagem zero inventada. |
| Requests fora de ordem / troca de tenant | Resposta antiga descartada, componente desmontado não publica estado. |
| UNKNOWN/sem heartbeat | “Não observado”, sem converter a OFFLINE universal nem UP. |
| Link por componente | Integrações, canais, execuções e suporte levam a rotas existentes; nenhuma chamada POST. |
| VIEWER | Consulta permitida pelo contrato; nenhuma ação de gestão adicionada. |
| Código não reconhecido | Fallback explicativo, preservando código, sem orientação vazia. |

Testes identificados: `apps/api/tests/unit/observability.test.ts` cobre falhas de integração com workers saudáveis, identidade pendente, runtime pausado, heartbeat vencido e provider sem observação. `apps/web/src/integrations/DeliveryDiagnostics.test.tsx` cobre consulta sem replay, refresh falho sem manter total e resposta tardia de contexto anterior. `ConnectionHealthSummary.test.tsx` cobre sua semântica. Não executados neste subtrabalho; adicionar teste próprio da página piloto e executar seleção pertinente antes de afirmar conclusão.

## Pendências de backend que a UX não resolve

Agregados de filas não abrangem todas as etapas; contadores históricos não têm janela operacional/SLO; heartbeat recente não mede progresso útil; origem durável Evolution, ordem poll/webhook, capacidade/fairness e retenção/custódia exigem trabalhos próprios. A tela deve tornar esses limites visíveis onde relevantes, sem afirmar que o redesign os corrigiu.
