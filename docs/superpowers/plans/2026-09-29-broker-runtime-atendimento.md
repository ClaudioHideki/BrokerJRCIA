# Broker — runtime e atendimento — plano de implementação

> **Para execução por agentes:** usar `superpowers:subagent-driven-development` ou `superpowers:executing-plans`, com teste falhando, correção e revisão por tarefa.

**Objetivo:** executar uma única sessão conversacional por atendimento e integrar bot, time, atendente e encerramento de forma persistente.
**Arquitetura:** serviços internos de atendimento sobre os módulos automations/messaging/integrations existentes. Uma autoridade controla o executor da caixa; uma fila por sessão controla eventos e efeitos. Operações remotas usam trabalhos persistentes e reconciliação.
**Stack:** TypeScript/Zod, PostgreSQL/RLS, Redis e workers atuais.
**Spec:** [Escopo](../specs/2026-09-29-broker-first-completion-design.md).
**Programa/dependências:** [Plano principal](2026-09-29-broker-first-completion.md); executar B0 primeiro.

## Restrições globais

- Um único executor de bot por caixa.
- Cada nova alteração deve verificar papel atual e empresa/caixa.
- Não há execução de JSON arbitrário nem promessa de equivalência integral n8n.
- Não há deploy de produção ou exclusão de recursos reais como parte da execução de testes.
- Os módulos Flow/QR no host só começam após BROKER_READY.
- Novo contrato não remove suporte a versão publicada/estado antigo sem migração demonstrada.

## Foco da revisão

Duas entradas rápidas (R2); humano durante I/O (R2/R4/R5); mapeamento remoto atrasado/trocado (R3/R4); ação de retomada duplicada (R5); efeito externo sem confirmação (R4/R7/R8). Os testes abaixo fixam esses casos.

## Contratos novos compartilhados

Criar `packages/contracts/src/attendance-v1.ts` e exportar em `index.ts`. Todos os nomes desta seção são **propostos**, não APIs atuais. A organização/ator vem da autenticação do servidor; parâmetros abaixo são interfaces internas.

```ts
type AttendanceScope = {
  organizationId: string; channelId: string; integrationId: string;
  destinationRevision: number; accountId: number; inboxId: number;
};
type AttendanceState =
  | 'BOT_ACTIVE' | 'WAITING_INPUT' | 'HANDOFF_PENDING'
  | 'WAITING_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED' | 'ADMIN_PAUSED';
type AttendanceSession = {
  id: string; scope: AttendanceScope; conversationId: string;
  cycle: number; executionId: string | null;
  automationId: string | null; version: number | null;
  state: AttendanceState; revision: number; ownerRevision: number;
  remoteConversationId: number | null; resumeNodeId: string | null;
};
type Ownership = {
  channelId: string; integrationId: string; revision: number;
  executor: 'BROKER' | 'EXTERNAL' | 'NONE';
  automationId: string | null; version: number | null;
};
type ResumeTarget =
  | { kind: 'CONTINUE' }
  | { kind: 'MENU'; nodeId: string }
  | { kind: 'NEW_SESSION' };
type HumanTarget = { teamId: number | null; agentId: number | null };
type HandoffOperation = {
  id: string; sessionId: string;
  state: 'PENDING' | 'APPLIED' | 'UNKNOWN' | 'ACTION_REQUIRED';
};
```

IDs remotos são referências, nunca autoridade. Resolver e conferir `AttendanceScope` no servidor a partir de canal/integração; não aceitar Account/Inbox arbitrárias do browser. HumanTarget exige ao menos time ou agente válido; ambos nulos não significam uma fila implícita. Contratos HTTP são DTOs sem segredo nem acesso ao cliente Chatwoot.

Nova rota proposta de catálogo: `GET /v1/integrations/chatwoot/connections/:integrationId/attendance-catalog`.
Novas rotas propostas de sessão: `GET /v1/attendance/sessions/:id`, `POST .../:id/handoff`, `POST .../:id/resume`. Reutilizar convenções reais de autorização, CSRF e idempotência. Documentar OpenAPI junto de cada rota, sem anunciar endpoint antes de implementá-lo.

