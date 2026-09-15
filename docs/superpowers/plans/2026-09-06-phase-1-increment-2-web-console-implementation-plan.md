# Fase 1 — Incremento 2: Console web operacional JRC Implementation Plan

> **For agentic workers:** execute tarefa por tarefa com `superpowers:subagent-driven-development` ou `superpowers:executing-plans`, adaptados ao working tree desta entrega: nenhum agente pode fazer staging, commit, push, PR, merge ou finalização de branch. Todo comportamento novo segue `superpowers:test-driven-development` e cada revisão usa o diff não staged do escopo da tarefa.

**Goal:** entregar a primeira console web funcional JRC integrada ao backend multicliente, com sessão segura de navegador, conexões Baileys e API keys.

**Architecture:** ampliar o monólito modular existente. A API pública continua compatível; rotas `/v1/console/auth` adaptam refresh para cookie HttpOnly com Origin/CSRF. `apps/web` guarda access token apenas em memória e usa somente URLs relativas da API JRC. Provider accounts são descobertas sob RLS e Evolution permanece privada.

**Tech Stack:** Node.js 24.19.0, TypeScript strict, React 19.2.8, Vite 7.3.6, `@vitejs/plugin-react` 5.2.0, React Router 7.18.3, Fastify 5, Zod 4, Vitest 3.2.7, Testing Library, axe-core e Playwright em versão exata compatível. As versões são confirmadas nas páginas oficiais/npm antes de atualizar o lockfile.

**Spec:** `docs/superpowers/specs/2026-09-06-phase-1-increment-2-web-console-design.md`

## Restrições globais

- Branch exclusiva `codex/phase-1-web-console`, baseada em `origin/codex/phase-1-increment-1@159ddfc18ed110957849e43e1825ef6c31ca3cd3`.
- Não alterar `main`, `upstream/evolution-api`, submódulos, licenças ou atribuições.
- Não fazer staging, commit, push, PR, merge ou deploy neste plano sem nova autorização.
- Não persistir access/refresh/selection token, API key secreta, QR, pairing code, telefone ou credencial Evolution no navegador, logs ou artefatos.
- Permanecem fora do lote: Meta real, mensagens, mídia, webhooks completos, billing, WhatsApp Calling, chatbot, filas e deploy.
- Testes RED devem falhar pela capacidade ausente; implementação mínima GREEN; refactor apenas com testes verdes.
- Revisão independente ao final de cada lote e revisão integral antes dos gates finais.

## Task 0: Preflight, CI e matriz contratual

**Inspect:** `AGENTS.md`, `README.md`, documentos de arquitetura/Fase 1, `.github/workflows/ci.yml`, último run do CI, branch/remotos/submódulos e working tree
**Verify:** a matriz da seção 2 da especificação deste incremento

1. Confirmar com Git o toplevel real, o remoto `origin`, branch, HEAD, status e SHAs dos submódulos; preservar qualquer alteração preexistente.
2. Executar `git fetch origin`, resolver novamente `origin/codex/phase-1-increment-1` e criar/reutilizar `codex/phase-1-web-console` somente após conferir sua relação com a base.
3. Inspecionar o workflow e os logs do último run. Registrar separadamente gates locais, CI do commit publicado e CI destas alterações ainda não publicadas.
4. Confirmar que a falha conhecida continua sendo `AUDIT_FINGERPRINT_SECRET` vazio. Não remover validação nem criar fallback; documentar a configuração administrativa sem revelar valor.
5. Validar a matriz `tela → ação → contrato atual → lacuna → teste` da especificação antes de alterar contratos.

## Task 1: Documentação, workspace web e identidade JRC

**Create:** `apps/web/package.json`, `apps/web/tsconfig*.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/app/App.tsx`, `apps/web/src/test/setup.ts`, `apps/web/src/app/App.test.tsx`, `apps/web/public/brand/logo-jrc-2024.png`, `apps/web/public/brand/ORIGIN.md`, `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/src/{index,tokens}.ts`, `packages/ui/tests/tokens.test.ts`
**Modify:** `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `apps/web/README.md`, `packages/ui/README.md`

1. RED: testar resolução dos workspaces, tokens exatos (`#007392`, `#2CB4F1`, `#FDD704`, `#153243`), render mínimo e ausência de storage de autenticação.
2. Consultar compatibilidade oficial/npm, fixar versões exatas mutuamente compatíveis e configurar project references, build Vite e testes jsdom sem opções deprecadas.
3. Procurar primeiro um asset oficial no repositório; se ausente, baixar a referência oficial, validar PNG/transparência/proporção e registrar origem.
4. GREEN: testes de UI, typecheck e build web.

