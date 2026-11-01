# AUD-B07 — fence de polling pelo clock autenticado do webhook

Data: 2026-11-01. Base inspecionada: `b076e05`, branch `codex/broker-jrc-2-redesign-homologacao-20261030`.

Estado: incremento implementado e testado localmente. AUD-B07 integral continua parcial. Nenhum commit, push, publicação, deploy, alteração produtiva ou envio externo executado.

## Achado reproduzido

`getInstanceStatus` capturava a instância, aguardava I/O e aceitava o polling quando `status` e `updatedAt.getTime()` continuavam iguais. O watermark e o fingerprint autenticado, gravados pelo webhook em `instances`, não participavam dessa comparação.

Um novo webhook pode conservar `CONNECTED`, e timestamps PostgreSQL distintos podem ser representados pelo mesmo milissegundo em JavaScript. Assim, polling iniciado antes de uma observação autenticada podia gravar `DISCONNECTED` sobre o fato mais recente. A mudança do domínio autenticado também passava despercebida pela comparação antiga.

O teste do serviço completo, com repositório e transporte sintéticos, controla a espera upstream por Promise e conserva explicitamente status/updatedAt. Não usa sleeps nem dados reais. Duas variantes avançam somente o watermark ou somente o fingerprint; ambas reproduziram a gravação indevida antes da correção.

## Alteração mínima

- `apps/api/src/modules/messaging/qr-connection-order.ts`: helper `isSameConnectionClock` compara igualdade de watermark e fingerprint entre snapshots. Não compara hora da origem com wall clock do Broker.
- `apps/api/src/modules/instances/service.ts`: a proteção de snapshot do polling passa a exigir também igualdade desse clock, antes de alterar status ou reconciliar operações pendentes.
- `apps/api/src/modules/instances/repository.ts`: `InstanceRow` e leituras/retornos SQL incluem as duas colunas já existentes na migration 0076. O tipo interno de resultado deriva de `InstanceRow` para manter o contrato único.
- `apps/api/tests/unit/instance-service.test.ts`: duas regressões de concorrência e caso positivo de polling com clock inalterado; o positivo conserva watermark e fingerprint e aceita data da origem posterior ao relógio local.
- `apps/api/tests/unit/evolution-fleet/instance-fleet-uncertainty.test.ts` e `apps/api/tests/unit/reconciliation.test.ts`: fixtures recebem os dois campos nullable requeridos pelo contrato interno.

Não há migration, novo campo público, mudança de permissão, alteração de engine ou alteração dos observadores de identidade/grupo.

## RED → GREEN → regressão

Runtime: `C:\Program Files\nodejs\node.exe`. Comandos executados na raiz deste worktree.

1. RED: `node node_modules/vitest/vitest.mjs run apps/api/tests/unit/instance-service.test.ts --maxWorkers=1` — exit 1, **2 falhas esperadas / 26 aprovados**. Esperado `CONNECTED`, recebido `DISCONNECTED`, nas variantes watermark e binding. Evidência: `01-red.txt`.
2. GREEN inicial: cinco arquivos, **58 testes aprovados**, exit 0. Evidência: `02-green-regression.txt`.
3. Regressão final, incluindo caso positivo: `node node_modules/vitest/vitest.mjs run apps/api/tests/unit/instance-service.test.ts apps/api/tests/unit/qr-connection-order.test.ts apps/api/tests/unit/qr-events.test.ts apps/api/tests/unit/evolution-fleet/instance-fleet-uncertainty.test.ts apps/api/tests/unit/reconciliation.test.ts --maxWorkers=1` — **5 arquivos / 59 testes aprovados**, exit 0, duração 11,10 s. Evidência: `04-final-regression.txt`.
4. `node node_modules/typescript/bin/tsc -b --pretty false` — exit 0, sem diagnóstico, executado novamente após a regressão positiva. Evidência: `05-final-typecheck.txt` (vazio porque não houve diagnóstico).
5. `git diff --check` limitado aos seis arquivos deste incremento — exit 0, sem diagnóstico.

A suíte geral `npm test` deve ser executada uma única vez pela coordenação na consolidação dos agentes. Ela não foi executada por este agente; não se afirma aprovação geral do checkout.

## Fronteira de prova e risco residual

- Os testes comprovam a decisão e os efeitos do serviço com entradas sintéticas. Não executaram PostgreSQL real, RLS, locks reais nem migration. A seleção SQL foi revisada e o TypeScript compilou; isso não comprova a execução SQL.
- O incremento rejeita polling em voo quando o webhook altera watermark/fingerprint. Não cria ordenação global de todos os fatos nem resolve um webhook que chega depois de um polling já aplicado.
- `WhatsAppProvider.getStatus` retorna somente um enum de estado. Não fornece sequência/fato da origem nem geração da sessão WhatsApp. A geração do fleet existente é da engine/binding; não deve ser apresentada como geração da sessão.
- Webhook legado sem timestamp, antes de watermark, continua com a semântica existente. Um evento que não muda watermark/fingerprint e conserva status/milissegundo ainda depende da proteção antiga de snapshot.
- Próximo incremento: definir com a origem atestada um contrato comum de revisão do binding e geração da sessão, testar polling/webhook nos dois sentidos e executar concorrência em PostgreSQL isolado. Não usar timestamp local do Broker como substituto do relógio da origem.