## R1 — modelo de atendimento e autoridade única de ativação

**Dependência:** B0. **Entrega:** nenhum caminho de binding contorna exclusividade/revisão.
**Modificar:** `channels/facade.ts`, `automations/service.ts`, `messaging/repository.ts`, `flows/chatwoot-service.ts`, `automations/legacy-migration.ts`, todos sob `apps/api/src/modules/`; `apps/api/src/http/routes/automations.ts`.
**Criar:** `apps/api/src/modules/attendance/types.ts`, `repository.ts`, `ownership-service.ts`; contrato acima; migration nova aditiva com número reservado em B0, journal e prova de schema atualizados.
**Testes novos:** `packages/contracts/tests/attendance-v1.test.ts`; `apps/api/tests/integration/attendance-storage.test.ts`, `attendance-migration-upgrade.test.ts`, `attendance-ownership-concurrency.test.ts`.
**Interface:** `claimInboxOwner(scope: AttendanceScope, input: {executor: Ownership['executor']; automationId: string|null; version: number|null; expectedRevision: number}): Promise<Ownership>`.

- [ ] Criar testes de RLS/FKs, upgrade do estado atual e dois binds concorrentes. Asserções: `activeOwners === 1`; revisão obsoleta recebe conflito; empresa B não lê sessão A; mesma Account numérica em destinos diferentes não é confundida.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/attendance-storage.test.ts apps/api/tests/integration/attendance-ownership-concurrency.test.ts`; confirmar falha pelo contrato ausente, não por falta de banco.
- [ ] Persistir controle por canal/integração e ciclos por conversa. Impedir duas organizações independentes de adotarem a mesma Account remota pela identidade canônica da instalação. Preservar versões e estado prévio no upgrade.
- [ ] Fazer facade, serviço de automação, modo legado e migrador chamarem a mesma autoridade transacional. Remover escrita direta divergente. Mudança de executor incrementa revisão e drena/invalida trabalho incompatível.
- [ ] Validar conflito com AgentBot visível e regras concorrentes conhecidas. Flow local JRC invisível à API deve estar desativado na caixa Broker; registrar que detecção universal dependerá do módulo posterior.
- [ ] Reconciliar executor remoto antes de cada lote de efeitos sensíveis, com observação nova por despacho; cache da UI não autoriza envio. Divergência ou impossibilidade de confirmar invalida ownerRevision e pausa o bot com diagnóstico, sem remover robô alheio. Testar evento enfileirado → outro AgentBot associado na central → reconciliação → nenhum novo despacho Broker. Registrar o intervalo inevitável entre leitura e ação remota: a API externa não oferece transação atômica com o Broker.
- [ ] Rodar testes novos e `legacy-flow-owner-transition.test.ts`, `channel-facade-isolation.test.ts`; aprovar diff e commit após `npm test`.

## R2 — sessão serial, esperas corretas e dados preservados

**Dependência:** R1; consumir schemas dos blocos U1 sem alterar semântica publicada silenciosamente.
**Modificar:** `apps/api/src/modules/automations/{types,engine,repository,service}.ts`, `apps/api/src/modules/messaging/worker.ts`, `apps/api/src/commands/automation-io-worker.ts`.
**Criar:** `apps/api/src/modules/attendance/event-router.ts`.
**Testes novos:** `apps/api/tests/integration/automation-session-serialization.test.ts`, `automation-human-race.test.ts`, `automation-version-pinning.test.ts`.
**Interface:** `enqueueAttendanceInput(sessionId: string, eventKey: string, input: RuntimeInput): Promise<{queued: boolean; duplicate: boolean}>` dentro da transação de tenant; `RuntimeState` versionado mantém valores JSON tipados.

- [ ] Testar duas entradas durante QUEUED/RUNNING: `activeExecutions === 1`, as duas entradas preservadas e consumidas uma vez. Testar mensagem durante IO/DELAY sem concluir essa espera.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/automation-session-serialization.test.ts`; reproduzir a falha atual de seleção apenas WAITING.
- [ ] Serializar eventos por sessão, distinguir espera EVENT/IO/DELAY e arbitrar timer/resposta transacionalmente. Não descartar mensagem recebida enquanto trabalho anterior está ocupado.
- [ ] Persistir revisões de sessão/executor em efeitos. Revalidar antes de I/O e envio; invalidar trabalho ainda não despachado após controle humano. Pedido já enviado ao provedor fica rastreável/reconciliável, sem promessa falsa de cancelamento.
- [ ] Introduzir sequência causal de efeitos por sessão e vínculo automation-outbox → messaging-outbox. Enfileirar SEND_TEXT não equivale a confirmação de envio: o efeito acompanha o resultado real. Implementar aqui a ordenação mínima exigida por R4/M2; R8 amplia carga/recuperação. Testar dois workers com envio atrasado antes de HANDOFF.
- [ ] Remover truncamento silencioso em 4096 caracteres. Limite inicial de valor JSON: 65536 bytes, alinhado ao executor de dados atual; estado agregado: 262144 bytes. Excesso gera código explícito, sem salvar resultado parcial. Esses limites são decisões deste plano e exigem schema/testes; não implicam tamanho de mensagem WhatsApp.
- [ ] Testar valores com mais de 4096 caracteres, objetos/listas, restart e versão antiga. Rodar os três arquivos novos e `npm test -- apps/api/tests/unit/automation-engine.test.ts`; revisar/commit.

