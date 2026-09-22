# 00 — Baseline

**Repository:** ClaudioHideki/BrokerJRCIA
**Branch auditada:** `codex/jrc-platform-v2-complete-exec`
**Base SHA (merge-base com origin/main):** `a16c1cdbb00aac593fc0db2149e904b47fb723f6`
**HEAD funcional auditado:** `628218cf902096cdbdada37b4e7210b3e10cfee5`
**DEPLOY_STATUS padrão:** `UNKNOWN` — nenhum ambiente remoto foi consultado.

Working tree funcional limpo antes da auditoria. Remote: `origin=https://github.com/ClaudioHideki/BrokerJRCIA.git`. O único `AGENTS.md` exige TDD, ausência de segredos, preservação de licenças, teste antes de commit e proíbe deploy sem tarefa aprovada.

Ambiente: host Node 24.16.0/npm 11.13.0; Docker 29.5.2; Compose 5.1.3. O runtime de produção é fixado em Node 24.19.0 por digest no Dockerfile e foi validado dentro da imagem. Workspaces: `apps/api`, `apps/web`, `packages/contracts`, `packages/providers`, `packages/security`, `packages/ui`.

Há 29 migrations versionadas (0001–0029), journal, OpenAPI gerado em `docs/api/openapi.json`, Compose local/teste e composição Dokploy. A API possui 170 rotas inventariadas. O frontend possui contextos separados: portal tenant e `/jrc/*` para administração global.

Evidência principal: `package.json`, `apps/api/drizzle/migrations/meta/_journal.json`, `apps/api/src/app.ts`, `apps/web/src/app/App.tsx`, `infra/dokploy/compose.yaml`. Limitação: presença no branch não prova implantação.
