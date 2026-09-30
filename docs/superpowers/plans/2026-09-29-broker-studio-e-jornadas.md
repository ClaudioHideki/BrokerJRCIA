# Broker — Studio e jornadas do cliente — plano de implementação

> **Para execução por agentes:** usar `superpowers:subagent-driven-development` ou `superpowers:executing-plans`, com teste de comportamento por tarefa e revisão antes de integrar.

**Objetivo:** permitir construir, configurar, simular e operar chatbots de atendimento pelo Broker sem JSON ou IDs manuais.
**Arquitetura:** catálogo tipado comum ao editor e runtime, formulários por família e experiência guiada que reutiliza os serviços do Broker. Rascunho, simulação, publicação, ativação e teste real são ações diferentes.
**Stack:** React/TypeScript, Zod, Testing Library, Vitest e Playwright.
**Spec:** [Escopo](../specs/2026-09-29-broker-first-completion-design.md).
**Programa:** [Plano principal](2026-09-29-broker-first-completion.md).

## Restrições globais

- Concluir e homologar o Broker independente; depois construir os módulos Flow e QR dentro de JRC Conversas/Chatwoot.
- Um único executor de bot por caixa.
- Cada bloco disponível tem formulário, contrato, validação, executor, simulação e teste.
- Não há execução de JSON arbitrário nem promessa de equivalência integral n8n.
- Não incluir payloads privados, credenciais ou IDs operacionais de clientes nos exemplos.
- A simulação não faz chamadas externas nem enfileira mensagens reais.

## Foco da revisão

Destino apagado enquanto o formulário está aberto (U3/U4); importação preserva desenho mas perde semântica (U6); zoom altera posição salva sem edição (U2); duplo clique duplica publicação/importação (U4/U6); papel revogado deixa botão operável no browser (U3/U7). Fixar na API além da UI.

## U1 — catálogo tipado e disponibilidade por capacidade

**Dependência:** B0; sincronizar nomes com R1/R6/R7.
**Modificar:** `packages/contracts/src/automations-v1.ts`, `flows.ts`, `index.ts`; `apps/api/src/modules/automations/{engine,service}.ts`, `apps/api/src/http/routes/automations.ts`, `apps/web/src/automations/api.ts`, `apps/web/src/pages/AutomationStudio.tsx`.
**Criar:** `packages/contracts/src/automation-node-definitions.ts`.
**Testes:** ampliar `packages/contracts/tests/automations-v1.test.ts`, `apps/api/tests/unit/automation-engine.test.ts`; novo `packages/contracts/tests/automation-node-definitions.test.ts`.
**Interface:** `getNodeDefinition(type: string, version: number): AutomationNodeDefinition | null`; definição contém tipo, versão, schema Zod, portas, capabilitiesRequired e estado AVAILABLE/UNAVAILABLE. `validateAutomationGraph(graph): NodeDiagnostic[]`, diagnóstico com nodeId, field, code e mensagem.

- [ ] Fixar testes dos tipos existentes e novos: mensagem, mídia, input, menu, condição, variável/dados necessários, horário, espera, HTTP, IA delimitada, handoff, etiqueta, atributo, nota e resolução. Assert: toda porta exibida existe no contrato e toda configuração ausente tem diagnóstico de campo.
- [ ] Rodar `npm test -- packages/contracts/tests/automation-node-definitions.test.ts`; registrar falha antes da implementação.
- [ ] Consolidar schemas no servidor e importar no editor; não manter lista independente de portas. Versões publicadas antigas mantêm parser/semântica próprios; migrar rascunho explicitamente.
- [ ] Migrar junto os consumidores de validação: AutomationError, resposta de problema/rota, cliente e estado do Studio recebem diagnósticos estruturados. Manter adaptador explícito para clientes que esperam strings durante a transição; testar HTTP e UI e executar typecheck nesta tarefa, sem esperar U3.
- [ ] Retirar da paleta de criação capacidades não completas, sem apagar nós antigos: SQL, Code e Agent genérico ficam identificados conforme matriz real. Preservar exportação/diagnóstico de nós incompletos.
- [ ] Criar `docs/automations/node-capabilities.md` com teste de contrato que verifica componentes/execução/simulação para cada nó AVAILABLE.
- [ ] Rodar contratos/engine/typecheck; revisar e commit após suíte exigida pelo projeto.

## U2 — canvas utilizável e preservação da correção local

**Dependência:** B0; independente de chamadas externas.
**Modificar:** `apps/web/src/flows/FlowCanvas.tsx`, `FlowCanvas.test.tsx`, `flows.css`, `apps/web/src/pages/AutomationStudio.tsx`.
**Criar:** `apps/web/tests/e2e/automation-editor.spec.ts`.
**Interface:** preservar grafo/IDs existentes; estado de viewport não altera o conteúdo sem ação de edição.