## R3 — catálogo da central e eventos de controle

**Dependência:** R1; pode avançar junto de R2.
**Modificar:** `apps/api/src/modules/integrations/chatwoot-client.ts`, `chatwoot-events.ts`, `chatwoot-service.ts`, `chatwoot-worker.ts`; `apps/api/src/http/routes/integrations.ts`.
**Criar:** `apps/api/src/modules/integrations/chatwoot-attendance-service.ts`, `chatwoot-attendance-events.ts`.
**Testes novos:** `apps/api/tests/unit/chatwoot-attendance-catalog.test.ts`, `chatwoot-attendance-events.test.ts`; `apps/api/tests/http/chatwoot-attendance.test.ts`.
**Interface:** `listHumanDestinations(scope: AttendanceScope): Promise<AttendanceCatalog>`. Definir `AttendanceCatalog` no contrato: revisão/observação, times, agentes, membros da caixa, etiquetas, definições de atributos, horários/fuso e capacidades disponíveis. Itens têm ID e nome; não retornam tokens.

- [ ] Testar time excluído, agente fora da caixa, token revogado, instalação errada e revisão de destino trocada. Assert: nenhum catálogo da outra empresa e nenhuma credencial na resposta.
- [ ] Rodar `npm test -- apps/api/tests/unit/chatwoot-attendance-catalog.test.ts apps/api/tests/unit/chatwoot-attendance-events.test.ts`; confirmar os comportamentos ausentes.
- [ ] Reutilizar agents/inboxAgents existentes; adicionar consultas tipadas de times, etiquetas/atributos, horários, estado e atribuição da conversa. Cache curto pode ajudar a UI, mas ativação/transferência revalida recursos.
- [ ] Classificar eventos autenticados: humano, bot externo, reflexo Broker, privado e sistema. Controle humano confiável invalida cedo a sessão; eventos fora de ordem não reativam bot.
- [ ] Provar capacidades de assinatura/eventos da instalação. Quando faltarem eventos de atribuição, reconciliar estado canônico antes de efeitos sensíveis; não chamar “assunção imediata” um polling sem garantia. Conflitos de saudação/autoatribuição devem aparecer no diagnóstico.
- [ ] Definir no mirror o início remoto de sessão BROKER: criar conversa nova em pending quando essa capacidade estiver homologada, sem depender do binding AgentBot legado. Configuração deve impedir distribuição/saudação humana concorrente enquanto o bot atende. Se a instalação não suportar a política, bloquear esse modo com diagnóstico, sem cair silenciosamente em open. Conversa existente com responsável humano mantém controle humano até ação explícita; não limpar atribuição para iniciar bot.
- [ ] Testar primeira mensagem Broker v2 sem binding legado, bot aguardando resposta, ausência de atribuição humana prematura e posterior transferência. Incluir evento open/humano recebido durante a criação e revalidação da revisão.
- [ ] Não reutilizar callback de transporte como AgentBot nem instalar webhook adicional sem contrato, deduplicação e teste. Testar API/isolamento e OpenAPI; revisar/commit.

