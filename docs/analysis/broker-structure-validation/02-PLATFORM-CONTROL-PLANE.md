# 02 — Platform / Control Plane

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

| Capability | Evidência | CODE_STATUS | TEST_STATUS |
|---|---|---|---|
| Organizations/users/memberships/roles | migrations 0001/0002; módulos organizations/users/memberships | IMPLEMENTED | PASS |
| Administração global separada | migration 0010; `modules/platform/service.ts`; `/jrc/*` | IMPLEMENTED | PASS |
| Plans, limits, suspension | migration 0011; `tenancy/operational-limits.ts` | IMPLEMENTED | PASS |
| Sessões/API keys/audit | migrations 0002/0007/0008; módulos auth/api-keys/audit | IMPLEMENTED | PASS |
| MFA administrativa | `platform/login-policy.ts`; Dokploy `password_totp` | IMPLEMENTED | PASS |
| Feature flags | flags por domínio, sem catálogo global único | PARTIAL | PASS |
| Schema status read-only | `db/schema-status.ts` e testes de migration | IMPLEMENTED | PASS |

RLS é habilitada e forçada; runtime comum usa NOBYPASSRLS. Cookies, CSRF, rate limit, troca de organização e separação entre papel global e tenant têm testes HTTP/integration. Respostas de erro usam Problem Details e `requestId`; logs incluem `correlationId`. 401/403 observados nos testes são negativos esperados; 500/503 são normalizados e cobertos. Limitação: MFA e suporte não foram homologados num domínio remoto.