- [ ] Revisar o diff local existente de pan/zoom e o teste já escrito; não substituí-lo por nova implementação sem necessidade.
- [ ] Adicionar testes para zoom ancorado, arrastar área vazia, drag de nó após zoom, coordenadas negativas, seleção e ajuste de visão. Assert: navegar e salvar sem editar preserva o grafo.
- [ ] Rodar `npm test -- apps/web/src/flows/FlowCanvas.test.tsx`; reproduzir apenas lacunas reais.
- [ ] Completar desfazer/refazer, duplicar e localizar nó com erro/início; limitar fit-view para não deixar canvas ilegível, mantendo opção de visão geral. Não exigir troca de biblioteca visual para concluir.
- [ ] Rodar `npm run test:e2e -- apps/web/tests/e2e/automation-editor.spec.ts` com 150 nós sintéticos, zoom e edição. Desktop usa pan/roda; mobile mantém acesso legível a navegação e configuração sem depender de hover.
- [ ] Confirmar screenshot/uso real do editor em laboratório, contraste/foco e ausência de corte do inspector; registrar evidência e commit.

## U3 — formulários e seletores de atendimento

**Dependência:** U1, R3; R4–R7 fornecem os executores correspondentes antes de marcar bloco como disponível.
**Modificar:** `apps/web/src/flows/FlowCanvas.tsx`, `apps/web/src/pages/AutomationStudio.tsx`, `apps/web/src/automations/api.ts`; `apps/api/src/http/routes/automations.ts`.
**Criar:** `apps/web/src/automations/node-editors/MenuEditor.tsx`, `InputEditor.tsx`, `HandoffEditor.tsx`, `HttpEditor.tsx`, `AiEditor.tsx`, `MediaEditor.tsx`, `DataReferencePicker.tsx`; testes colocados ao lado. Criar `apps/api/src/modules/automations/editor-catalog.ts`.
**Interface:** catálogo retorna referências autorizadas e nomes; formulários editam somente configurações do schema U1. Credenciais nunca retornam o segredo; destino usa IDs do catálogo R3, não entrada livre.

**Entregas sequenciais:** U3a entrega mensagens, pergunta simples, menu, condição/variável e destino humano para M2, após U1/R3/R4. U3b completa mídia, horário, ações da central, subfluxos, HTTP e IA para M3, após R6/R7. Cada parte só oferece blocos com executor e teste correspondentes.

- [ ] Testar menu com adicionar/remover/reordenar opções sem textarea `valor|rótulo`; preservar portas das opções existentes. Testar seleção de time/agente e falta de acesso.
- [ ] Rodar `npm test -- apps/web/src/automations/node-editors/MenuEditor.test.tsx apps/web/src/automations/node-editors/HandoffEditor.test.tsx`; confirmar falhas.
- [ ] Implementar formulários de mensagens/perguntas/regras, destino humano, mídia, horário/fuso, etiquetas/atributos e dados. Subfluxo seleciona versão publicada da empresa.
- [ ] Expor parâmetros necessários de HTTP/IA, sucessos/erros/timeout e limites; substituir UUID de credencial por seletor. Fonte de dados e campo de destino devem ser selecionáveis com ajuda contextual.
- [ ] Impedir publicação/ativação com destino removido ou incompatível. Revogação do papel com editor aberto deve falhar na API e preservar rascunho local sem anunciar salvo.
- [ ] Rodar testes de cada editor e `AutomationStudio.test.tsx`; demonstrar menu completo com três times sem JSON, chamada de API manual ou UUID digitado; revisar/commit.

## U4 — configuração guiada da caixa e ativação

**Dependência:** U4a configura transporte/conta/caixa após R1/R3 para M1. U4b acrescenta ativação/atendimento após R4/R5/U3a para M2; capacidades adicionais acompanham U3b em M3. Usa as telas existentes, sem construir um segundo painel desconectado.
**Modificar:** `apps/web/src/pages/{Channels,ChannelDetail,Integrations}.tsx`, `apps/web/src/integrations/{ChatwootPanel,ChatwootDestinationPanel}.tsx`, `apps/web/src/channels/api.ts`; ampliar rotas de canais usando serviços R1/R3.
**Criar:** `apps/web/src/channels/AttendanceSetup.tsx`, `AttendanceSetup.test.tsx`; `apps/web/tests/e2e/broker-setup.spec.ts`.
**Interface:** leitura de configuração consolidada apresenta conexão, caixa, executor, versão, destino humano padrão, política NEW/REOPEN e capacidades; salvar/ativar envia expectedRevision e chave idempotente.

