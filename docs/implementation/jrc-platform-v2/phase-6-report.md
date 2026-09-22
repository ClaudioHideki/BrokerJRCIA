# Fase 6 — Automation Studio

Data: 2026-09-21  
Branch: `codex/jrc-platform-v2-phase6-automation-studio-20260921`

## Resultado

O painel passou a operar sobre o Automation Runtime v2. A experiência cobre listagem, criação, edição visual, validação, simulação, publicação, histórico de versões e inspeção de execuções. O Flow legado continua acessível durante a transição e `/flows` escolhe o produto correto pela feature flag do runtime.

## Rotas e navegação

- `/automations` e `/automations/new`;
- `/automations/:id/edit` e o alias `/automations/:id/editor`;
- `/automations/:id/versions`;
- `/automations/:id/executions`;
- `/automation-executions` e `/automation-executions/:id`;
- `/legacy/flows` preserva o canvas anterior;
- `/flows` consulta o runtime e redireciona para o Studio ou para o legado.

A consulta da feature flag ocorre apenas na rota de compatibilidade. Isso evita chamadas laterais em outras telas e não interfere nos pollings operacionais já existentes.

## Editor visual

- Header com nome, estado, versão ativa, salvar, validar, testar, publicar e histórico.
- Catálogo pesquisável e categorizado contendo somente nodes que o runtime executa.
- Drag/drop, zoom, conexões, seleção e movimento por teclado.
- Inspector tipado para mensagem, input, menu, condição, variável, delay, subflow, handoff e encerramento.
- Drawer com Input, Output, Variables, Execution, Logs e Errors.
- Resumo de alterações antes da publicação.
- Edição bloqueada para papéis sem permissão de escrita.
- Rascunho local isolado por organização e automação, recuperado após reload e preservado em falha 5xx.

## Catálogo e contrato

O catálogo canônico está em `@jrc/contracts` e é servido por `GET /v1/automation-nodes`. O frontend valida definições e versões recebidas com os schemas públicos. Respostas de definição agora carregam `schemaVersion: 1`, eliminando divergência entre API e painel.

## Execution Explorer

O detalhe de execução informa:

- versão imutável e correlation ID;
- status e erro seguro;
- timeline por node;
- tentativa e duração;
- input, output e estado com campos sensíveis redigidos.

Chaves com nomes de segredo, token, senha, autorização ou credencial nunca são devolvidas em claro pelo detalhe de execução.

## Acessibilidade

- Controles possuem labels e estados semânticos.
- O canvas permite deslocar o node selecionado com as setas; Shift aumenta o passo.
- Avisos e erros usam regiões anunciadas.
- Estados vazios e carregamento possuem texto explícito.
- O aviso de saída é ativado enquanto existem alterações locais.

## Validação

- `npm run typecheck`: aprovado.
- Build de produção Vite: aprovado.
- Testes focados de Studio, API, runtime, deduplicação e outbox: 5 arquivos, 9 testes aprovados.
- Testes de regressão após isolar a feature flag: 3 arquivos, 35 testes aprovados.
- Suíte completa: 169 arquivos e 1.147 testes aprovados.
- Geração OpenAPI: aprovada.
- Gate de contratos públicos: aprovado.
- `git diff --check`: aprovado.

## Rollback

Com `AUTOMATION_RUNTIME_V2_ENABLED=false`, `/flows` encaminha o usuário para `/legacy/flows`. As rotas e os dados do Flow anterior permanecem intactos.

## Limites desta fase

- HTTP, webhook, SQL, código seguro e IA pertencem à Fase 7.
- Métricas operacionais e alertas completos pertencem à Fase 8.
- Migração automática dos Flows existentes pertence à Fase 9.
- Não houve deploy ou alteração no servidor de produção.