## Task 2: Contratos e primitivas da sessão de navegador

**Create:** `packages/contracts/src/console/schemas.ts`, `packages/security/src/browser/{csrf,cookies}.ts`, testes correspondentes
**Modify:** exports dos packages, `packages/contracts/src/auth/schemas.ts`, `apps/api/src/config/env.ts`, `.env.example`

1. RED: schemas sem refresh no body e com resumo seguro do usuário (`id`/e-mail normalizado); role em organizações; HMAC CSRF; flags de cookie dev/prod; origens exatas, segredos distintos e rejeição de segredo ausente, curto, igual a outro segredo ou igual ao exemplo em produção.
2. Implementar nonce CSRF assinado, comparação constante, parser de cookies via `@fastify/cookie`, nomes `__Host-` somente HTTPS e config `CONSOLE_ALLOWED_ORIGINS`/`BROWSER_CSRF_SECRET` com mínimo de 32 bytes de entropia e nenhum fallback.
3. GREEN: unitários e typecheck; confirmar redaction de Cookie, Set-Cookie e X-CSRF-Token.

## Task 3: Rotação, restauração e troca atômica de organização

**Create:** `apps/api/src/modules/auth/browser-session.ts`, `apps/api/src/http/routes/console-auth.ts`, testes unitários/HTTP/integração
**Modify:** `apps/api/src/modules/auth/repository.ts`, `apps/api/src/app.ts`, OpenAPI

1. RED: select define cookie sem refresh JSON; replay/reuso concorrente do `selectionToken` falha; restore rotaciona; logout limpa; switch revalida membership, revoga família anterior e cria uma única sucessora sob corrida; OWNER não recebe privilégio fora do tenant ativo.
2. Implementar métodos do repositório `jrc_auth` sem nova permissão ampla e serviços que reutilizam login/select/refresh/logout existentes.
3. Validar Origin em todas as rotas de console; CSRF em toda operação cookie-auth; respostas genéricas/no-store.
4. Implementar refresh single-flight/mutex no cliente e semântica atômica no servidor para que vários 401 concorrentes não reutilizem o token rotacionado nem revoguem indevidamente a família.
5. GREEN: HTTP + PostgreSQL real + Redis, incluindo reuse/replay, membership desativada, dois tenants, OWNER cross-tenant, concorrência e logs sanitizados.

## Task 4: Descoberta segura de provider accounts e renovação de conexão

**Create:** contratos provider accounts, repositório/serviço/rota, testes unitários/HTTP/integração
**Modify:** `apps/api/src/app.ts`, `apps/api/src/modules/instances/service.ts`, testes da state machine, OpenAPI

1. RED: listagem paginada retorna somente metadados, aplica `instances:read`, RLS e 404/ausência cross-tenant.
2. Implementar `GET /v1/provider-accounts` com transação tenant e composição explícita.
3. RED: nova chave idempotente em `AWAITING_ACTION` pode solicitar novo desafio; em `CONNECTING`, uma operação não expirada permanece `202/CONNECTION_PENDING`; mesma chave nunca recupera QR/pairing perdido.
4. Implementar lock/single-flight por instância e distinguir intento transitório ativo de intento expirado antes de permitir nova chamada ao provider. Preservar HTTP fora da transação e testar timeout/replay, concorrência, ausência de duplicação e IDOR.

## Task 5: Shell, login, seleção, restore, switch e logout

**Create:** `apps/web/src/auth/*`, `apps/web/src/api/*`, `apps/web/src/layout/*`, `apps/web/src/pages/{Login,OrganizationSelect}.tsx`, CSS e testes
**Modify:** `apps/web/src/app/App.tsx`

1. RED: login e seleção reais, restore após reload, sessão expirada, switch aborta requests e limpa dados, logout; access token jamais chega a storage.
2. Implementar cliente relative-URL com token em closure, `credentials: same-origin`, CSRF cookie, refresh single-flight com uma única tentativa e `AbortController` por tenant.
3. Implementar shell JRC responsivo com papel e organização ativos, sidebar, foco e mensagens pt-BR.
4. GREEN: Testing Library + axe em desktop/mobile lógico.

## Task 6: Conexões Baileys de ponta a ponta

**Create:** páginas/componentes/hooks de conexões e testes
**Modify:** rotas do frontend e estilos