## R4 — transferência humana real e recuperável

**Dependência:** R1/R2/R3 e schema handoff de U1.
**Modificar:** `apps/api/src/modules/automations/engine.ts`, `service.ts`, `apps/api/src/commands/automation-worker.ts`, `apps/api/src/modules/integrations/chatwoot-worker.ts`.
**Criar:** `apps/api/src/modules/attendance/handoff-service.ts`, `effect-dispatcher.ts`; `apps/api/src/http/routes/attendance.ts`.
**Testes novos:** `apps/api/tests/integration/automation-chatwoot-handoff.test.ts`, `chatwoot-handoff-recovery.test.ts`; ampliar `automation-native-journey.test.ts`.
**Interface:** `requestHandoff(scope: AttendanceScope, input: {sessionId: string; expectedRevision: number; target: HumanTarget; idempotencyKey: string}): Promise<HandoffOperation>`.

- [ ] Criar teste cujo aceite exige atribuição/status remotos conferidos, não um dispatcher fake retornando SENT. Cobrir mirror atrasado e alteração humana durante transferência.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/automation-chatwoot-handoff.test.ts`; confirmar que o HANDOFF local atual não cumpre o teste.
- [ ] Aplicar barreira causal antes da transferência automática: congelar novos efeitos do bot, acompanhar os envios anteriores pelo resultado real e só então atribuir o atendimento. Drenagem limitada por deadline persistido; ao vencer, cancelar os ainda não despachados, manter enviados de resultado UNKNOWN sem retry automático, registrar aviso não confirmado e prosseguir ao humano. Assunção humana externa tem prioridade imediata e invalida todos os efeitos ainda não despachados, sem esperar a drenagem. Não prometer impedir entrega tardia de pedido já enviado ao provedor.
- [ ] Persistir HANDOFF_PENDING com a sequência limite da drenagem; bloquear saídas posteriores; garantir criação/mapeamento remoto; conferir recurso; atribuir time e agente conforme capacidade; atualizar estado e reler. Não presumir que enviar team_id e assignee_id juntos aplica ambos.
- [ ] Registrar passos/attempt/revisão, timeout UNKNOWN e falha ACTION_REQUIRED. Repetir só após consulta que permita determinar o resultado, evitando duplicar nota ou aviso.
- [ ] Definir contingência: time sem agente fica aguardando equipe quando essa política foi selecionada; destino inexistente não vira sucesso nem reativa bot. Não inventar posição de fila.
- [ ] Testar restart após atribuição, status falho, timeout após sucesso remoto e dupla chamada idempotente. Rodar arquivos novos mais jornada nativa; revisar/commit.
- [ ] Antes de concluir M2, testar mensagem de encaminhamento atrasada com dois workers: envio confirmado antes da atribuição ou cancelamento/incerteza visível conforme deadline, nunca perda silenciosa. Testar takeover humano durante a barreira: nenhum novo despacho automático depois de conhecida a assunção.

## R5 — retorno ao bot, resolução e ciclos de conversa

**Dependência:** R2/R3/R4.
**Modificar:** `apps/api/src/modules/automations/{engine,repository,service}.ts`, `apps/api/src/modules/integrations/chatwoot-worker.ts`.
**Criar:** `apps/api/src/modules/attendance/lifecycle-service.ts`; migration nova para histórico de ciclos/mapeamentos, preservando registros atuais.
**Testes novos:** `apps/api/tests/integration/attendance-resume.test.ts`, `chatwoot-resolved-reopen.test.ts`, `attendance-cycle-isolation.test.ts`.
**Interface:** `resumeAttendance(scope: AttendanceScope, input: {sessionId: string; expectedRevision: number; target: ResumeTarget; actorId: string; idempotencyKey: string}): Promise<AttendanceSession>`.

- [ ] Testar retorno CONTINUE com ponto persistido; MENU com nó válido; NEW_SESSION com versão ativa escolhida no servidor. Sem ponto de retorno, CONTINUE deve recusar, não completar silenciosamente.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/attendance-resume.test.ts`; documentar falha atual de nodeId nulo/HUMAN.
- [ ] Coordenar permissão, revisão, sessão, modo de mensagem e estado remoto. Pending sozinho não autoriza retomada. Manter rota antiga como adaptação explícita ou erro de migração, sem dois caminhos divergentes.
- [ ] Implementar política NEW/REOPEN por caixa e ciclo; mapeamento único antigo não pode redirecionar um atendimento novo para uma conversa resolvida inadvertidamente.
- [ ] Testar evento tardio de ciclo antigo, mesmo contato em duas caixas, publicação durante atendimento, resolução repetida, retorno duplicado e agente revogado. CSAT tem um responsável, somente nos formatos homologados.
- [ ] Rodar os três arquivos e teste de upgrade; revisar/commit.

