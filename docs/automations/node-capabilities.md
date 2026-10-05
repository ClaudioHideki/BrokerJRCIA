# Catálogo de blocos — contrato 1

Disponibilidade significa criação no Studio. A definição é versionada e distinta dessa disponibilidade: grafos existentes conservam dados, portas, exportação e semântica do executor publicado. O parser histórico de Flow não foi alterado. Novas famílias sem executor têm diagnóstico `RUNTIME_UNAVAILABLE`; famílias históricas retiradas da paleta continuam executáveis.

| Tipo | Criação | Formulário | Execução/simulação |
| --- | --- | --- | --- |
| start | AVAILABLE | FlowCanvas: nome | engine: início sem efeito |
| message | AVAILABLE | FlowCanvas: mensagem | engine: SEND_TEXT simulado |
| input | AVAILABLE | FlowCanvas: pergunta/variável | engine: espera/resposta |
| menu | AVAILABLE | FlowCanvas: texto/opções/variável | engine: espera/opção numerada |
| condition | AVAILABLE | FlowCanvas: campo/comparação/valor | engine: yes/no |
| variable | AVAILABLE | FlowCanvas: variável/valor | engine: interpolação no estado |
| handoff | AVAILABLE | HandoffEditor: catálogo da caixa e time ou agente | engine: HANDOFF_PENDING simulado; worker: confirmação remota |
| end | AVAILABLE | FlowCanvas: nome | engine: fim da execução do bot |

Os formulários simples acima são os existentes; o menu visual com adicionar/remover/reordenar opções faz parte de U3a. `end` encerra o bot, não resolve a conversa na central.

| Tipos | Criação | Pendência |
| --- | --- | --- |
| delay | UNAVAILABLE | R4/U5: silêncio e simulação com relógio |
| subflow | UNAVAILABLE | R6/U3b/U5: seleção e simulação das dependências publicadas |
| data-set, data-rename, data-pick, data-merge, data-map, data-filter, json-parse, json-stringify, expression | UNAVAILABLE | R6/U3b: dados e formulários completos |
| http | UNAVAILABLE | R7/U3b/U5: consulta delimitada, credenciais e simulação |
| ai-generate, ai-classify, ai-extract, ai-summarize | UNAVAILABLE | R7/U3b/U5: IA delimitada e simulação |
| sql, code, ai-agent | UNAVAILABLE | Fora do escopo de criação Broker; compatibilidade histórica mantida |
| media, schedule, tag, attribute, note, resolve | UNAVAILABLE | R3–R7/U3b: catálogo, executor, formulário e simulação pendentes |

Evidências automatizadas: `packages/contracts/tests/automation-node-definitions.test.ts` verifica catálogo/portas/campos/matriz; `apps/api/tests/unit/automation-engine.test.ts` executa cada tipo AVAILABLE pelo mesmo motor puro usado na simulação e preserva SQL histórico; `apps/api/tests/unit/automation-conversation-simulation.test.ts` verifica continuação conversacional; `apps/web/src/pages/AutomationStudio.test.tsx` abre cada formulário AVAILABLE e verifica diagnóstico por ID. HTTP e cliente validam transporte de diagnósticos.

`validateAutomationGraph` retorna `{nodeId, field, code, message}[]`. Erros globais usam `nodeId: null`. A API de validação retorna `diagnostics` e mantém `errors` via `nodeDiagnosticsToStrings`. Problemas HTTP retornam `diagnostics`, `details` estruturados e `legacyErrors`. Clientes antigos só com strings passam por `legacyStringsToNodeDiagnostics`, sem inferência insegura do ID pelo nome. A migração legada usa explicitamente o adaptador para seu relatório histórico de strings.

A configuração nativa de `handoff` é explicitamente versionada (`handoffVersion: 1`). Requer uma caixa do tenant e um único destino: time **ou** agente. A simulação não faz chamada externa nem comprova transferência. Novas publicações e ativações revalidam catálogo, credencial, vínculo e política da caixa. Grafos históricos sem destino permanecem legíveis; sua publicação nova exige configurar o destino e sua execução antiga nunca produz confirmação remota fictícia. Consulte [limites e homologação do incremento nativo](native-handoff.md).
