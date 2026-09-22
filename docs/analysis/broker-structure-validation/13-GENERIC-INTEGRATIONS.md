# 13 — Generic Integrations

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

HTTP/safe HTTP, webhook token hash/HMAC/replay/limits, data nodes, SQL PostgreSQL/MySQL com parâmetros/timeout/row limit/write explícito, sandbox isolado e AI abstraction estão em `modules/automation-integrations`. Sandbox roda em processo dedicado, sem network/filesystem/env/socket, com limites de tempo/recursos. Subflows e importadores Typebot/n8n fazem parte do produto JRC.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS.** Limitações: conectores de IA e bancos externos ainda precisam homologação; operações JSON cobrem set/map/pick/filter/merge/parse/stringify, mas não formam uma linguagem ETL irrestrita.
