# JRC Flow funcional — plano de implementação

> **Ordem atualizada pelo usuário em 29/09:** este documento é insumo histórico do [programa Broker primeiro](2026-09-29-broker-first-completion.md). Finalizar e homologar o Broker standalone antes de desenvolver os módulos Flow e QR dentro da central. A delegação não avança em paralelo ao marco Broker; aplicar as prioridades e os planos detalhados do programa novo.

> Para execução: testes de comportamento antes da implementação e revisão por entrega. A revisão de 29/09 abaixo define a prioridade de atendimento sobre as extensões genéricas deste plano.

**Objetivo:** permitir criar, configurar, testar, publicar e operar chatbots de atendimento e URAs conversacionais, integrados a caixas, times e agentes do JRC Conversas/Chatwoot. Importar JSON nativo e um subconjunto documentado de n8n é complementar.
**Arquitetura:** contrato versionado compartilhado entre editor, validador, importador e motor; execução no servidor com estado persistente e operações externas nos workers existentes.
**Stack:** React/TypeScript, contratos Zod, API e workers existentes, PostgreSQL e Redis. React Flow é candidato para a camada visual, sujeito a prova de migração.
**Especificação:** requisitos do usuário nesta conversa e decisões abaixo. Data: 29/09/2026.

## Revisão de escopo: atendimento por caixa

O usuário esclareceu que o objetivo é chatbot e atendimento ao cliente, incluindo menu, perguntas, consultas, IA, fila e encaminhamento humano. Não é necessário reproduzir a plataforma n8n. O inventário técnico abaixo permanece útil, mas memória genérica, SQL, JavaScript e conversão ampla não bloqueiam a primeira entrega de atendimento.

Referência operacional e técnica: [Chatbots, caixas e atendimento](../../integrations/2026-09-29-chatbots-inboxes-routing.md). Esse documento distingue recursos comprovados no código, dependências de configuração e lacunas de implementação.

Achados que passam a orientar a execução:
- O transporte WhatsApp ↔ Broker ↔ caixa API existe; o motor Automações v2 é vinculado ao canal.
- O HANDOFF v2 apenas muda o estado local para HUMAN. Atribuição remota de time/agente, sincronização de status e retomada ainda não completam o atendimento.
- O AgentBot legado é outro caminho. Seu vínculo não é feito automaticamente pelo editor novo.
- O Flow local do JRC usa outro motor. A edição do mesmo grafo do Broker dentro do JRC exige a integração delegada A1/A2, ainda não entregue.
- Um único executor por caixa e controle de resposta bot/humano são pré-requisitos da ativação; proteções existentes ainda não cobrem todos os caminhos.
- O menu Fluxo de Conversa dos prints é configuração de resolução, não evidência do editor de bots.

Primeira entrega vertical: **caixa piloto → saudação → menu → seleção do time → humano assume → bot para → encerramento/retomada explícita**. Todos esses passos devem funcionar e ser homologados juntos.

### Tarefas prioritárias incorporadas

- [ ] P0: centralizar o vínculo e a exclusividade do executor em `channels/facade.ts`, `messaging/repository.ts` e serviços de automação; testar concorrência e alteração externa de AgentBot.
- [ ] P1: implementar handoff remoto com catálogo de times/agentes, mapeamento de conversa, atribuição, estado e recuperação de falha parcial; coordenar retomada e política de conversa resolvida no worker/adaptador Chatwoot.
- [ ] P2: concluir navegação e formulários dos blocos de atendimento, seletores da central e simulação; não exigir IDs manuais nem JSON para encaminhar.
- [ ] P3: implementar o editor delegado pelo servidor JRC usando o mesmo serviço/grafo do Broker, escopo Account/Inbox, revogação e credencial separada da chave QR. Ativação depende de P0/P1.
- [ ] P4: JSON nativo documentado, exemplos de URA e consultas/IA necessárias; importação sempre como rascunho.
- [ ] P5: compatibilidade por canal, migração de flows locais e conversor n8n parcial com equivalência testada.

Os arquivos, dependências e testes de aceite estão detalhados nas seções 7–10 da referência. P1/P2 constituem a entrega funcional inicial; os itens genéricos abaixo são desdobramentos conforme necessidade do atendimento.

## Evidências e limites da revisão