- [ ] Testar jornada JRC gerenciado e Meu Chatwoot: solicitação/aprovação do destino, vínculo da Account, criação/adaptação de caixa API, membros e automação. Troca de credencial/caixa após revisão invalida a ativação antiga.
- [ ] Rodar `npm test -- apps/web/src/channels/AttendanceSetup.test.tsx`; estabelecer estado parcial que não pode aparecer como operação concluída.
- [ ] Manter as quatro etapas atuais da conexão e acrescentar configuração dos destinos/regras e teste da jornada. Distinguir cadastro, conectado, vínculo configurado e entrega verificada.
- [ ] Mostrar bot responsável e versão; impedir segundo executor no servidor. Pausar novas entradas, interromper sessão, desativar vínculo e pausar entregas da central devem ter nomes/efeitos diferentes.
- [ ] Antes da ativação, executar checagens sem enviar mensagem automaticamente; teste de entrega é ação separada com recurso escolhido. Reconciliação detecta configuração remota divergente sem sobrescrever silenciosamente webhook/AgentBot.
- [ ] Rodar E2E de setup e HTTP de canais, incluindo duplo clique, revisão antiga e usuário leitor; revisar/commit.

## U5 — simulação e teste real separados

**Dependência:** U1/U3, R2/R4/R6/R7.
**Modificar:** `apps/web/src/pages/AutomationStudio.tsx`, `apps/web/src/automations/AvailabilityNotice.tsx`, `apps/api/src/modules/automations/{service,availability}.ts`, rotas automations.
**Criar:** `apps/api/src/modules/automations/simulation.ts`; `apps/web/src/automations/SimulationPanel.tsx`.
**Testes:** ampliar `apps/api/tests/unit/automation-conversation-simulation.test.ts`, `automation-availability.test.ts`, `apps/web/src/pages/AutomationStudio.test.tsx`.
**Interface:** `simulateConversation({graph, publishedDependencies, inputs, clock, externalResults}): SimulationResult`; inputs e externalResults são fixtures. Antes da execução pura, o servidor autoriza e carrega um snapshot das versões publicadas referenciadas pela empresa; o resolver em memória lê somente publishedDependencies, com limites de profundidade/recursão. Resultado inclui passos/esperas/efeitos simulados/diagnósticos com dados ocultados. Nenhum adapter de rede é injetado.

- [ ] Testar sucesso, inválida, silêncio, horário, HTTP/IA com respostas fictícias, transferência falha e humano assumindo. Assert: `networkCalls === 0` e `realMessageRows === 0`.
- [ ] Testar subfluxo publicado válido, versão ausente, ciclo de dependências e referência a outra empresa. O snapshot mantém versões fixas durante a simulação; ausência/acesso negado produz diagnóstico, sem resolver remoto improvisado.
- [ ] Rodar `npm test -- apps/api/tests/unit/automation-conversation-simulation.test.ts`; reproduzir limite atual em IO/delay.
- [ ] Renomear botão atual de teste puro para Simular; usar o mesmo motor com relógio virtual e adaptadores simulados. Nunca mostrar uma consulta fictícia como validação real da credencial.
- [ ] Implementar teste real separado, por sessão de teste, com caixa/contato de laboratório e efeitos apresentados antes do envio. Reutilizar execução real e auditoria, sem caminho privilegiado.
- [ ] Manter edição/simulação disponíveis segundo papel/plano com runtime desligado; publicar/ativar continuam verificando dependências. Erro tem razão e ação, não apenas indisponível.
- [ ] Rodar testes e E2E do editor; revisar/commit.

## U6 — JSON JRC, exemplos para IA e importação n8n parcial

**Dependência:** U1/R2, blocos liberados em R6/R7.
**Modificar:** `apps/api/src/modules/automation-integrations/importer.ts`, `apps/api/src/http/routes/automation-imports.ts`, serviço/repositório automations, `packages/contracts/src/flows.ts`, `apps/web/src/automations/ImportReview.tsx`, `apps/web/src/pages/NewAutomation.tsx` e seu teste, exportação no Studio. Migration aditiva para vínculo durável artefato → rascunho.
**Criar:** `packages/contracts/src/automation-artifact.ts`; `scripts/generate-automation-json-schema.mjs`; `docs/automations/{jrc-flow-format,generation-prompt}.md`; `docs/automations/examples/{menu-handoff,http-support}.json`; `apps/api/src/modules/automation-integrations/import/n8n/{parser,mappings,report}.ts`.
**Testes novos:** `packages/contracts/tests/automation-artifact.test.ts`, `apps/api/tests/unit/automation-n8n-import.test.ts`; ampliar importer/import-idempotency existentes.
**Interface:** artefato `format: 'jrc-automation'`, `schemaVersion: 1`, nome, grafo com versões dos nós e referências lógicas. `parseAutomationArtifact(input): {draft, diagnostics, requiredMappings}`; exportação não contém credenciais nem vínculos ativos. Esse formato é proposto; manter leitor explícito para `jrc-broker-flows/1`.

