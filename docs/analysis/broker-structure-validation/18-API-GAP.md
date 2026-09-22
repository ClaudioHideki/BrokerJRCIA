# 18 — API Gap

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

| Família | Status | Evidência/gap |
|---|---|---|
| Channels | PARTIAL | CRUD básico/pair/destination exatos; status/reconnect/disconnect/automation equivalentes ainda fora da fachada |
| Automations | EXISTS_EXACT | definitions, publish, versions, bindings, validate/simulate |
| Executions | EXISTS_EXACT | list/detail/cancel/retry/resume/reconcile |
| Node catalog | EXISTS_EXACT | GET `/v1/automation-nodes` |
| Credentials | EXISTS_EXACT | CRUD/rotate/test/revoke |
| Destinations | PARTIAL | Chatwoot/control/webhook específicos; sem CRUD genérico único |
| Hooks | EXISTS_EXACT | POST `/hooks/:token` |

OpenAPI gerado contém 170 rotas e passou o gate. APIs legadas devem permanecer durante cutover.
