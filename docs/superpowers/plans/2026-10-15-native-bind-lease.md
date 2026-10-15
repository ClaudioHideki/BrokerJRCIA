# Plano: lease nativa antes do bind

> Execução inline com superpowers:executing-plans e TDD; sem agentes adicionais.

**Objetivo:** corrigir prepare DRAINED → bind JRC_NATIVE mantendo uma lease SQL viva durante observe e um recibo interno explícito até a ativação.

**Design aprovado:** [2026-10-15-native-bind-lease-design.md](../specs/2026-10-15-native-bind-lease-design.md).

**Arquivos de produto:** `apps/api/src/modules/flows/delegation/cutover.ts` e os pequenos hunks de import/scoped/bind em `service.ts`. O hunk runOnce/input timeout pertence à tarefa paralela. Sem migrations, contrato público, instalação de módulos, commit, push, deploy ou suíte total nesta tarefa.

## 1. Regressão com contrato real

- [x] Confirmar que settle limpa a lease e que o helper anterior permitia null==null.
- [x] Criar fixture com adapter/schema reais, registration sintética estável e credencial/sessão nativas reais.
- [x] Observar RED sem editar produto: FLOW_HOST_FENCE_REQUIRED no bind positivo. Bootstrap/ACL/ECONNREFUSED anteriores não contam como RED.
- [x] Exigir lease persistida viva no HTTP e lock NOWAIT por outra conexão, sem depender de expectativas de chamadas somente.

## 2. Reserva, recibo e consumo

- [x] Receber liberação do checkout após 4c7a5eff1a3fa427aa52ef57636b9e00c7ad7fd8 e anunciar edição dos hunks de bind.
- [x] Reservar lease nativa curta usando o relógio SQL e respeitando a validade da prova.
- [x] Observar fora da transação e revalidar após I/O.
- [x] Passar NativeBindReceipt explicitamente às transações de leitura/mutação do bind e a activate.
- [x] Consumir a lease atomicamente com ACTIVATED e manter STOCK sem requisito nativo.
- [x] Limpar no finally externo somente a tentativa com o mesmo token/revisão; preservar ACTIVATED, token substituto e UNKNOWN.

## 3. Disputas e falhas

- [x] Bind positivo: uma binding, ownerRevision 1, uma fence, um observe, token consumido.
- [x] Concorrência: B recusa lease viva sem HTTP extra nem cleanup de A.
- [x] Expiração SQL durante observe: nenhuma ativação e UNKNOWN.
- [x] Credencial revogada após observe: nenhuma binding e cleanup próprio.
- [x] Timeout e resposta tardia: UNKNOWN persistido, sem mutação tardia.
- [x] A expirada/B viva: cleanup de A não limpa token B; somente B conclui.
- [x] Sessão revogada após o recibo e antes da SQL final: falha sem binding/owner.
- [x] UNKNOWN existente: bind recusa sem refazer fence/observe.
- [x] Assertar ausência de HTTP dentro da própria transação via AsyncLocalStorage.
- [x] Sincronizar somente a resposta fake de introspecção ao relógio SQL com espera limitada, sem relógio global nem sleep.

A expiração foi exercitada no I/O com clock_timestamp e na troca de tokens. Não foi acrescentado outro caso que segure um row lock até expirar na transação final; o código verifica relógio SQL depois dos locks e novamente no UPDATE final, e os cenários de revogação/expiração existentes permanecem na suíte integrada.

## 4. Verificação e integração

- [x] Rodar somente a seleção `native bind nomination`: oito casos passaram; 49 fora da seleção. Evidência: `fourth-green.log`, 27.88s.
- [x] Rodar os dois arquivos unitários focais dos adaptadores: 15 testes passaram em 27.28s; `npm run typecheck` passou.
- [x] Revisar `git diff --check` (sem erros) e limites dos hunks; nenhum hunk runOnce alterado por esta tarefa.
- [x] Entregar source estável e evidência à tarefa principal para revisão independente e uma única suíte final, incluindo os caminhos STOCK existentes. A execução integrada pertence à tarefa principal.

Comandos focais:

```text
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/api/tests/integration/flow-service.test.ts --maxWorkers=1 -t "native bind nomination"
node node_modules/vitest/vitest.mjs run apps/api/tests/unit/flow-native-adapter.test.ts apps/api/tests/unit/flow-native-ownership-adapter.test.ts --maxWorkers=1
npm run typecheck
git diff --check
```

O laboratório é sintético e compartilhado; janelas PG foram coordenadas com as outras tarefas. Não remover stack, volumes ou scratch. A tarefa principal integra, testa o conjunto e decide commit/release.