## R6 — blocos de conversa, horários, mídia e ações na central

**Dependência:** U1, R2–R5.
**Modificar:** `apps/api/src/modules/automations/{types,engine,repository}.ts`, `apps/api/src/commands/scheduler-worker.ts`, `apps/api/src/modules/messaging/worker.ts`; adaptadores de mídia existentes.
**Criar:** `apps/api/src/modules/automations/business-hours.ts`, `input-policy.ts`; ações tipadas no dispatcher de R4.
**Testes novos:** `apps/api/tests/unit/automation-input-policy.test.ts`, `automation-business-hours.test.ts`; `apps/api/tests/integration/automation-silence.test.ts`, `automation-media-attendance.test.ts`.
**Interface:** estender RuntimeInput/RuntimeEffect versionados para mídia e ações CHATWOOT_LABEL, CHATWOOT_ATTRIBUTE, CHATWOOT_NOTE, CHATWOOT_RESOLVE. Payloads validados pelo catálogo U1; não passar JSON remoto arbitrário.

- [ ] Testar menu/input: tentativas máximas obrigatórias quando há repetição, saídas invalid/exhausted/timeout e validação por tipo. Assert: o silêncio só dispara uma vez e resposta concorrente cancela timer vencedor.
- [ ] Rodar os testes novos focais; implementar deadlines persistidos e relógio injetável, sem setTimeout em memória como fonte única de verdade.
- [ ] Implementar horário com fuso IANA, intervalos semanais e exceções por data; modo fora de expediente é escolha explícita. Conferir mudança de dia/fuso e ausência da central para evitar duas saudações.
- [ ] Implementar enviar/receber anexos nos tipos suportados: referência de mídia pertence à empresa, limites reais do canal, preparação e rechecagem antes do envio. Transporte atual de mídia não é prova de bloco pronto.
- [ ] Implementar etiquetas/atributos/nota interna/encerramento como ações dedicadas; validar catálogo, preservar etiquetas alheias e jamais enviar nota interna ao WhatsApp.
- [ ] Rodar arquivos novos, `automation-engine.test.ts` e matriz de mídia existente; revisar/commit.

## R7 — consulta HTTP e IA delimitada para atendimento