- [ ] Testar round-trip preservando nós/configurações/arestas/posição e comportamento simulado, incluindo subfluxo ausente e credencial que deve ser remapeada.
- [ ] Rodar `npm test -- packages/contracts/tests/automation-artifact.test.ts apps/api/tests/unit/automation-n8n-import.test.ts`; distinguir formato não suportado de JSON inválido.
- [ ] Gerar JSON Schema dos contratos U1, validar exemplos na CI e fornecer prompt/documentação de geração por IA. Importação é sempre rascunho, sem publicação, vínculo ou envio.
- [ ] Oferecer os exemplos nativos como modelos iniciais em Nova automação, além de canvas vazio e importação. Criar cópia editável da empresa, exigindo configuração dos destinos/credenciais antes da publicação.
- [ ] No n8n, considerar tipo E typeVersion, preservar proveniência e cada aresta. Mapear apenas semântica equivalente testada; webhook HTTP não equivale automaticamente a mensagem recebida, nem resposta HTTP a enviar WhatsApp.
- [ ] Subconjunto inicial: texto literal, condições/menu adaptável, HTTP de consulta e espera quando comprovados. Expressões/código/Redis/Agent complexos mantêm diagnóstico; não converter para no-op. Nós desabilitados continuam inertes.
- [ ] Relatório oferece equivalente testado, configurar, adaptar, não suportado, com nó/campo/ação; versões desconhecidas bloqueiam publicação. Usar fixtures sintéticas, não copiar JSONs privados.
- [ ] Unificar a confirmação das duas etapas existentes: armazenar artefato de importação e criar automação editável. Uma confirmação autenticada/idempotente persiste artifactId → automationId em transação; repetir confirma o mesmo rascunho. NewAutomation usa o resultado persistido, sem nova chave aleatória de criação após reload. Testar falha/recarregamento entre revisão, confirmação e navegação, incluindo duplo clique concorrente.
- [ ] Rodar importer, integração de idempotência e exemplos gerados. Repetir importação com mesma chave não duplica rascunho; revisar/commit.

## U7 — operação, histórico, ajuda e coerência dos portais

**Dependência:** U4/U5/U6 e dados A3/A6/R8.
**Modificar:** `apps/web/src/pages/{AutomationStudio,OperationalHealth,ChannelDetail}.tsx`, `apps/web/src/platform/CompanyWorkspace.tsx`, componentes de execução existentes.
**Criar:** `docs/operations/broker-attendance-guide.md`, `apps/web/tests/e2e/standalone-attendance.spec.ts`; extrair componentes do Studio somente por responsabilidade necessária.
**Interface:** UI consome sessão, versão, operação de handoff e diagnóstico existentes; não cria uma segunda fonte de estado.

- [ ] Testar histórico com espera, falha, UNKNOWN, humano e retorno; visitante sem permissão não vê conteúdo/ações da outra empresa. Mudança de organização limpa estados de formulário antigos.
- [ ] Rodar `npm run test:web`; adicionar cenários específicos antes das correções.
- [ ] Exibir início, último evento, bloco atual, versão, motivo de pausa, destino humano e próximo passo. Logs de consulta/IA ocultam conteúdo sensível por padrão; acessos administrativos são auditados.
- [ ] Guiar administrador e empresa com exemplos de caixa, time e bot. Separar chamados de suporte de intervenção administrativa e erros do canal.
- [ ] Completar mensagens de erro acionáveis, navegação, foco, estados vazios/carregamento e acessibilidade desktop/mobile. Não colocar detalhes de worker/migration no fluxo comum do cliente.
- [ ] Rodar `npm run test:e2e -- apps/web/tests/e2e/standalone-attendance.spec.ts`: montar URA, publicar, vincular, conversar, encaminhar e retornar usando API de teste/adaptadores controlados. Evidência externa real é A8.
- [ ] Atualizar guia com exatamente as telas entregues e limites do canal; revisar/commit.

## Resultado esperado

M2 demonstra URA nativa funcional; M3 completa os blocos de atendimento anunciados. O plano não depende de importar integralmente os workflows n8n nem de instalar editor dentro do JRC. Essas telas não serão chamadas prontas apenas porque o JSX ou o botão existe.

