# Fase 5 — Automation Runtime v2

Data: 2026-09-21
Branch: `codex/jrc-platform-v2-phase5-automation-runtime-20260921`

## Resultado

Foi criado um runtime canônico, versionado e durável ao lado do motor legado. O Broker agora possui definições e versões de automação, bindings fixados em versão, execução recuperável, waits persistentes, log por node e outbox. O binding decide qual motor atende o canal; nenhuma tabela de Flow foi removida.

## Modelo e isolamento

A migração `0026_automation_runtime_v2.sql` adiciona:

- `automation_definitions` e `automation_versions`;
- `automation_bindings`;
- `automation_executions` e `automation_node_executions`;
- `automation_events`;
- `automation_waits`;
- `automation_outbox`;
- descoberta limitada de organizações para workers.

Todas as tabelas carregam `organization_id`, usam RLS forçada e concedem acesso somente ao papel necessário. `jrc_app` não possui `UPDATE` ou `DELETE` sobre versões publicadas.

## Semântica entregue

- Draft mutável com revisão otimista.
- Publicação gera versão imutável e checksum SHA-256 canônico.
- Binding fixa a versão usada pelo canal.
- Execução registra a versão, correlação, estado e cada node executado.
- `input`/`menu` persistem espera por evento; `delay` persiste `wake_at`.
- Scheduler retoma delays sem manter processo aberto.
- Handoff gera efeito durável e muda a conversa para atendimento humano.
- Subflow exige versão explícita e rejeita recursão.
- Evento canônico duplicado é descartado antes de criar outra execução.
- Efeitos externos passam por outbox. O item é marcado `UNKNOWN` antes da chamada; resposta perdida ou crash não provoca reenvio cego.
- Falha comprovadamente anterior ao envio pode voltar a `PENDING`.
- Retry manual de execução `UNKNOWN` é recusado e exige reconciliação.

## Fronteiras e workers

- `AutomationService`: drafts, publicação, versões e bindings.
- `ExecutionService`: claim, execução, waits, cancelamento, retry seguro e resume explícito.
- `EventRouter`: deduplicação e ordenação por conversa em espera.
- `OutboxDispatcher`: fronteira de efeito externo com estado incerto persistido.
- `AutomationRepository`: único acesso do módulo às tabelas do runtime.
- `automation-worker`: executa jobs e despacha efeitos para a outbox de mensageria.
- `scheduler-worker`: libera waits de tempo vencidos.
- `messaging-worker`: encaminha mensagens de bindings `jrc-automation-v2` ao EventRouter.

## API

Foram adicionadas as rotas canônicas:

- `/v1/automations`, `/v1/automations/:id`;
- validação, simulação e publicação;
- histórico de versões e bindings;
- `/v1/executions`, detalhe, cancelamento, retry e resume.

As rotas usam sessão tenant, revalidam o papel atual, recusam escrita por `VIEWER`, respondem sem cache e fazem parte do inventário explícito de segurança. `/v1/flows` continua disponível para rollback e compatibilidade.

## Configuração e rollback

- `AUTOMATION_RUNTIME_V2_ENABLED=false` é o padrão.
- O compose adiciona `automation-worker` e `scheduler-worker` usando a mesma imagem da API.
- Para ativar: aplicar `0026`, subir os dois workers, conferir saúde e então definir a flag como `true`.
- Para rollback: desativar a flag e manter/reapontar bindings para Flow/Typebot legado. A migração é aditiva e não precisa ser revertida fisicamente.

## Validação

- `npm run typecheck`: aprovado.
- Build de produção: aprovado.
- Testes focados do runtime, outbox, deduplicação, API, worker e migração: 6 arquivos, 10 testes aprovados.
- OpenAPI, inventário de segurança, PDF reproduzível e compose: 5 arquivos, 33 testes aprovados.
- Suíte completa: 168 arquivos e 1.144 testes aprovados.
- Integração PostgreSQL real: não executada porque `TEST_DATABASE_ADMIN_URL` e Docker local não estão disponíveis; a migração foi verificada por contrato estático e será exercitada no gate de ambiente.

## Limites desta fase

- O editor visual e o explorador completo pertencem às Fases 6 e 8.
- Nodes HTTP, código, SQL e IA pertencem à Fase 7.
- A migração automática dos Flows antigos pertence à Fase 9.
- Não houve deploy, migração de produção ou uso de credenciais reais.