Inspeção estática do código e dos quatro arquivos fornecidos; nenhum fluxo financeiro ou de suporte foi executado contra sistemas reais.
- Arquivo HML v1.1.13: formato jrc-broker-flows/1, 1 start e 61 unsupported já gravados.
- JADE v1.1.12: 62 nós; 27 Code, 11 Switch, 7 Redis, 6 Execute Workflow, 3 Agent, 3 modelos OpenAI, 2 If, webhook, resposta e nota.
- BTV v3.9: 38 nós; 18 Code, 10 HTTP, 3 If, 3 Redis, 2 Switch, trigger e nota.
- KSYS v3.11: 52 nós; 27 Code, 11 HTTP, 7 If, 3 Redis, Switch, Wait, trigger e nota.
- Versões observadas: Code 2, HTTP 4.3, If 2.2, Switch 3.2, Redis 1, Execute Workflow 1.1, Agent 1.7 e modelo 1.2. Compatibilidade deve considerar tipo E versão.
- packages/contracts/src/automations-v1.ts: catálogo de 27 tipos.
- apps/web/src/flows/FlowCanvas.tsx: inspector não expõe todos os parâmetros dos executores, por exemplo fontes/campos/valores de transformações, corpo HTTP, parâmetros SQL e schemas/ferramentas IA.
- apps/api/src/modules/automations/engine.ts: persistência lógica de espera, efeitos externos, subfluxos e validação presentes. Variáveis são strings; há serialização e truncamento a 4096 caracteres em caminhos do motor, enquanto data-nodes permite 65536 bytes. Isso exige contrato consistente antes da migração de objetos/listas complexos.
- packages/contracts/src/flows.ts: conversão n8n limitada a alguns gatilhos, resposta textual literal e noOp; restantes viram unsupported.
- apps/api/src/modules/automation-integrations/ai.ts: adaptador devolve toolCalls; isso não prova execução completa de ferramentas de agente.
- Correção local de navegação: 222 arquivos de teste / 1423 testes passaram. TypeScript passou dentro do comando build; bundling Vite bloqueado por acesso do sandbox. Não publicado nem validado em navegador nesta revisão.

## Decisões de produto

Três entradas convergem para o mesmo formato executável JRC: criação visual, JSON nativo (inclusive gerado por IA), conversão n8n.
O editor deve permitir criar sem JSON. Código é recurso avançado opcional.
Não anunciar compatibilidade integral n8n. Não copiar seu motor como atalho. Uma integração externa opcional com n8n seria produto separado, com autenticação, isolamento e condições comerciais verificados.
Não converter nós desconhecidos em operações vazias; preservar diagnóstico e impedir publicação quando a semântica estiver incompleta.
Não usar o arquivo HML como prova de comportamento: recuperar lógica dos originais n8n.
Não modificar nem copiar os JSON privados para Git. Fixtures sintéticas devem preservar a estrutura sem dados de clientes, URLs privadas e credenciais.

## Experiência alvo

Escolher modelo ou canvas vazio → adicionar blocos → preencher formulários → selecionar dados produzidos pelos passos anteriores → conectar sucesso/erro → testar com mensagem fictícia → corrigir erros destacados → publicar versão → vincular caixa → ativar.
Cada bloco tem campos obrigatórios, ajuda, entrada, saída, portas, erro e resultado do teste.
Inspector tem abas Configuração, Entradas, Saídas e Erros; credenciais são selecionadas pelo nome, não digitadas como UUID.
Rascunho salva independentemente da execução habilitada. Disponibilidade explica separadamente editar, simular, testar integração e ativar.
Teste simulado não chama sistemas; teste real de integração identifica efeitos e exige ação explícita. Operações financeiras não devem ocorrer por abrir/importar um arquivo.

## Contrato central

Adicionar definição versionada de nó: tipo, versão, schema de configuração, schema de entrada/saída, portas, restrições, componente visual, executor, simulador e adaptadores de importação.
O servidor é a autoridade para validação. Compartilhar schemas e portas; componentes visuais não entram no pacote usado por workers.
JSON nativo: format/schemaVersion, nome, nodes, edges, referências de subfluxos e credenciais lógicas; exportação sem segredos ou IDs reutilizados de outra empresa.
Publicar JSON Schema gerado dos mesmos contratos, exemplos validados e prompt de geração. Toda saída de IA passa pelo mesmo validador.
Tratar versões desconhecidas com erro explicativo ou migração explícita. Não aceitar silenciosamente propriedades sem execução correspondente.