**Dependência:** U1, R2/R4/R6. Não implementar SQL/JavaScript genérico como requisito desta tarefa.
**Modificar:** `apps/api/src/modules/automation-integrations/{safe-http,credentials,ai,data-nodes}.ts`, `apps/api/src/commands/automation-io-worker.ts`.
**Testes novos:** `apps/api/tests/unit/automation-http-attendance.test.ts`, `automation-ai-attendance.test.ts`; ampliar safe-http/ai existentes.
**Interface:** schemas U1 produzem requests tipados com referência de credencial; resultado I/O é discriminado SUCCESS, CLIENT_ERROR, SERVER_ERROR, TIMEOUT, UNKNOWN. IA: geração, classificação, extração e resumo; ferramenta não homologada não é disponibilizada.

- [ ] Testar objeto/lista sem truncamento, segredo de outro tenant negado, API lenta/indisponível e resposta grande. Rodar `npm test -- apps/api/tests/unit/automation-http-attendance.test.ts`.
- [ ] Expor corpo/query/headers permitidos, timeout e mapeamento tipado mantendo proteção de rede/redirect/DNS. Não permitir reenvio automático de efeito incerto; consultas de atendimento não habilitam alterações financeiras arbitrárias.
- [ ] Testar saída IA fora do schema, limite de tokens/chamadas, modelo indisponível e resposta que chega após humano assumir. Validar regras no servidor.
- [ ] Medir uso real de tokens quando fornecido; custo desconhecido permanece desconhecido. `costMicros:0` não é evidência de custo zero. Limites monetários só são anunciados quando a medição/cálculo for confiável.
- [ ] Encaminhar erros pelos ramos configurados, inclusive humano. Agent tools genérico fica indisponível até registro, autorização, execução e retorno ao modelo testados.
- [ ] Rodar arquivos novos e regressões safe-http/ai/credentials; revisar/commit.

## R8 — confiabilidade dos workers e diagnóstico do atendimento

**Dependência:** R1–R7; integra com A6/A7, sem reimplementar seu painel.
**Modificar:** `apps/api/src/modules/automations/{repository,service,availability}.ts`, `apps/api/src/modules/observability/service.ts`, workers existentes.
**Criar testes:** `apps/api/tests/integration/attendance-worker-recovery.test.ts`, `attendance-outbox-ordering.test.ts`, `attendance-tenant-fairness.test.ts`. A ordenação mínima já é entregue em R2/R4; estes arquivos ampliam a cobertura de falhas e carga.
**Interface:** métricas/contexto padronizados por sessionId, cycle, version, ownerRevision, messageId e handoffOperationId; conteúdo sensível omitido. Resultados UNKNOWN não somem da fila.

- [ ] Testar dois workers, expiração de lease, restart entre efeito/resposta e lote de uma empresa atrasando outra. Assert: ordem por sessão e progresso da empresa com menor volume.
- [ ] Rodar `npm run test:integration -- apps/api/tests/integration/attendance-outbox-ordering.test.ts apps/api/tests/integration/attendance-worker-recovery.test.ts`.
- [ ] Ajustar claim/settle e drenagem; manter ordenação por turno e revisão, usar backoff/classificação de falha. Evitar lock transacional longo durante rede.
- [ ] Medir atraso/backlog/retry/unknown/handoff/esperas e sinais de worker. Distinguir pronto para editar, pronto para publicar e entrega externa comprovada.
- [ ] Executar a jornada standalone nova de A8 com adaptador controlado; registrar que mocks não certificam central real.
- [ ] Revisar métricas/segredos e rodar regressões + integração; commit. Carga e prova externa continuam gates A7/A8.

## Verificação deste plano

Os arquivos de teste marcados como novos não existem até a tarefa correspondente. Comandos de integração exigem `TEST_DATABASE_ADMIN_URL` e ambiente descartável; os helpers criam bancos isolados. Não marcar falha de setup como regressão comprovada nem como teste aprovado.

Ao final R1–R8: nenhum HANDOFF é concluído só por mudar modo local; nenhuma sessão nova é criada apenas porque a anterior está RUNNING; nenhum retorno ao bot é apenas trocar status remoto. O aceite completo é G01–G12 do plano principal.
