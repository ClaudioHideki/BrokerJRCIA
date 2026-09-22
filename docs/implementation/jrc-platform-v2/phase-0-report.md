# Relatório da Fase 0 — Baseline e gates

Data: 2026-09-21

## Identificação

- `BASE_SHA`: `7e01151d48c4788740a2ec4918f80da3d86d1678`
- `HEAD_SHA`: `7e01151d48c4788740a2ec4918f80da3d86d1678` (antes do commit documental)
- Branch: `codex/jrc-platform-v2-phase0-baseline-20260921`
- Baseline JRC Conversas: `14e7416b7b49f08f1c6edde454803752feae86c4`
- Commits criados: pendente no momento desta captura

## Escopo e evidências

- Os 23 documentos aprovados existem em `docs/analysis/jrc-platform-v2/`.
- Os `AGENTS.md` aplicáveis foram lidos.
- O Broker possui migrations `0001_roles.sql` a `0025_flow_chatwoot.sql` em `apps/api/drizzle/migrations`.
- Flags/configurações relevantes confirmadas no compose e runtime: `CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED`, `CHATWOOT_CONTROL_ENABLED`, `CHATWOOT_EMBED_ENABLED` e conjunto `META_*`. Flows são controlados por estado/limites da organização.
- `npm run openapi:generate` concluiu com código 0 e não alterou `docs/api/openapi.json`.
- Nenhuma imagem adicional foi consultada fora dos manifests locais.

## Testes

| Comando | Resultado |
|---|---|
| `npm run typecheck` | PASS, código 0 |
| `npm test` | FAIL: 1108/1109 testes passaram; somente `tests/security-audit-pdf-verification.test.mjs` excedeu 30 s |
| `npx vitest run tests/security-audit-pdf-verification.test.mjs --testTimeout 120000` | FAIL: o teste possui limite efetivo de 30 s e terminou em ~33 s |
| `npm run openapi:generate` | PASS, sem diff no OpenAPI |
| `git diff --check` | PASS |

O único erro de baseline está isolado na renderização/verificação do PDF de auditoria. A saída também informa ausência de implementação Canvas no ambiente de teste. Não há evidência de falha do runtime do Broker. A Fase 1A deve preservar esse diagnóstico; corrigir o teste fica fora do caminho crítico funcional, mas é necessário antes de um gate de CI totalmente verde.

## Alterações

- Arquivos criados: documentação de análise e este relatório.
- Código de runtime: nenhum.
- Migrations: nenhuma.
- Rotas: nenhuma.
- Feature flags: nenhuma.
- OpenAPI: sem alteração.

## Aceite

| Critério | Estado | Evidência |
|---|---|---|
| Baseline reproduzível | PASS | SHAs, branch, migrations e comandos registrados |
| Nenhum runtime alterado | PASS | alterações limitadas a `docs/` |
| Nenhum segredo acessado | PASS | somente repositórios e testes locais |
| OpenAPI atual conhecida | PASS | geração determinística sem diff |
| Documentação consistente com HEAD | PASS | 23 documentos presentes; baseline confere |
| Suíte integral verde | FAIL não bloqueante do inventário | timeout isolado do PDF; 1108 testes passaram |

## Riscos, bloqueios e rollback

- Risco: o teste PDF torna o gate integral vermelho em máquinas onde a rasterização ultrapassa 30 s.
- Bloqueios de produção: nenhum ambiente de produção foi consultado; causas exclusivas de produção permanecem `BLOCKED_PRODUCTION_EVIDENCE_REQUIRED`.
- Rollback: reverter somente o commit documental.

Nenhum secret, provider real, número, produção, merge ou deploy foi tocado.