## Entregas e testes

Cada tarefa: escrever teste que falha, confirmar falha, implementar, executar testes focais, revisar diff e registrar evidência. Antes de commit, npm test e git diff --check --ignore-submodules. Build completo antes da liberação.

### 1. Contrato e cobertura real do catálogo
Arquivos: packages/contracts/src/automations-v1.ts; novo packages/contracts/src/automation-node-definitions.ts; apps/api/src/modules/automations/engine.ts.
- [ ] Inventariar os 27 tipos com todos os campos consumidos pelo runtime.
- [ ] Testar configurações ausentes, portas inválidas, versões e referências.
- [ ] Unificar schemas/portas e remover divergência entre catálogo, editor e runtime.
Aceite: nenhum bloco oferecido como disponível fica sem formulário, validação, executor e teste.

### 2. Editor utilizável e configuração completa
Arquivos: apps/web/src/flows/FlowCanvas.tsx, FlowCanvas.test.tsx; apps/web/src/pages/AutomationStudio.tsx; novos apps/web/src/automations/node-editors/*.
- [ ] Concluir verificação da navegação local em navegador: pan, zoom ancorado, drop após zoom, seleção, teclado e coordenadas negativas.
- [ ] Separar inspector por famílias e expor todos os campos descritos na tarefa 1.
- [ ] Seletores de variáveis e credenciais, mensagens de validação por campo.
- [ ] Desfazer/refazer, duplicar, busca, localizar nó com erro e layout legível.
- [ ] Prova de conceito React Flow preservando IDs, dados, portas, coordenadas e exportação; adotar somente após round-trip e teste de desempenho com 150 nós.
Aceite: usuário cria menu → resposta → condição → HTTP → mensagem/atendente sem editar JSON.

### 3. Dados tipados e semântica do motor
Arquivos: apps/api/src/modules/automations/types.ts, engine.ts; apps/api/src/modules/automation-integrations/data-nodes.ts; migração de estado se necessária.
- [ ] Definir objetos/listas/números/booleanos/null sem truncamento silencioso; limites por valor e execução com erro explícito.
- [ ] Versionar estado e preservar retomada de execuções antigas; manter runtime anterior para versões publicadas antigas se incompatível.
- [ ] Definir contexto de conversa e resultados por nó; seletores não devem confundir referência aninhada com chave literal.
- [ ] Adicionar Switch com regras ordenadas, saída padrão e comportamento explícito de múltiplas correspondências.
- [ ] Testar dados maiores que 4096 caracteres, listas vazias, campos ausentes e condições com tipos distintos.
Aceite: resultado idêntico em execução contínua e retomada após reinício.

### 4. Integrações, memória e agentes
Arquivos: automation-integrations/{safe-http,sql,sandbox,ai}.ts; novos state-store.ts e agent-runner.ts; workers de IO existentes.
- [ ] HTTP: corpo/query/headers, credencial, timeout, resposta tipada, políticas de repetição e resultado desconhecido.
- [ ] Memória: get/set/delete/TTL com namespace determinado pela empresa no servidor, escopo conversa ou empresa e sem acesso ao Redis interno arbitrário.
- [ ] SQL parametrizado conforme política atual somente leitura; escrita é extensão separada, não assumida na importação.
- [ ] Code: input/output documentados, sandbox, tempo/memória, sem ambiente/rede; nada de substituir expressões n8n com regex e executá-las.
- [ ] Agente: registro de ferramentas com schema, autorização, execução, retorno ao modelo, limite de passos/custo e interrupção humana.
- [ ] Impedir mistura de empresas em memória, credenciais, subfluxos e ferramentas; testar duplicidade de eventos e falhas após efeito externo.
Aceite: integração e agente completam caminhos sucesso/erro com rastreabilidade e sem repetição cega de efeitos.

### 5. Conversor n8n verificável
Arquivos: packages/contracts/src/flows.ts; apps/api/src/modules/automation-integrations/importer.ts; novos import/n8n/{parser,expressions,mappings,report}.ts.
- [ ] Detectar tipo e typeVersion, preservar proveniência e criar relatório por campo e aresta.
- [ ] Primeiro: If, Switch, HTTP e Wait; depois Redis/memória, subfluxos e composição Agent + modelo.
- [ ] Mapear expressões por parser e lista permitida. Expressões/código dependentes do contexto n8n ficam bloqueados até adaptação testada.
- [ ] Preservar portas, fan-out, ordem e erros somente quando o motor JRC implementar comportamento equivalente.
- [ ] Distinguir webhook HTTP de gatilho de mensagem; resposta HTTP não é automaticamente envio WhatsApp.
- [ ] Importar conjunto de subfluxos em duas etapas: reservar referências e resolver dependências na mesma empresa; ausentes impedem publicação.
- [ ] StickyNote vira anotação visual, sem contar como passo executável.
- [ ] Categorias: equivalente testado, requer configuração, requer adaptação, não suportado. Cada item tem motivo e ação.
Aceite: fixtures por versão com comparação de saídas, ramos e efeitos. Não há percentual de compatibilidade prometido antes desses testes.

### 6. JSON nativo para pessoas e IA
Arquivos novos: docs/automations/jrc-flow-format.md, docs/automations/generation-prompt.md, exemplos sintéticos e schema gerado pelo contrato.
- [ ] Publicar exemplos: menu, consulta HTTP, suporte humano, financeiro e agente restrito.
- [ ] Validar exemplos em CI; round-trip exportar/importar preserva configuração e conexões.
- [ ] Retornar erro com caminho do JSON, nó/campo e sugestão.
Aceite: JSON gerado a partir do guia abre como rascunho configurável e passa nos mesmos testes do editor visual.

### 7. Simulação, homologação e liberação
Arquivos: AutomationStudio.tsx, serviço de automações, suíte E2E e documentação operacional.
- [ ] Simular passos com dados fictícios usando a mesma semântica do motor e adaptadores externos simulados.
- [ ] Mostrar entrada/saída redigidas, caminho percorrido, espera e falha por nó.
- [ ] Testes de referência JADE/BTV/KSYS com fixtures sanitizadas: cliente não encontrado, sucesso, erro HTTP, espera, expiração, transferência, dependência ausente, limite de IA, duplicidade e acesso cruzado.
- [ ] Executar fluxos originais em ambiente n8n isolado com serviços simulados para obter referência comportamental. Hoje só houve leitura estática.
- [ ] Teste ponta a ponta em empresa piloto: WhatsApp → Broker → bot → Chatwoot → resposta humana.
- [ ] Fixar imagens e migrações; ativação por empresa após testes, rollback para versão publicada anterior e compatibilidade do estado persistente.
Aceite: edição e publicação demonstradas em navegador, integrações testadas, caminhos de erro cobertos e evidência de isolamento. Containers running e importação bem-sucedida não bastam.

## Ordem

Ordem revisada: P0 → P1/P2 → P3/P4 → P5. As tarefas 1–7 acima fornecem detalhes técnicos subordinados a essas prioridades. Dados tipados devem ser corrigidos conforme os blocos oferecidos; integrações genéricas e conversão n8n avançada ficam para incrementos posteriores.
Primeira entrega funcional: bot nativo de atendimento criado inteiramente pela interface, transferindo de verdade a conversa para a equipe na central. Segunda: mesma edição pelo módulo JRC, consultas e IA necessárias. Terceira: migração dos fluxos n8n dentro do subconjunto anunciado.
Não condicionar a utilidade do editor à conversão completa do n8n.

## Fontes oficiais consultadas

- React Flow, navegação: https://reactflow.dev/learn/concepts/the-viewport
- React Flow, fluxo de dados: https://reactflow.dev/learn/advanced-use/computing-flows
- n8n, exportação/importação: https://docs.n8n.io/build/manage-workflows/export-and-import.md
- n8n, índice atual: https://docs.n8n.io/sitemap.md (localização de referências de dados, subfluxos e testes; páginas individuais adicionais não puderam ser obtidas nesta sessão).

A biblioteca visual resolve interação; persistência e execução continuam responsabilidade do Broker. A documentação de exportação confirma JSON e referências de credenciais, mas não implica compatibilidade com outro motor. As decisões de arquitetura acima são recomendações para este código, não garantias dos fornecedores.

