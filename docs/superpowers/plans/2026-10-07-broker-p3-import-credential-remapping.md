# Broker P3 — remapeamento de credenciais ao importar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task; preservar o escopo isolado e entregar à raiz sem commit.

**Goal:** Impedir reutilização automática de referências de credenciais em importações novas e orientar sua seleção na empresa atual.
**Architecture:** A conversão nativa preserva o grafo; antes do relatório final, remover somente `data.credentialId` dos tipos executáveis HTTP/SQL/IA. O relatório passa a informar o remapeamento por nó e a remoção efetiva. Replay de artefatos persistidos conserva grafo e relatório históricos.
**Tech Stack:** TypeScript/Zod/Vitest existentes; sem dependências, banco, rede ou produção.
**Spec:** [P3 aprovado](../specs/2026-10-05-broker-independente-centrais-design.md), isolamento e Flow; U6 requer credenciais remapeadas.

## Restrições e evidência

- `importFlow` nativo usa `FlowGraphSchema.parse(flow.graph)` e preserva `data.credentialId`.
- `convertAutomationArtifact` atualmente declara `credentialsRemoved:true` sem aferir remoção e classifica os mesmos nós como EXACT.
- Exportador é inline em Studio, fora deste corte; preservar exportação/históricos não autoriza execução automática de uma credencial importada.
- Modificar somente `apps/api/src/modules/automation-integrations/importer.ts` e criar o teste de remapeamento e documentação.
- Preservar labels, IDs, posições, arestas, subflows e dados de negócio, inclusive UUIDs/textos e campos aninhados com nome semelhante.
- Não acrescentar marcador que substitua/danifique um nó para uma importação nativa que só requer selecionar credencial, inclusive no limite de 150 nós. A configuração ausente já bloqueia publicação.
- Manter conversões Jade/n8n parciais; não ampliar suporte de nós nem reescrever históricos no banco.

## Tarefa única

Criar `apps/api/tests/unit/automation-import-credential-remapping.test.ts` e `docs/automations/import-credential-remapping.md`; modificar importer.

- [x] RED: testar HTTP/SQL/IA nativos com referência explícita, relatório e diagnóstico de campo; assert que nodes/edges/dados/subflow ficam preservados.
- [x] RED: testar relatório sem remoção, limite de 150 nós, prévia sem persistência e replay histórico sem reescrita.
- [x] Executar apenas teste novo para confirmar falha funcional.
- [x] Implementar remoção de campo conhecido e relatório PARTIAL orientado à credencial local; manter bloqueador existente somente para perda semântica da conversão.
- [x] GREEN: teste novo mais `automation-importer.test.ts`, `jrc-flow-converter.test.ts`, `automation-integration-hooks.test.ts` e `automation-drafts.test.ts`.
- [x] Registrar comandos/resultados na documentação e comunicar arquivos à raiz. Nenhum commit/suíte completa/DB.
