# Fase 1 — Incremento 2: Console web operacional JRC

**Status:** aprovado pelo escopo funcional de 2026-09-06
**Base:** `origin/codex/phase-1-increment-1` em `159ddfc18ed110957849e43e1825ef6c31ca3cd3`
**Escopo superior:** `docs/superpowers/specs/2026-09-03-jrc-whatsapp-broker-design.md`

## 1. Objetivo e limites

Este documento cobre somente a primeira console web operacional do JRC WhatsApp Broker. A entrega integra um frontend React à API JRC existente para autenticação, seleção e troca de organização, conexões Baileys e API keys. Ela não transforma o produto no broker comercial completo.

Ficam fora deste incremento: Meta real, mensageria, mídia, webhooks completos, billing, WhatsApp Calling, chatbot, filas e deploy. A UI não exibirá essas capacidades como disponíveis.

`main` e `upstream/evolution-api` permanecem inalterados. O navegador conversa apenas com a API JRC; a Evolution continua privada e encapsulada por `EvolutionProviderAdapter`.

## 2. Matriz tela → ação → contrato → lacuna → teste

| Tela/estado | Ação | Contrato atual | Lacuna a fechar | Evidência automatizada |
| --- | --- | --- | --- | --- |
| Login | validar e-mail/senha | `POST /v1/auth/login` | incluir papel nas organizações e consumir resposta sem persistir token | HTTP anti-enumeração + componente de login |
| Seleção | escolher organização | `POST /v1/auth/select-organization` | variante de console que move refresh para cookie HttpOnly e omite refresh do JSON | cookie/headers/ausência do token no body |
| Restauração | recarregar a página | refresh por token no body | endpoint cookie-only, rotação, origem e CSRF | HTTP + integração de rotação e reutilização |
| Troca | ativar outra organização | selection token é uso único | troca autenticada, revalidação de membership e rotação atômica para novo tenant | concorrência, RBAC e limpeza de estado no browser |
| Logout | encerrar sessão | refresh no body | revogar por cookie e limpar cookies | HTTP, sessão inválida e UI |
| Shell | mostrar usuário, papel e organização | JWT contém tenant/papel | resposta de sessão com organizações permitidas | componente + E2E reload/switch |
| Conexões | listar com paginação | `GET /v1/instances` | cliente web, estados e paginação acessível | componente + E2E |
| Nova conexão | descobrir conta e criar | `POST /v1/instances` exige UUID | `GET /v1/provider-accounts`, sem credenciais | HTTP/RLS/IDOR + formulário |
| Detalhe | consultar instância/status | `GET /v1/instances/:id[/status]` | polling limitado/cancelável e erros de provider | timers, abort e E2E |
| Conectar | obter QR/pairing | `POST .../connect` | permitir nova intenção em `AWAITING_ACTION`, expiração e replay seguro | state machine + QR/URL hostil + E2E |
| Desconectar | encerrar sessão WhatsApp | `POST .../disconnect` | confirmação, idempotência e estados reais | HTTP + UI/E2E |
| API keys | listar/emitir/revogar | `/v1/api-keys` | UX de exibição única, cópia e resposta perdida | componente + RBAC + E2E |
| Erros | orientar suporte | problem+json + `X-Request-Id` | tradutor centralizado em pt-BR e sessão expirada | unidade + E2E |

## 3. Arquitetura da entrega

### 3.1 Monorepo

- `apps/web`: React 19.2.8, TypeScript strict, Vite 7.3.6, `@vitejs/plugin-react` 5.2.0, React Router 7.18.3 e testes Vitest 3.2.7/Testing Library. Essas versões são fixadas e compatíveis com Node 24.19.0 e entre si.
- `apps/api`: Fastify existente, acrescido das rotas específicas de sessão para navegador e descoberta de provider accounts.
- `packages/contracts`: schemas Zod canônicos para sessão de console e provider accounts.
- `packages/ui`: tokens e componentes visuais reutilizáveis sem regra de negócio.
- `apps/web/tests/e2e`: Playwright contra uma composição real da API JRC com repositórios reais e `FakeProviderAdapter` controlado somente em teste.

O `tsconfig.json` raiz passa a referenciar `packages/ui` e `apps/web`. `npm run build` executa `tsc -b` e o build Vite, produzindo `apps/web/dist`; o teste compilado verifica também o bundle web real.

### 3.2 Sessão de navegador

Os clientes existentes da API pública permanecem compatíveis com os endpoints JSON atuais. A console usa:

