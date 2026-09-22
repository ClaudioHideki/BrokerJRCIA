# 20 — Security Tests

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

PASS automatizado: cross-tenant read/write; papéis tenant e plataforma; SUPPORT auditado; API-key scopes; CSRF/cookies; HMAC/replay/idempotência; SSRF, DNS rebinding, redirects e IPs privados; secret/QR redaction; credential readback; encryption AAD; sandbox isolation; iframe origin; expiração/revogação. Runtime comum NOBYPASSRLS e scanner de release encontrou zero achados em 170 rotas; npm audit encontrou zero vulnerabilidades.

Files representativos: `apps/api/tests/integration/*rls*`, `auth-grants.test.ts`, testes de safe-http, credentials, embed, sandbox e `tests/release-hardening.test.mjs`.

**CODE_STATUS: IMPLEMENTED. TEST_STATUS: PASS.** Pentest externo, WAF/TLS público e teste de evasão em infraestrutura real permanecem BLOCKED.
