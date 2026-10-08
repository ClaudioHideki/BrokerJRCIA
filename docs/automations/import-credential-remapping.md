# Credenciais em importações novas

Estado: implementação local com 39 testes focados aprovados em 2026-10-07; não comprova release.

O formato nativo `jrc-broker-flows/1` conserva UUIDs opacos no arquivo exportado. Um UUID de credencial é referência, não token secreto. Ao importar em uma nova definição, é necessário selecionar credencial da empresa atual, mesmo quando ela tem um UUID igual ao artefato.

A conversão nova remove somente `data.credentialId` dos tipos `http`, `sql`, `ai-generate`, `ai-classify`, `ai-extract`, `ai-summarize` e `ai-agent`. Labels, IDs/arestas, referências de subflow e dados normais permanecem; nenhuma limpeza por regex de texto/nome ou remoção geral de UUIDs. Campos aninhados de negócio ou um campo de mesmo nome em outro tipo de nó são preservados.

Cada nó alterado passa a PARTIAL e informa que `data.credentialId` exige uma credencial local antes de publicar. A configuração ausente gera o diagnóstico de campo existente e impede execução/publicação até a seleção explícita. Esse remapeamento não adiciona um nó artificial nem substitui outro bloco, inclusive em grafos de 150 nós. A proteção existente para conversões com perda semântica n8n/Typebot continua.

`credentialsRemoved` indica uma remoção efetiva na conversão (referência executável nativa ou credenciais n8n omitidas). Um artefato sem esses campos retorna false; isso não indica um segredo disponível nem autorização para reutilizar credenciais de outra empresa.

Prévia não grava e importação permanece sem publicação/vínculo automático. O original continua cifrado para revisão. Replay idempotente de artefatos já persistidos retorna o grafo e relatório históricos, sem reescrita de dados existentes. Exportação histórica permanece intacta; o formato novo com esquema/remapeamentos lógicos continua parte do U6.

## Ledger

- Hipótese confirmada por fonte: parser nativo preserva campo; relatório de remoção é constante. O U6 exige remapeamento de referências.
- Plano técnico escrito antes da alteração de implementação.
- RED funcional confirmado: 16 testes, 15 falhas e um passe. As falhas mostraram referência ainda presente, relatório constante e ausência de revisão. O replay histórico já passou sem alteração.
- RED: `npm test -- apps/api/tests/unit/automation-import-credential-remapping.test.ts` — 16 testes, 15 falhas funcionais e um passe, exit 1, duração 21,91 s, início 16:38:11 de 2026-10-07 (America/Sao_Paulo).
- GREEN: `npm test -- apps/api/tests/unit/automation-import-credential-remapping.test.ts apps/api/tests/unit/automation-importer.test.ts apps/api/tests/unit/jrc-flow-converter.test.ts apps/api/tests/http/automation-integration-hooks.test.ts apps/api/tests/unit/automation-drafts.test.ts` — 5 arquivos e 39 testes aprovados, exit 0, duração 24,25 s, início 16:40:21 de 2026-10-07 (America/Sao_Paulo).
- Implementação limitada ao importer. Testes de persistência/replay usam armazenamento simulado e a rota HTTP usa injeção local; não houve banco/rede/produção, suíte completa, commit ou push.
- Escopo: remapeamento explícito na importação nova; P3/U6 seguem parciais, sem habilitar voz/HTTP nem ampliar compatibilidade Jade/n8n.