- `POST /v1/auth/login`: resposta com organizações e selection token de cinco minutos; ambos ficam somente em memória.
- `POST /v1/console/auth/select-organization`: consome atomicamente o selection token, define cookies e retorna access token, resumo seguro do usuário (`id` e e-mail normalizado), organização ativa e organizações permitidas.
- `POST /v1/console/auth/restore`: rotaciona refresh, restaura o access token em memória e devolve o mesmo resumo de sessão.
- `POST /v1/console/auth/switch-organization`: exige access token, refresh cookie, origem válida e CSRF; revalida membership e troca o tenant atomicamente.
- `POST /v1/console/auth/logout`: revoga a família e expira cookies; é idempotente.

O access token existe somente numa closure do cliente da API. Não é gravado em `localStorage`, `sessionStorage`, IndexedDB, cookie ou URL. O refresh nunca entra no JavaScript e nunca aparece no corpo de uma resposta da console. A identidade exibida vem do resumo seguro retornado pela API; o frontend não decodifica JWT para obter dados de apresentação.

Em HTTPS, o cookie de refresh é `__Host-jrc_refresh`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, com expiração coerente com a sessão. O cookie CSRF `__Host-jrc_csrf` é legível pelo frontend, tem as mesmas restrições de host e carrega um nonce assinado por HMAC-SHA-256 com `BROWSER_CSRF_SECRET`, separado de todos os demais segredos. Em desenvolvimento HTTP local usam-se nomes sem `__Host-` e `Secure=false`; essa exceção é recusada em produção.

Toda rota `/v1/console/auth/*` valida `Origin` contra `CONSOLE_ALLOWED_ORIGINS`. As operações que usam cookie também exigem `X-CSRF-Token`, assinatura válida e comparação constante com o cookie. Falha de origem, CSRF ou sessão retorna problem+json genérico, `Cache-Control: no-store` e limpa cookies inválidos quando apropriado.

Restore e switch rotacionam o refresh. Switch revoga a família anterior, cria uma nova família vinculada à organização escolhida e revalida usuário, organização e membership ativos na mesma transação `jrc_auth`. Corridas deixam no máximo um sucessor válido. O cliente usa single-flight para que 401 concorrentes compartilhem uma única restauração, sem reutilizar o refresh já rotacionado. O papel OWNER continua restrito à organização ativa; não existe papel global implícito.

Ao trocar de organização, o frontend aborta requests em voo, incrementa o escopo local, descarta todos os dados do tenant anterior e só então publica a nova sessão.

### 3.3 Provider accounts e isolamento

`GET /v1/provider-accounts?provider=BAILEYS&limit=...&cursor=...` retorna apenas `id`, `name`, `provider`, `createdAt` e paginação. Credenciais, `credential_reference`, referências internas e chave Evolution nunca saem da API.

A rota exige `instances:read`, executa sob `withOrganizationTransaction` e RLS, e não aceita `organization_id` do cliente. Um identificador de outro tenant produz ausência/404 sem revelar existência. A tela seleciona automaticamente a única conta BAILEYS lógica; múltiplas contas são exibidas como escolha nomeada.

### 3.4 Conexão e desafios

A state machine permite nova intenção de conexão, com nova chave idempotente, em `CREATED`, `DISCONNECTED`, `ERROR` e `AWAITING_ACTION`. Em `CONNECTING`, uma operação transitória ainda válida retorna `202/CONNECTION_PENDING`; lock/single-flight por instância impede chamadas duplicadas. Somente uma intenção comprovadamente expirada pode iniciar outra chamada ao provider. Isso possibilita renovar QR/pairing expirado após reload sem persistir o desafio no navegador.

Uma repetição da mesma intenção reutiliza exatamente a mesma chave e não tenta reconstruir um segredo perdido: o replay retorna `NONE/CONNECTION_PENDING`. A UI explica que QR/pairing não é recuperável e oferece uma nova intenção explícita, que gera nova chave. Mutação incerta mantém a chave em memória para a ação “tentar novamente”.

QR e pairing code existem apenas na resposta corrente e no estado volátil do componente. Não entram em logs, analytics, storage, URL, cache, relatórios ou screenshots reais. Base64/Data URL é validado estritamente como PNG antes de chegar a `img.src`; redirects e URLs arbitrárias não são navegados por este incremento.

O status usa polling de quatro segundos apenas nos estados transitórios, pausa quando a aba fica oculta, encerra em estado terminal e é cancelado ao desmontar/trocar tenant. Não há fila, websocket ou acesso direto à Evolution.

### 3.5 API keys

A emissão revela o segredo uma única vez em diálogo modal. O usuário precisa copiar explicitamente; fechar o diálogo apaga o valor do estado. Listagens mostram somente metadados e prefixo. Revogação exige confirmação pelo nome.

