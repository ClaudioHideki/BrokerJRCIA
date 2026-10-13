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
| data-set | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| data-rename | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| data-pick | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| data-merge | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| data-map | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| data-filter | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| json-parse | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| json-stringify | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| expression | AVAILABLE | DataNodeEditor: fonte, destino, erro e campos tipados | engine/simulação: transformação local tipada; success/error |
| http | AVAILABLE | HttpQueryEditor: credencial por nome, destino HTTPS e parâmetros | IO_HTTP canônico; política atual; cinco saídas e resposta fictícia limitada |
| delay | AVAILABLE | FlowCanvas: segundos | engine: prazo persistido; scheduler; simulação por tempo virtual |
| subflow | AVAILABLE | SubflowEditor: nome e versão publicada, com paginação | snapshot imutável comum a validação, simulação, publicação e worker; retorno next |
| handoff | AVAILABLE | HandoffEditor: catálogo da caixa e time ou agente | engine: HANDOFF_PENDING simulado; worker: confirmação remota |
| end | AVAILABLE | FlowCanvas: nome | engine: fim da execução do bot |
| schedule | AVAILABLE | ScheduleEditor: fuso, semana e exceções por data | engine: open/closed pelo instante fornecido; simulação com relógio virtual |

Os formulários simples acima são os existentes; o menu visual com adicionar/remover/reordenar opções faz parte de U3a. `end` encerra o bot, não resolve a conversa na central.

| Tipos | Criação | Pendência |
| --- | --- | --- |
| ai-generate, ai-classify, ai-extract, ai-summarize | UNAVAILABLE | R7/U3b/U5: IA delimitada e simulação |
| sql, code, ai-agent | UNAVAILABLE | Fora do escopo de criação Broker; compatibilidade histórica mantida |
| media, tag, attribute, note, resolve | UNAVAILABLE | R3–R7/U3b: catálogo, executor, formulário e simulação pendentes |

Evidências automatizadas: `packages/contracts/tests/automation-node-definitions.test.ts` verifica catálogo/portas/campos/matriz; `apps/api/tests/unit/automation-engine.test.ts` executa cada tipo AVAILABLE pelo mesmo motor puro usado na simulação e preserva SQL histórico; `apps/api/tests/unit/automation-conversation-simulation.test.ts` verifica continuação conversacional; `apps/web/src/pages/AutomationStudio.test.tsx` abre cada formulário AVAILABLE e verifica diagnóstico por ID. HTTP e cliente validam transporte de diagnósticos.

`validateAutomationGraph` retorna `{nodeId, field, code, message}[]`. Erros globais usam `nodeId: null`. A API de validação retorna `diagnostics` e mantém `errors` via `nodeDiagnosticsToStrings`. Problemas HTTP retornam `diagnostics`, `details` estruturados e `legacyErrors`. Clientes antigos só com strings passam por `legacyStringsToNodeDiagnostics`, sem inferência insegura do ID pelo nome. A migração legada usa explicitamente o adaptador para seu relatório histórico de strings.

A configuração nativa de `handoff` é explicitamente versionada (`handoffVersion: 1`). Requer uma caixa do tenant e um único destino: time **ou** agente. A simulação não faz chamada externa nem comprova transferência. Novas publicações e ativações revalidam catálogo, credencial, vínculo e política da caixa. Grafos históricos sem destino permanecem legíveis; sua publicação nova exige configurar o destino e sua execução antiga nunca produz confirmação remota fictícia. Consulte [limites e homologação do incremento nativo](native-handoff.md).

Os novos blocos de dados gravam `configVersion: 2`, com literal JSON ou variável existente, limites de 64 KiB por valor e saídas success/error. Erro preserva o destino e grava somente um código seguro; caminhos de campos não são confundidos com nomes planos de variáveis. Sem marker, as publicações históricas mantêm parser, coerção e porta next. O editor preserva valores importados além de oito níveis/64 campos por nível; o contrato continua limitado a 64 níveis e 64 KiB. Não há rede, SQL, JavaScript ou IA nesses blocos.

O corte P3 de subfluxos usa catálogo paginado de metadados por empresa e automação raiz, versões JSON publicadas e referências exatas, sem assumir versão 1. Validação, simulação e execução de raízes com política 1 usam o mesmo snapshot de dependências no motor canônico; o snapshot não consulta rede e reusa grafos imutáveis. Novas publicações recebem pelo servidor `dependencyPolicyVersion: 1` no bloco start, dentro do checksum, com até oito chamadas simultâneas, 32 versões únicas incluindo a raiz e 2 MiB agregados em UTF-8. O campo é interno e não aparece no formulário comum. A publicação revalida dependências dentro da transação final; filhas arquivadas não podem entrar em publicação nova.

Raízes históricas sem esse marcador conservam seu grafo, checksum e referências fixadas, inclusive filhas arquivadas. A política da raiz permanece para toda a pilha e após espera/reinício, independentemente da política de uma filha. Entradas seguem a semântica atual do runtime JSON; pai e filha compartilham variáveis, e o retorno usa a porta next existente. A criação de subflow foi habilitada após revisão independente e testes do corte, inclusive persistência PostgreSQL. A release deve passar no CI da main antes da instalação; a integração delegada por caixa na central tem seu próprio escopo de autorização.

O bloco HTTP usa `httpConfigVersion: 1` para consulta GET HTTPS fixa, parâmetros codificados, credencial por nome/tipo/revisão e origins permitidos por empresa. Validação, publicação e despacho revalidam a política; a transação final de publicação bloqueia compartilhada a linha da credencial, enquanto alterações/revogação usam bloqueio exclusivo e revisão. A simulação aceita somente resposta fictícia limitada para o bloco HTTP exato em espera e não chama transporte. Métodos e UNKNOWN históricos sem marker são preservados. Consulte [configuração e limites de HTTP](http-query-v1.md). A criação foi habilitada após revisão independente e testes focais; a instalação depende da imagem aprovada no CI da main.
