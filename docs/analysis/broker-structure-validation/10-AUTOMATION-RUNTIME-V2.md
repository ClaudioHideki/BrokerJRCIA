# 10 — Automation Runtime V2

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Migration 0026 cria definitions, versions, bindings, executions, node executions, events, waits e outbox; schedules são representados por waits/timer e scheduler worker. Files: `modules/automations/{service,engine,repository,types}.ts` e workers dedicados.

Há draft/publish imutável, versão fixa, persistência por nó, delay/event/IO durável, timeout/cancel/resume/retry seguro, handoff, UNKNOWN/reconciliation, subflow com proteção de ciclos, leases/crash recovery, ordering e idempotência. Cenários de duplicata, crash, restart, wait/resume e side effect incerto têm testes.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS.** Limitação: carga de produção e providers reais não foram homologados; schedules recorrentes ricos ainda são mais restritos que um orquestrador genérico.