1. RED: loading, vazio, sucesso, paginação, criar via provider discovery, detalhe, status, erro validável com `X-Request-Id`, timeout/indisponível/403/404.
2. Implementar lista e formulário; não calcular total global pela página atual.
3. RED: QR PNG seguro, pairing code, expiração, replay perdido, reload em `AWAITING_ACTION` e `CONNECTING`, nova intenção, polling limitado/cancelado e disconnect confirmado.
4. Implementar assistente sem persistência de desafio; recusar Data URL/MIME/URL insegura; mostrar status com texto+ícone.

## Task 7: API keys de ponta a ponta

**Create:** páginas/componentes de API keys e testes
**Modify:** rotas do frontend e estilos

1. RED: loading, vazio, sucesso, erro com `X-Request-Id`, indisponibilidade, listagem, emissão por escopos, revelação única, cópia explícita, limpeza ao fechar, revogação confirmada e estados RBAC.
2. Implementar fluxo real; em resposta perdida orientar refresh/revogação/nova emissão, sem prometer recuperação.
3. GREEN: OWNER/ADMIN operam; OPERATOR/VIEWER recebem UX proibida e servidor 403 nos testes HTTP existentes.

## Task 8: E2E com API JRC real e provider falso controlado

**Create:** `playwright.config.ts`, `apps/web/tests/e2e/*`, fixture de runtime E2E fora da produção e screenshots sanitizados
**Modify:** scripts raiz, `.gitignore`

1. Preparar PostgreSQL/Redis isolados, migrations e tenant sintético; compor Fastify/repositórios reais com `FakeProviderAdapter` apenas sob `NODE_ENV=test`.
2. RED/GREEN por jornada: login/select/reload/switch; create/list/detail; QR/pairing/status/disconnect; API key/revoke; sessão expirada e indisponibilidade.
3. Executar Chromium em viewport desktop e mobile, axe, teclado e capturas sem senha/token/telefone/QR real.
4. Teardown sempre remove banco/Redis/processos próprios; nenhum `docker compose up` permanente.

## Task 9: Contratos, CI, runtime e auditoria de segurança

**Modify:** `docs/api/openapi.json`, `.github/workflows/ci.yml`, `infra/app/Dockerfile` se necessário, `scripts/security/*`, `README.md`, runbook web
**Create:** `docs/security/phase-1-increment-2/*`, preservando integralmente `docs/security/phase-1-increment-1/*`, testes de bundle web/variáveis Vite e documentação de mesma origem HTTPS

1. Atualizar e validar OpenAPI/cookie security/rotas/inventário.
2. Incluir build/test web e Playwright no CI sem alterar a validação de `AUDIT_FINGERPRINT_SECRET`; registrar a causa confirmada no run atual e documentar a configuração administrativa pendente.
3. Ampliar scanner para `apps/web/dist`, detectar `VITE_*` proibido, revisar CSP/topologia same-origin e manter Evolution não publicada.
4. Atualizar AUDIT-SPEC/findings/strengths/route inventory/PDF: XSS e permissões browser deixam de ser N/A; gerar, rasterizar e inspecionar cada página.
5. Executar smoke Evolution apenas com ambiente de teste explicitamente autorizado e prova de que não é cliente/produção; sempre deprovisionar e confirmar ausência. Pareamento real fica pendente sem número autorizado e ação humana.

## Task 10: Gates e revisão final

1. `npm ci`; `npm run clean`; `npm run build` (TypeScript + bundle Vite em `apps/web/dist`); `npm run typecheck`; testar o bundle produzido.
2. `npm test`; frontend focalizado; `npm run test:integration` com PostgreSQL/Redis real; `npm run test:e2e`; `npm run test:compiled`.
3. `npm run openapi:generate`; `git diff --exit-code -- docs/api/openapi.json` após a segunda geração.
4. Container se afetado; `npm audit --audit-level=high`; public boundary; submodule; security audit generate/verify/gate; `git diff --check`.
5. Revisão independente contra spec/plano: contratos, cookies/CSRF, RLS/IDOR, RBAC, QR/API keys, XSS, bundle, logs, licenças e escopo.
6. Corrigir achados por TDD e repetir gates afetados.
7. Entregar funcionalidades, arquivos/diff, branch e HEAD, gates e resultados, comandos para iniciar API/frontend, URL local, procedimento seguro para usuário sintético, roteiro por tela e capturas sanitizadas.
8. Separar pendências técnicas, de infraestrutura e de ação humana; confirmar novamente que `main`, Evolution, submódulos e ambientes de clientes permanecem inalterados; parar sem staging, commit ou publicação.
