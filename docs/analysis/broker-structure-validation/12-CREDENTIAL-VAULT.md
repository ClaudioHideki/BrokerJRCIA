# 12 — Credential Vault

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Migration 0027, `automation-integrations/credentials.ts`, `credential-tester.ts` e rotas `/v1/credentials*` implementam list/create/get/rotate/revoke/test. Segredos são cifrados com AAD tenant-aware, key version, fingerprint e nunca retornam ao navegador; RBAC, audit e redaction são testados. Tipos incluem bearer/API key/basic/OAuth/DB/AI/custom por contrato.

Tokens Meta, provider e Chatwoot anteriores usam serviços de segredo compatíveis, mas nem todos foram migrados para a tabela do vault genérico.

**CODE_STATUS: PARTIAL. TEST_STATUS: PASS.** O cofre genérico está implementado; o gap é consolidar gradualmente stores legados e comprovar rotação de KMS externo em homologação.
