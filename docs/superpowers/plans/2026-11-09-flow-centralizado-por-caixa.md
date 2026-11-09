# Flow por caixa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar/importar um modelo reutilizável e ativá-lo em caixas distintas pelo painel Flow, com menus e transferência para os agentes efetivamente autorizados no JRC.

**Architecture:** Rotas lógicas opt-in no modelo; perfis imutáveis por organização/canal/modelo/versão. O servidor prepara o diretório fora da transação, captura-o na sessão e resolve a escolha em handoff canônico V1; o despacho revalida também a participação no time. Modelos V1/V2 permanecem intactos.

**Tech Stack:** TypeScript, Zod, Fastify, PostgreSQL/RLS, React, Vitest.

**Spec:** docs/superpowers/specs/2026-11-09-flow-centralizado-por-caixa-design.md (aprovado pelo usuário em 09/11/2026).

## Global Constraints

- Não alterar GoPure nem serviços de clientes; trabalho no worktree isolado codex/flow-por-caixa-20261109, base 2d30a5a.
- Preservar contratos estáticos V1/V2, versões publicadas e controle humano. Não contornar ATTENDANCE_HANDOFF_CONTEXT_CHANGED.
- Uma transferência resolve um time OU um agente. JRC continua a fonte de membros; nenhuma concessão silenciosa.
- Sem credenciais no modelo, perfil, log ou export. Sem chamadas HTTP sob locks do banco.
- Publicar/ativar não retoma conversas humanas. Alterações de perfil não cancelam sessões em andamento.
- npm test e git diff --check antes de commit. Nova implantação compartilhada exige release concreta aprovada.

## Review Focus

- Resposta numérica após reordenação: preservar o destinatário oferecido, inclusive após serialização e retry.
- Agente revogado entre menu e atribuição: bloquear sem escolher substituto; conferir time e caixa.
- Duas configurações concorrentes: CAS, atomicidade e idempotência sem ativação parcial.
- Grafos importados com padrões parecidos/subflows: conversão inequívoca ou pendência explícita, nunca destino oculto.
- Troca de empresa, credencial ou caixa durante catálogo/preflight: rejeitar dados antigos e impedir exposição cruzada.

### Task 1: Contratos e resolução de diretório

**Files:** criar packages/contracts/src/automation-box-routing.ts; alterar index.ts, automation-handoff-v1.ts, automation-node-definitions.ts; criar apps/api/src/modules/automations/box-directory.ts e apps/api/tests/unit/automation-box-directory.test.ts.

**Interfaces:** produz RouteHandoffV3Schema, DirectoryMenuSchema, BoxRoutingConfigSchema, BoxDirectorySnapshotSchema; resolveBoxDirectory(config, catalog, teamMembers) gera snapshot sem e-mails, resolveRouteHandoff(snapshot, routeKey, agentId?) gera V1. Rotas são declaradas em start.data.boxRoutes, IDs humanos só no perfil/snapshot.

- [ ] Escrever testes de interseção time/caixa, ordem explícita, dois destinos, duplicados/lista vazia/limite9, schema estrito e compatibilidade V1/V2.
- [ ] Rodar `npx vitest run apps/api/tests/unit/automation-box-directory.test.ts --maxWorkers=2`; Expected: FAIL por módulo ausente.
- [ ] Implementar schemas e resolvedor; máximo9 pessoas + retorno, nomes até120, texto total até4096; rejeitar excessos sem corte.
- [ ] Rodar o mesmo teste; Expected: PASS.

### Task 2: Menus e snapshots no motor

**Files:** alterar automations/types.ts, engine.ts; criar unit/automation-box-runtime.test.ts.

**Interfaces:** RuntimeState.boxDirectory captura snapshot de perfil por sessão; RuntimeInput.boxDirectory é interno do servidor. Bloco directory-menu com saídas selected/back/exhausted/timeout; handoffVersion3 referencia routeKey e seleção em estado interno. Efeito final V1 preserva destinatário fixo e metadado interno de autorização de time no estado da sessão.

- [ ] Testes RED: PT/EN, voltar/inválido/timeout, snapshot após reordenação, falha sem perfil, limite de estado, V1/V2 intactos.
- [ ] Rodar `npx vitest run apps/api/tests/unit/automation-box-runtime.test.ts --maxWorkers=2`; Expected: FAIL.
- [ ] Implementar menu com waitId/deadline/attempts, seleção ligada ao snapshot e confirmação por nome real; sem destinatário arbitrário.
- [ ] Repetir teste e suites menu/handoff existentes; Expected: PASS.