Se a resposta de emissão for perdida, a UI não promete recuperação. Ela atualiza a lista e orienta revogar a entrada possivelmente criada e emitir outra. OWNER e ADMIN gerenciam chaves; OPERATOR e VIEWER veem estado proibido, e o servidor continua sendo a autoridade.

## 4. Frontend e identidade visual

A console possui rotas `/login`, `/selecionar-organizacao`, `/conexoes`, `/conexoes/nova`, `/conexoes/:id` e `/chaves-api`. O shell traz navegação lateral, organização ativa, papel, troca de organização e logout. O mobile usa navegação recolhível e tabelas transformadas em cartões legíveis.

Tokens compartilhados:

- primária `#007392`;
- secundária `#2CB4F1`;
- destaque `#FDD704`;
- títulos `#153243`;
- superfícies, texto, bordas, foco, sucesso, aviso e perigo com contraste WCAG AA.

O logo oficial será servido localmente em `apps/web/public/brand/logo-jrc-2024.png`. Origem: `https://jrcpabx.com.br/assets/images/logo-jrc-2024.png`; referência cromática: `https://jrcpabx.com.br/assets/css/style.css`, consultadas em 2026-09-06. Proporção e transparência serão verificadas antes do uso. Não há hotlink.

Componentes possuem foco visível, labels, mensagens associadas por `aria-describedby`, live regions para operações e status com texto + ícone. Não há HTML não confiável, `dangerouslySetInnerHTML` ou links de provider abertos automaticamente.

## 5. Erros, observabilidade e segurança

O cliente normaliza problem+json em mensagens pt-BR e conserva `X-Request-Id` apenas para suporte. Erros internos, tokens e payloads do provider não são exibidos. Estados obrigatórios são loading, vazio, sucesso, erro validável, indisponível, proibido e sessão expirada.

Todas as novas rotas entram no OpenAPI, inventário de segurança e testes de RBAC/IDOR. O logger Fastify mantém redaction de `cookie`, `set-cookie`, `authorization`, CSRF, tokens, QR, pairing e corpos sensíveis. `VITE_*` contém somente configuração pública; nenhuma credencial ou URL administrativa entra no bundle.

O CI atual de `159ddfc` passa build, 341 testes sem Docker, 102 integrações, 2 testes compilados, OpenAPI, container, audit e boundaries, mas falha na geração da auditoria porque `AUDIT_FINGERPRINT_SECRET` está vazio. A correção é administrativa: criar um repository secret do GitHub Actions chamado exatamente `AUDIT_FINGERPRINT_SECRET`, com valor aleatório de pelo menos 16 caracteres, sem publicá-lo em chat ou arquivos. A validação e a ausência de fallback permanecem intactas.

## 6. Testes e critérios de aceite

- Unitários/HTTP: contratos Zod, cookie flags, origem, CSRF, rotação, logout, switch, RBAC, provider accounts, state machine e redaction.
- Integração: PostgreSQL/Redis real, duas organizações, RLS/IDOR, switch/reuse concorrente e grants `jrc_auth`/`jrc_app`.
- Frontend: componentes, formulários, roles, loading/empty/error/unavailable/forbidden, expiração, abort, XSS/URLs e acessibilidade com axe.
- E2E: API Fastify real com repositórios reais de teste e `FakeProviderAdapter`, cobrindo login → seleção → reload → troca → conexões → QR/pairing/status/disconnect → API key/revoke.
- Segurança: bundle e variáveis Vite sem canários/segredos; auditoria passa a tratar XSS e permissões do navegador como aplicáveis.
- Visual: screenshots sintéticos e sanitizados em desktop e mobile, sem senha, token, telefone ou QR real.
- Gates finais: build, typecheck, testes backend/frontend, integração, E2E, compiled, OpenAPI sem diff, container se alterado, `npm audit --audit-level=high`, boundaries, submódulo, auditoria e `git diff --check`.
- Smoke Evolution permanece opt-in e deve deprovisionar e confirmar ausência. Sem número de teste e ação humana, “homologação WhatsApp real pendente” é o único resultado permitido.

Aceite funcional significa que cada tela opera contra a API JRC, que um segundo tenant não lê nem muta dados do primeiro, que todas as ações respeitam RBAC e que reload/logout/switch não expõem nem reutilizam indevidamente credenciais. A auditoria deste incremento é publicada separadamente em `docs/security/phase-1-increment-2/`; os artefatos do Incremento 1 permanecem históricos e imutáveis.
