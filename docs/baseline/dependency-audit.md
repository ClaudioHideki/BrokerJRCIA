# Auditoria de dependências da Fase 0

**Data:** 03/09/2026

O primeiro `npm install` identificou uma vulnerabilidade crítica no `vitest 3.2.4`, referente ao advisory `GHSA-5xrq-8626-4rwp`.

A correção mínima aplicada foi a atualização exata para `vitest 3.2.7`, sem mudança de versão major.

## Evidência após a correção

```text
vitest/3.2.7
found 0 vulnerabilities
Test Files 3 passed (3)
Tests 3 passed (3)
```

Não foi utilizado `npm audit fix --force`.