### Task 3: Perfil persistente, preflight e ativação

**Files:** migration 0085_automation_box_routing.sql; criar automations/box-routing-service.ts; integrar service.ts, attendance/handoff-binding.ts, handoff-service.ts, app.ts, commands/automation-worker.ts, integrations/runtime.ts e composição canônica aplicável.

**Interfaces:** createBoxRoutingService oferece catalog/get/save/prepareBinding/prepareSession/assertDispatch. Catálogo via contexto e cliente Chatwoot existentes. Perfil CAS imutável por canal/modelo/versão, revisão atual separada do owner. prepareBinding materializa destinos para readiness existente; assertCurrent verifica escopo/perfil na transação. Snapshot de sessão preparado fora da transação e gravado atomicamente com resultado.

- [ ] Testes RED de escopo, CAS/concorrência, revisão, rollback e idempotência; agente revogado/time alterado; nenhum HTTP dentro de transação.
- [ ] Rodar testes novos de serviço e PostgreSQL; Expected: FAIL.
- [ ] Implementar RLS/FKs e serviços, mantendo caminhos legados; publicar modelo lógico sem destino, vincular somente perfil válido e readiness remoto.
- [ ] Rodar testes serviço/runtime/handoff/integração; Expected: PASS ou registrar dependência externa indisponível sem declarar validação.

### Task 4: Modelo reutilizável e conversão explícita OIA

**Files:** criar contracts/automation-box-template.ts; alterar catálogo de modelos/importação e rotas necessárias; testes contracts/API.

**Interfaces:** convertOiaToBoxTemplate(graph) produz novo grafo/rotas somente quando menus, arestas e confirmações correspondem ao padrão inequívoco; caso contrário retorna pendências. Nunca modifica grafo de entrada nem versão publicada. Criação de template usa os mesmos contratos do motor.

- [ ] Testes RED: OIA PT/EN, retorno, expediente/inatividade preservados, nomes antigos removidos, importação ambígua/subflow rejeitada e versão original intacta.
- [ ] Rodar teste de conversão; Expected: FAIL.
- [ ] Implementar conversão e criação explícita de novo rascunho; integrar modelos existentes sem mudar padrão antigo.
- [ ] Repetir testes OIA/importação/validação; Expected: PASS.

### Task 5: Painel Flow único

**Files:** criar web/automations/BoxRoutingPanel.tsx e testes; alterar pages/AutomationStudio.tsx, NewAutomation.tsx, ChannelDetail.tsx, automations/api.ts; routes/automations.ts.

**Interfaces:** endpoints autenticados sob /v1/automations/:id/channels/:channelId/box-routing e catálogo; novo painel escolhe versão/caixa, departamentos/times, todos elegíveis ou subconjunto ordenado, prévia PT/EN e ativação com revisão esperada. Canal aponta ao painel filtrado. Diagnóstico distingue configuração, admissão, execução e entrega.

- [ ] Testes RED de fluxo de configuração, permissões, stale response após troca de empresa, pendências e ativação bloqueada sem perfil.
- [ ] Rodar testes UI/API novos; Expected: FAIL.
- [ ] Implementar painel e navegação, importação/conversão, preflight e mensagens legíveis. Links para membros JRC, sem copiar usuários nem tokens.
- [ ] Rodar testes UI/API existentes e novos; Expected: PASS.

### Task 6: Verificação integrada e entrega

**Files:** documentação operacional e relatório; bundle nativo/manifests somente se necessário pelo contrato.

**Interfaces:** uma fonte backend para web e delegação nativa; compatibilidade de consumidores antigos falha de modo seguro para novos nós desconhecidos.

- [ ] Executar typecheck/build, testes dirigidos, npm test com PATH Git/OpenSSL correto, git diff --check e testes PostgreSQL possíveis. Expected: resultados reais registrados, sem atribuir falhas ambientais ao produto.
- [ ] Revisão fresca do branch conforme requesting-code-review, corrigir itens importantes com RED/GREEN e suite.
- [ ] Commit somente após checks exigidos; preparar artefatos e manual de produção. Não declarar deploy/teste WhatsApp novo nem imagem publicada sem evidência.

## Plano revisto

Cobertura: spec1–4 task5, spec5–6 tasks1–3, spec7 task4, spec8 tasks3/5, spec9 task6, spec10 tasks1–6, spec11 task6. Interfaces compartilhadas: contracts→runtime→perfil→UI; snapshot imutável evita alterar o grafo publicado. Execução inline escolhida dentro da autorização de implementação.
