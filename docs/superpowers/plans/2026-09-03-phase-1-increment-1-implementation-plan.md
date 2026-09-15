# Fase 1 — Incremento 1: Backend multicliente e Baileys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar uma fatia vertical funcional do backend multicliente JRC, com autenticação segura, RBAC, API keys, auditoria, instâncias isoladas por organização e integração Baileys via Evolution sem expor contratos upstream.

**Architecture:** O incremento será um monólito modular em workspace npm, com Fastify em `apps/api`, contratos Zod e portas de provider em packages independentes e PostgreSQL protegido por RLS. Operações locais usam transações curtas com `SET LOCAL`; chamadas Evolution acontecem depois do commit e são reconciliáveis pela chave upstream determinística. Rotas públicas dependem somente de `WhatsAppProvider`; operações administrativas ficam em `WhatsAppProviderAdmin`.

**Tech Stack:** Node.js 24.19.0 LTS, TypeScript `strict`, npm workspaces, Fastify, PostgreSQL, Drizzle ORM, migrations SQL explícitas, Zod, Argon2id, JOSE, Vitest e Undici/fetch HTTP.

**Spec:** `docs/superpowers/specs/2026-09-03-phase-1-increment-1-backend-multitenant-baileys-design.md`

## Global Constraints

- Ler integralmente a especificação acima, `AGENTS.md` e `docs/superpowers/specs/2026-09-03-jrc-whatsapp-broker-design.md` antes da execução.
- Antes da Task 1, executar `git fetch origin` e criar `codex/phase-1-increment-1` exatamente a partir de `origin/codex/phase-0-baseline` com `git switch -c codex/phase-1-increment-1 origin/codex/phase-0-baseline`; todo o trabalho e eventual push pertencem somente a essa nova branch.
- Não alterar `main` nem continuar a implementação em `codex/phase-0-baseline`.
- Fixar Node.js 24.19.0 LTS em configuração local e CI; no Docker usar a mesma versão patch com digest SHA-256 imutável.
- Usar TypeScript `strict`, Fastify, PostgreSQL, Drizzle com migrations SQL explícitas, Zod e Vitest.
- Fazer TDD em cada tarefa: teste falhando, falha confirmada, implementação mínima e teste passando.
- Toda operação multicliente exige `organization_id`; `jrc_app` não pode ter `SUPERUSER` nem `BYPASSRLS`.
- Aplicar contexto RLS com `SET LOCAL`/`set_config(..., true)` em transações curtas e nunca chamar a Evolution dentro de transação PostgreSQL.
- Preservar licenças, avisos e atribuições; não modificar nenhum arquivo em `upstream/evolution-api` nem atualizar seu commit fixado.
- Nunca registrar senha, JWT, refresh token, API key, QR Code, pairing code, telefone ou credencial de provider.
- Não implementar frontend, Meta real, filas, worker funcional, webhooks completos, mensageria completa, faturamento ou WhatsApp Calling.
- Antes de cada commit planejado, apresentar diff, testes e riscos ao revisor e aguardar aprovação explícita. Antes de qualquer push, apresentar a série completa de commits e aguardar nova aprovação explícita.
- Os comandos `git commit` abaixo são instruções futuras condicionais; nenhum commit ou push faz parte da criação deste plano.

---

## Mapa de arquivos

| Caminho | Responsabilidade |
| --- | --- |
| `.nvmrc`, `.node-version`, `package.json`, `tsconfig.json`, `tsconfig.base.json`, `vitest.config.ts` | Node 24, project references, build e resolução de workspaces |
| `apps/api/src/app.ts`, `server.ts`, `config/env.ts` | composição Fastify, processo HTTP e configuração validada |
| `apps/api/src/db/{pools,tenant-transaction,schema}.ts` | pools separados, contexto RLS e exports Drizzle |
| `apps/api/drizzle/migrations/*.sql` | roles, tabelas, constraints, grants, RLS e triggers versionados |
| `apps/api/src/modules/organizations`, `users`, `memberships` | bootstrap, identidade e invariantes RBAC |
| `apps/api/src/modules/provider-accounts` | conta BAILEYS lógica por tenant, sem credencial Evolution |
| `apps/api/src/modules/auth` | login, seleção de organização, JWT, refresh, logout e proteção contra abuso |
| `apps/api/src/modules/auth/rate-limit` | porta de rate limit, memória para testes e Redis atômico no runtime |
| `apps/api/src/modules/api-keys` | emissão única, autenticação por prefixo/HMAC e revogação |
| `apps/api/src/modules/audit` | security audit pré-tenant e audit tenant-aware sanitizados |
| `apps/api/src/modules/instances` | provisionamento, conexão, status, desconexão e idempotência |
| `apps/api/src/modules/reconciliation` | caso de uso interno recuperável, desacoplado de rota/fila |
| `packages/contracts/src` | schemas Zod HTTP, paginação, problemas e DTOs canônicos |
| `packages/providers/src/contracts` | `WhatsAppProvider`, `WhatsAppProviderAdmin` e tipos canônicos |
| `packages/providers/src/{fake,evolution,meta}` | adapters falso, Evolution HTTP e esqueleto Meta |
| `packages/security/src` | Argon2id, JWT/tokens opacos, HMAC, desafios cifrados e redaction |
| `apps/api/tests/unit`, `http`, `integration`, `smoke` | pirâmide de testes sem Docker, PostgreSQL real e Evolution opt-in |
| `.github/workflows/ci.yml`, `infra/app/Dockerfile` | gates CI com PostgreSQL real e runtime Node 24 |
| `docs/api/openapi.json`, `docs/architecture/phase-1-increment-1.md` | contrato gerado e decisões operacionais finais |
| `docs/security-audit` | AUDIT-SPEC, dados, issues, gerador/gate e PDF de auditoria reproduzível |

## Protocolo de revisão para todas as tarefas

Ao terminar cada tarefa, executar os testes indicados, `git diff --check` e `git status --short`. Apresentar o diff dos arquivos da tarefa e registrar: testes executados, resultado, migration afetada, risco de segredo/log, risco de isolamento e confirmação de que o submódulo segue limpo. Somente após aprovação executar o commit sugerido. Não executar `git push` até o checkpoint final.

## Preflight obrigatório antes da Task 1

- [ ] Executar `node --version` e exigir saída exatamente `v24.19.0`.
- [ ] Executar `node -e "if (process.version !== 'v24.19.0') { console.error('Node v24.19.0 required'); process.exit(1) }"`.
- [ ] Executar `npm --version` apenas para registrar a versão efetiva no checkpoint.
- [ ] Se o Node divergir, interromper antes de instalar dependências ou alterar arquivos; não aceitar uma versão apenas compatível por major.
- [ ] Executar `git fetch origin` e depois `git status --short --branch`; exigir branch `codex/phase-0-baseline`, nenhum arquivo rastreado modificado e nenhum submódulo sujo.
- [ ] Executar `git rev-parse HEAD` e `git rev-parse origin/codex/phase-0-baseline`; exigir SHAs idênticos e registrar o SHA validado no checkpoint.
- [ ] Executar `git submodule status --recursive`, `git diff --exit-code --submodule=diff -- upstream/evolution-api` e `git -C upstream/evolution-api status --short`; exigir o gitlink Evolution fixado em `fa09d37892cdbb1d65a250155d293d92230c5b30`, submódulos inicializados e nenhuma alteração local.
- [ ] Executar `npm ci` e depois `npm test`; exigir todos os testes da Fase 0 passando a partir do lockfile atual.
- [ ] Executar `docker compose --env-file infra/baseline/.env.example -f infra/baseline/compose.yaml config`; exigir configuração válida, imagens fixadas e bind Evolution somente em `127.0.0.1`.
- [ ] Executar `docker compose --env-file infra/baseline/.env.example -f infra/baseline/compose.yaml ps`; exigir Evolution 2.3.7, PostgreSQL e Redis em execução/healthy. Não executar `docker compose up` automaticamente; se algum serviço não estiver pronto, interromper e apresentar o estado.
- [ ] Somente depois de todas as validações da Fase 0 passarem, criar a branch conforme Global Constraints e confirmar `git branch --show-current` = `codex/phase-1-increment-1`.

### Task 1: Fundação do workspace Node 24 e TypeScript strict

**Files:**
- Create: `.nvmrc`
- Create: `.node-version`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/tests/unit/app.test.ts`
- Create: `apps/api/tests/unit/workspace-resolution.test.ts`
- Create: `tests/compiled-workspace-resolution.test.mjs`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/providers/package.json`
- Create: `packages/providers/tsconfig.json`
- Create: `packages/providers/src/index.ts`
- Create: `packages/security/package.json`
- Create: `packages/security/tsconfig.json`
- Create: `packages/security/src/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: scripts de baseline existentes na raiz.
- Produces: `buildApp(): FastifyInstance`; packages com `exports`, `types` e referências TypeScript; scripts raiz `build`, `clean`, `start`, `typecheck`, `test`, `test:integration`, `test:smoke:evolution`, `openapi:generate` e workspaces `apps/*`, `packages/*`.

- [ ] **Step 1: Escrever o teste de composição mínimo**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('buildApp', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];
  afterEach(async () => Promise.all(apps.map((app) => app.close())));

  it('responde health sem iniciar socket', async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/unit/app.test.ts`

Expected: FAIL porque o workspace, Fastify e `buildApp` ainda não existem.

- [ ] **Step 3: Configurar workspace e implementação mínima**

Fixar `24.19.0` em `.nvmrc` e `.node-version`, alterar `engines.node` para `24.19.0`, habilitar workspaces e criar `tsconfig.base.json` com `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: NodeNext` e `moduleResolution: NodeNext`. O `tsconfig.json` raiz não compila arquivos diretamente e referencia, nesta ordem, `packages/contracts`, `packages/security`, `packages/providers` e `apps/api`; `npm run build` executa `tsc -b`, `npm run clean` executa `tsc -b --clean` e `npm start` executa `node apps/api/dist/server.js`.

```ts
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' as const }));
  return app;
}
```

- [ ] **Step 4: Instalar versões exatas no workspace proprietário e validar**

Run: `npm install --save-exact -w packages/contracts zod`

Run: `npm install --save-exact -w packages/security argon2 jose zod ipaddr.js`

Run: `npm install --save-exact -w apps/api fastify @fastify/swagger @fastify/swagger-ui fastify-type-provider-zod zod drizzle-orm pg redis`

Declarar dependências internas com a versão local `0.0.0`: `apps/api` depende de `@jrc/contracts`, `@jrc/providers` e `@jrc/security`; `packages/providers` depende de `@jrc/contracts`. O npm resolverá os packages do próprio workspace, sem buscar esses nomes no registry.

Run: `npm install --save-dev --save-exact typescript @types/node @types/pg vitest`

Cada package deve declarar `type: module`, `files: ["dist"]` e o export abaixo; cada `tsconfig.json` estende `tsconfig.base.json`, habilita `composite`/declarations e referencia apenas dependências anteriores no grafo. `apps/api` referencia os três packages.

```json
{
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Configurar `fastify-type-provider-zod` como compilador de validator/serializer e `@fastify/swagger` com `jsonSchemaTransform`, de modo que runtime e OpenAPI usem os mesmos schemas Zod.

Configurar `vitest.config.ts` com aliases explícitos `@jrc/contracts`, `@jrc/security` e `@jrc/providers` para seus respectivos `src/index.ts`; testes resolvem TypeScript fonte, enquanto o entrypoint compilado resolve os symlinks npm e os `exports` para `dist`. Adicionar um teste de resolução que importe cada package pelo nome público em Vitest e outro que execute os imports a partir de `dist` depois de `npm run build`.

Run: `npm run clean && npm run build && npm test -- apps/api/tests/unit/app.test.ts apps/api/tests/unit/workspace-resolution.test.ts tests/compiled-workspace-resolution.test.mjs && npm run typecheck`

Expected: `tsc -b` compila o grafo uma vez na ordem das referências, os imports resolvem em teste e em `dist`, o teste passa e não há erros TypeScript.

- [ ] **Step 5: Checkpoint e commit condicional**

Após o protocolo de revisão e aprovação: `git commit -m "chore: establish Node 24 TypeScript workspace"`.

### Task 2: Contratos canônicos HTTP, paginação e providers

**Files:**
- Create: `packages/contracts/src/{pagination,problems}.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/auth/schemas.ts`
- Create: `packages/contracts/src/instances/schemas.ts`
- Create: `packages/contracts/tests/contracts.test.ts`
- Create: `packages/providers/src/contracts/{provider,admin,types}.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `packages/providers/tests/contracts.test.ts`

**Interfaces:**
- Consumes: Zod e TypeScript strict da Task 1.
- Produces: `WhatsAppProvider`, `WhatsAppProviderAdmin`, `ConnectionAction`, `ProviderContext`, schemas de auth/instances e `Page<T>`.

- [ ] **Step 1: Escrever testes de união discriminada e independência upstream**

```ts
expect(ConnectionActionSchema.parse({
  type: 'NONE', reason: 'ALREADY_CONNECTED',
})).toEqual({ type: 'NONE', reason: 'ALREADY_CONNECTED' });
expect(() => ConnectionActionSchema.parse({ type: 'QR_CODE', value: 'x' })).toThrow();
expect(JSON.stringify(InstanceSchema.shape)).not.toMatch(/evolution|instanceName|apikey/i);
```

Adicionar testes para os cinco discriminantes, limites de paginação 1–100, UUIDs e problemas `application/problem+json`.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- packages/contracts/tests packages/providers/tests`

Expected: FAIL por módulos ausentes.

- [ ] **Step 3: Definir tipos e portas comuns/administrativas separadas**

```ts
export interface WhatsAppProvider {
  readonly kind: 'BAILEYS' | 'META';
  provisionInstance(ctx: ProviderContext, input: ProvisionInstanceInput): Promise<ProvisionedInstance>;
  beginConnection(ctx: ProviderContext, input: BeginConnectionInput): Promise<ConnectionAction>;
  getStatus(ctx: ProviderContext, ref: ProviderInstanceReference): Promise<ProviderStatus>;
  disconnect(ctx: ProviderContext, ref: ProviderInstanceReference): Promise<void>;
}

export interface WhatsAppProviderAdmin {
  lookupInstance(ctx: ProviderContext, ref: ProviderInstanceReference): Promise<ProviderInstanceLookup>;
  reconcileProvisioning(ctx: ProviderContext, input: ReconcileProvisioningInput): Promise<ProvisioningReconciliation>;
  deprovisionInstance(ctx: ProviderContext, ref: ProviderInstanceReference): Promise<void>;
}
```

`lookupInstance` é estritamente somente leitura: retorna `{ exists: false }` ou `{ exists: true; reference; status }`, não cria, reconecta, reconcilia nem altera estado upstream. Implementar schemas Zod sem nomes, códigos de erro ou identificadores Evolution.

- [ ] **Step 4: Validar contratos**

Run: `npm test -- packages/contracts/tests packages/providers/tests && npm run typecheck`

Expected: PASS; busca `rg -n "Evolution|apikey|instanceName" packages/contracts packages/providers/src/contracts` sem ocorrência pública.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: define canonical HTTP and provider contracts"`.

### Task 3: Primitivos de segurança, configuração e redaction

**Files:**
- Create: `packages/security/src/passwords/argon2id.ts`
- Create: `packages/security/src/tokens/{opaque,jwt}.ts`
- Create: `packages/security/src/api-keys/hmac.ts`
- Create: `packages/security/src/challenges/aes-gcm.ts`
- Create: `packages/security/src/redaction/logger.ts`
- Modify: `packages/security/src/index.ts`
- Create: `packages/security/tests/{passwords,hmac,challenges,redaction}.test.ts`
- Create: `apps/api/src/config/env.ts`
- Create: `apps/api/tests/unit/config.test.ts`
- Create: `apps/api/tests/unit/fastify-logger-redaction.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Web Crypto/Node crypto, Argon2 e Zod.
- Produces: `hashPassword`, `verifyPassword`, `verifyPasswordOrDummy`, `deriveIdentityRateLimitKey`, `deriveIpRateLimitKey`, `createApiKey`, `verifyApiKey`, `encryptChallenge`, `decryptChallenge`, `redactSensitive` e `AppConfig`.

- [ ] **Step 1: Escrever testes criptográficos e de separação de segredos**

```ts
it('faz trabalho Argon2id equivalente para usuário inexistente', async () => {
  await expect(verifyPasswordOrDummy('secret', null)).resolves.toBe(false);
});

it('não inclui e-mail na chave de rate limit', () => {
  const key = deriveIdentityRateLimitKey(' User@Example.COM ', identitySecret);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).not.toContain('user@example.com');
});

it.each([
  ['192.0.2.10', '192.0.2.10'],
  ['2001:db8::1', '2001:db8:0:0:0:0:0:1'],
])('normaliza IPv4/IPv6 antes do HMAC', (canonical, equivalent) => {
  expect(deriveIpRateLimitKey(canonical, ipSecret)).toBe(deriveIpRateLimitKey(equivalent, ipSecret));
});
```

Testar autenticação constante do HMAC, round-trip AES-256-GCM, falha com tag alterada e redaction no logger Fastify real. Injetar um sink de teste, emitir request/response e erro, e provar a remoção de `authorization`, `cookie`, `set-cookie`, `x-jrc-api-key`, `apikey`, senha, JWT, refresh/selection token, QR, pairing code, telefone e corpos upstream.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- packages/security/tests apps/api/tests/unit/config.test.ts apps/api/tests/unit/fastify-logger-redaction.test.ts`

Expected: FAIL por exports ausentes.

- [ ] **Step 3: Implementar primitivas e validação de configuração**

Usar Argon2id com parâmetros centralizados; token opaco de 32 bytes; API key `jrc_<prefix>_<secret>` armazenando somente prefixo e HMAC-SHA-256; `timingSafeEqual`; AES-256-GCM com nonce aleatório. Usar `ipaddr.js` para validar e canonicalizar IPv4/IPv6 antes de `deriveIpRateLimitKey`; entradas inválidas falham antes do HMAC. O schema deve exigir segredos distintos para JWT, refresh/selection hash, API key HMAC, IP-rate-limit HMAC, identity-rate-limit HMAC e challenge encryption. `buildApp` deve construir o logger Fastify com paths de redaction e serializers allowlist; nunca logar body de auth, API keys, challenge ou resposta Evolution.

```ts
if (new Set(secretValues).size !== secretValues.length) {
  throw new Error('Security secrets must be distinct');
}
```

- [ ] **Step 4: Validar segurança**

Run: `npm test -- packages/security/tests apps/api/tests/unit/config.test.ts apps/api/tests/unit/fastify-logger-redaction.test.ts && npm run typecheck`

Expected: PASS; snapshots/logs não contêm valores marcados como secretos.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: add isolated security primitives"`.

### Task 4: Migrations de roles, schema base, constraints e grants

**Files:**
- Create: `apps/api/drizzle/migrations/0001_roles.sql`
- Create: `apps/api/drizzle/migrations/0002_identity_and_audit.sql`
- Create: `apps/api/drizzle/migrations/0003_providers_and_instances.sql`
- Create: `apps/api/drizzle/migrations/0004_rls_and_grants.sql`
- Create: `apps/api/drizzle/migrations/meta/_journal.json`
- Create: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/migrate.ts`
- Create: `apps/api/tests/integration/helpers/postgres.ts`
- Create: `apps/api/tests/integration/helpers/global-role-lock.ts`
- Create: `apps/api/tests/integration/migrations.test.ts`
- Create: `infra/app/postgres/init-roles.sql`

**Interfaces:**
- Consumes: modelo da especificação e `AppConfig`.
- Produces: roles `jrc_migrator`, `jrc_app`, `jrc_auth`; tabelas e constraints nomeadas; `runMigrations(connectionString): Promise<void>`.

- [ ] **Step 1: Escrever teste de migration do zero e grants**

```ts
expect(await roleAttribute(client, 'jrc_app', 'rolbypassrls')).toBe(false);
expect(await roleAttribute(client, 'jrc_app', 'rolsuper')).toBe(false);
await expect(queryAs('jrc_auth', 'select * from instances')).rejects.toThrow(/permission denied/);
expect(await constraintExists('idempotency_records_org_route_key_unique')).toBe(true);
expect(await constraintExists('instances_upstream_instance_key_unique')).toBe(true);
expect(await constraintExists('api_keys_prefix_global_unique')).toBe(true);
```

O helper deve exigir `TEST_DATABASE_ADMIN_URL`, criar database/schema isolado por worker e removê-lo no `afterAll`. A criação/alteração das roles globais deve adquirir, em uma conexão administrativa dedicada, `pg_advisory_lock(hashtextextended('jrc-test-global-roles', 0))`, executar a migration de roles uma única vez e liberar em `finally`; databases/schemas de cada worker continuam paralelos depois desse ponto.

- [ ] **Step 2: Confirmar a falha em PostgreSQL real**

Run: `npm run test:integration -- apps/api/tests/integration/migrations.test.ts`

Expected: FAIL porque migrations e roles não existem.

- [ ] **Step 3: Criar SQL explícito e schema Drizzle correspondente**

Criar todas as entidades da seção 5, enums, FKs compostas por tenant, índices, unicidades e trigger diferida do último OWNER. `login_sessions` armazena somente `token_hash`, `expires_at`, `consumed_at` e contexto mínimo; um update condicional deve permitir consumo único atômico. Além da unicidade tenant-aware do nome, `api_keys.prefix` recebe constraint `UNIQUE` global. `jrc_migrator` é owner; revogar `PUBLIC`; conceder a `jrc_auth` somente identity/login/refresh/security audit e a `jrc_app` somente objetos de negócio necessários.

- [ ] **Step 4: Rodar migrations duas vezes e validar**

Run: `npm run db:migrate:test && npm run db:migrate:test && npm run test:integration -- apps/api/tests/integration/migrations.test.ts`

Expected: duas execuções seguras e testes PASS.

- [ ] **Step 5: Checkpoint e commit condicional**

Apresentar SQL completo e matriz de grants. Após aprovação: `git commit -m "feat: add multitenant PostgreSQL schema and roles"`.

### Task 5: Pools separados, transação tenant e RLS sem vazamento

**Files:**
- Create: `apps/api/src/db/pools.ts`
- Create: `apps/api/src/db/tenant-transaction.ts`
- Create: `apps/api/tests/integration/{rls,pool-isolation,transaction-boundary}.test.ts`

**Interfaces:**
- Consumes: roles e schema da Task 4.
- Produces: `createDatabasePools(config): DatabasePools`; `withOrganizationTransaction<T>(pool, organizationId, operation): Promise<T>`.

- [ ] **Step 1: Escrever testes RLS e pool**

```ts
await expect(withOrganizationTransaction(appPool, orgA, (tx) => listInstances(tx))).resolves.toEqual([instanceA]);
await expect(withOrganizationTransaction(appPool, orgB, (tx) => listInstances(tx))).resolves.toEqual([]);
const { value } = await appPool.query("select current_setting('app.organization_id', true) as value").then(oneRow);
expect([null, '']).toContain(value);
```

Repetir em conexões reutilizadas após commit e rollback; aceitar somente `NULL` ou string vazia fora da transação e falhar para UUID/qualquer outro valor; em seguida executar consulta RLS sem contexto e exigir zero linhas. Testar INSERT/UPDATE/DELETE cruzado e que `jrc_auth` não acessa tenant tables.

- [ ] **Step 2: Confirmar a falha**

Run: `npm run test:integration -- apps/api/tests/integration/rls.test.ts apps/api/tests/integration/pool-isolation.test.ts`

Expected: FAIL sem helper/policies aplicadas.

- [ ] **Step 3: Implementar helper de transação curta**

```ts
export async function withOrganizationTransaction<T>(pool: Pool, organizationId: string, fn: (tx: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.organization_id', $1, true)", [organizationId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Validar RLS e boundary**

Run: `npm run test:integration -- apps/api/tests/integration/rls.test.ts apps/api/tests/integration/pool-isolation.test.ts apps/api/tests/integration/transaction-boundary.test.ts`

Expected: PASS; `current_setting` é exclusivamente `NULL`/empty seguro fora das transações, e nenhuma conexão reutilizada conserva UUID de tenant.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: enforce tenant RLS transaction context"`.

### Task 6: Auditoria pré-auth e tenant-aware

**Files:**
- Create: `apps/api/src/modules/audit/{security-audit,audit,events}.ts`
- Create: `apps/api/tests/unit/audit-redaction.test.ts`
- Create: `apps/api/tests/integration/audit-rls.test.ts`

**Interfaces:**
- Consumes: redaction da Task 3 e transação tenant da Task 5.
- Produces: `writeSecurityAudit(event): Promise<void>` e `writeTenantAudit(tx, event): Promise<void>` com eventos discriminados.

- [ ] **Step 1: Escrever testes de separação e sanitização**

```ts
await writeSecurityAudit({ type: 'AUTH_RATE_LIMITED', requestId, identityDigest, ipDigest });
expect(await readSecurityAudit()).not.toMatchObject({ email: expect.anything() });
await writeTenantAudit(txA, { type: 'INSTANCE_CREATED', actorId, resourceId });
expect(await readAuditAs(orgB)).toEqual([]);
```

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/unit/audit-redaction.test.ts && npm run test:integration -- apps/api/tests/integration/audit-rls.test.ts`

Expected: FAIL por writers ausentes.

- [ ] **Step 3: Implementar allowlist de campos por evento**

Não aceitar objetos arbitrários. Cada evento mapeia apenas IDs, digest, outcome, request ID e metadados canônicos sem bodies/headers upstream.

- [ ] **Step 4: Validar**

Run: `npm test -- apps/api/tests/unit/audit-redaction.test.ts && npm run test:integration -- apps/api/tests/integration/audit-rls.test.ts`

Expected: PASS.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: add separated sanitized audit trails"`.

### Task 7: Bootstrap e onboarding administrativo de tenants

**Files:**
- Create: `apps/api/src/modules/organizations/{repository,bootstrap,tenant-create}.ts`
- Create: `apps/api/src/modules/users/repository.ts`
- Create: `apps/api/src/modules/memberships/{repository,service}.ts`
- Create: `apps/api/src/modules/provider-accounts/repository.ts`
- Create: `apps/api/src/commands/{bootstrap,tenant-create,secure-input}.ts`
- Create: `apps/api/tests/unit/{bootstrap,tenant-create}.test.ts`
- Create: `apps/api/tests/integration/{bootstrap,tenant-create,membership-owner-invariant}.test.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: Argon2id, migrator/admin pool, audit writers da Task 6, membership schema e provider-account schema.
- Produces: `bootstrapFirstTenant(input): Promise<BootstrapResult>`; `createTenant(input): Promise<TenantCreateResult>`; `changeMembership(actor, command): Promise<void>`; `ensureLogicalBaileysAccount(tx, organizationId): Promise<ProviderAccount>`; comandos internos `bootstrap` e `tenant:create`.

- [ ] **Step 1: Escrever testes do bootstrap, onboarding e regra OWNER**

```ts
await bootstrapFirstTenant({ organizationName: 'JRC', organizationSlug: 'jrc', email, password });
expect(await counts()).toEqual({ organizations: 1, users: 1, owners: 1, baileysProviderAccounts: 1 });
await expect(bootstrapFirstTenant(secondInput)).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_COMPLETED' });
await createTenant({ organizationName: 'Cliente', organizationSlug: 'cliente', ownerEmail, ownerPassword });
expect(await tenantCounts('cliente')).toEqual({ organizations: 1, users: 1, owners: 1, baileysProviderAccounts: 1 });
await expect(createTenant({ ownerMode: 'CREATE_NEW', ownerEmail: existingEmail, ownerPassword }))
  .rejects.toMatchObject({ code: 'OWNER_EMAIL_ALREADY_EXISTS' });
expect(await passwordHashFor(existingEmail)).toBe(originalPasswordHash);
await expect(removeMembership(lastOwnerActor, lastOwnerId)).rejects.toMatchObject({ code: 'LAST_OWNER' });
```

Testar rollback atômico em cada ponto de falha, duas criações concorrentes do mesmo slug/e-mail, duas transações removendo/rebaixando OWNER e ausência de senha/hash na saída e auditoria.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/unit/bootstrap.test.ts apps/api/tests/unit/tenant-create.test.ts && npm run test:integration -- apps/api/tests/integration/bootstrap.test.ts apps/api/tests/integration/tenant-create.test.ts apps/api/tests/integration/membership-owner-invariant.test.ts`

Expected: FAIL por comandos/casos de uso ausentes.

- [ ] **Step 3: Implementar os dois comandos administrativos e RBAC de membership**

O bootstrap usa advisory lock e só aceita banco sem organização. `tenant:create` recusa execução sem credencial operacional administrativa local, funciona após o bootstrap e cria organização, primeiro OWNER, membership e exatamente um `provider_account` BAILEYS lógico em uma transação. Em `ownerMode: CREATE_NEW`, a senha vem de prompt oculto e e-mail já existente retorna `OWNER_EMAIL_ALREADY_EXISTS` sem alterar nada. Em `ownerMode: LINK_EXISTING`, o comando exige confirmação administrativa explícita, reutiliza somente usuário ativo, não solicita/aceita senha e cria apenas a nova membership OWNER; o `password_hash` existente nunca é atualizado. Ambos os modos não armazenam a credencial Evolution e escrevem eventos sanitizados. Somente OWNER altera OWNER; ADMIN só gerencia papéis não-OWNER e nunca assume propriedade implicitamente.

- [ ] **Step 4: Validar unidade, atomicidade e concorrência**

Run: `npm test -- apps/api/tests/unit/bootstrap.test.ts apps/api/tests/unit/tenant-create.test.ts && npm run test:integration -- apps/api/tests/integration/bootstrap.test.ts apps/api/tests/integration/tenant-create.test.ts apps/api/tests/integration/membership-owner-invariant.test.ts`

Expected: PASS; cada tenant tem um OWNER e um BAILEYS account, e nenhum output contém senha/hash.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: add safe bootstrap and tenant onboarding"`.

### Task 8: Login, anti-enumeração e seleção de organização

**Files:**
- Create: `apps/api/src/modules/auth/{repository,login,select-organization,delay}.ts`
- Create: `apps/api/src/modules/auth/rate-limit/{store,memory-store,redis-store,keys}.ts`
- Create: `apps/api/src/http/routes/auth.ts`
- Create: `apps/api/tests/unit/{login,auth-rate-limit}.test.ts`
- Create: `apps/api/tests/http/auth-login.test.ts`
- Create: `apps/api/tests/integration/{auth-grants,redis-rate-limit}.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `verifyPasswordOrDummy`, HMACs separados de IP/identidade, `jrc_auth`, Redis runtime, security audit e schemas auth.
- Produces: `RateLimitStore.consume(key, limit, ttlMs): Promise<RateLimitDecision>`; `MemoryRateLimitStore` somente para testes; `RedisRateLimitStore` para runtime; `login(command): Promise<LoginOrganizations>`; `selectOrganization(command): Promise<AuthTokens>`; endpoints `/v1/auth/login` e `/v1/auth/select-organization` registrados por `buildApp`.

- [ ] **Step 1: Escrever testes de respostas uniformes e rate limit**

```ts
for (const input of [unknownEmail, wrongPassword, invalidOrganization]) {
  const response = await app.inject({ method: 'POST', url: input.url, payload: input.payload });
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  expect(response.headers['cache-control']).toBe('no-store');
}
expect(passwordVerifier.verifyDummy).toHaveBeenCalledForUnknownUser();
expect(rateLimitStore.keys()).not.toContain(normalizedEmail);
await selectOrganization(selectionToken, orgId);
await expect(selectOrganization(selectionToken, orgId)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
await expect(selectOrganization(expiredSelectionToken, orgId)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
expect((await Promise.allSettled([
  selectOrganization(concurrentToken, orgId),
  selectOrganization(concurrentToken, orgId),
])).filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
```

Usar relógio/sleeper injetáveis para provar atraso progressivo com teto, rate limit por IP e digest HMAC da identidade, sem reter conexão DB durante o atraso. Testar TTL e incrementos concorrentes tanto no adapter em memória quanto no Redis real. `X-Forwarded-For` só influencia o IP quando o socket remoto pertence à allowlist CIDR de proxies confiáveis; caso contrário, Fastify ignora o header e usa `remoteAddress`.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/unit/login.test.ts apps/api/tests/unit/auth-rate-limit.test.ts apps/api/tests/http/auth-login.test.ts`

Expected: FAIL por rotas e serviços ausentes.

- [ ] **Step 3: Implementar login em duas etapas**

Login consulta por e-mail normalizado via `jrc_auth`, sempre realiza Argon2 real ou fictício e retorna organizações permitidas com token de seleção opaco de 256 bits, TTL exato de 5 minutos e persistência apenas do hash. A seleção executa `UPDATE login_sessions SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id` e, na mesma transação, revalida membership e cria o refresh token; zero linhas produz a mesma resposta genérica para expirado, inválido ou reutilizado. Apenas uma seleção concorrente vence. O JWT de acesso usa exclusivamente `HS256`, issuer `jrc-whatsapp-broker`, audience `jrc-api`, TTL de 10 minutos e segredo de pelo menos 256 bits; verificação rejeita outro algoritmo/issuer/audience e contém `sub`, `organization_id`, `role`, `jti`, `iat`, `exp`. Antes de qualquer persistência no rate-limit store, transformar IP e e-mail normalizado em HMAC-SHA-256 com segredos distintos; Redis nunca recebe IP/e-mail em claro. O Redis adapter usa operação atômica Lua/transaction para incremento+TTL. Se Redis estiver indisponível no runtime, falhar fechado com `503 AUTH_TEMPORARILY_UNAVAILABLE`, `Retry-After`, resposta genérica e `security_audit_log` sanitizado; não consultar usuário nem verificar senha nessa condição. `buildApp` usa Redis em todo runtime; `MemoryRateLimitStore` só pode ser injetado por fixtures sob `NODE_ENV=test` e deve ser rejeitado em qualquer outro ambiente.

- [ ] **Step 4: Validar proteção e grants**

Run: `npm test -- apps/api/tests/unit/login.test.ts apps/api/tests/unit/auth-rate-limit.test.ts apps/api/tests/http/auth-login.test.ts && npm run test:integration -- apps/api/tests/integration/auth-grants.test.ts apps/api/tests/integration/redis-rate-limit.test.ts`

Expected: PASS, respostas genéricas e nenhum e-mail em contadores/auditoria.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: add enumeration-resistant tenant login"`.

### Task 9: Refresh rotativo, reutilização e logout

**Files:**
- Create: `apps/api/src/modules/auth/{refresh,logout}.ts`
- Modify: `apps/api/src/http/routes/auth.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/tests/unit/refresh.test.ts`
- Create: `apps/api/tests/http/auth-session.test.ts`
- Create: `apps/api/tests/integration/refresh-rotation.test.ts`

**Interfaces:**
- Consumes: token hash, `jrc_auth`, JWT e audit.
- Produces: `refreshSession(rawToken): Promise<AuthTokens>`; `logout(rawToken): Promise<void>`; endpoints `/v1/auth/refresh` e `/v1/auth/logout`.

- [ ] **Step 1: Escrever testes de rotação e reuse detection**

```ts
const rotated = await refreshSession(original.raw);
expect(rotated.refreshToken).not.toBe(original.raw);
await expect(refreshSession(original.raw)).rejects.toMatchObject({ code: 'INVALID_SESSION' });
expect(await familyIsRevoked(original.familyId)).toBe(true);
```

Testar corrida de dois refreshes, revogação por família, logout idempotente, hash-only e `Cache-Control: no-store`.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/unit/refresh.test.ts apps/api/tests/http/auth-session.test.ts`

Expected: FAIL por serviços ausentes.

- [ ] **Step 3: Implementar rotação transacional**

Bloquear token por hash, marcar substituição, inserir sucessor na mesma transação; ao detectar reutilização, revogar família e emitir security audit sanitizado.

- [ ] **Step 4: Validar corrida real**

Run: `npm test -- apps/api/tests/unit/refresh.test.ts apps/api/tests/http/auth-session.test.ts && npm run test:integration -- apps/api/tests/integration/refresh-rotation.test.ts`

Expected: PASS; somente um refresh concorrente vence.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: rotate and revoke refresh sessions"`.

### Task 10: Autorização RBAC e API keys

**Files:**
- Create: `apps/api/src/http/plugins/{authentication,authorization}.ts`
- Create: `apps/api/src/modules/api-keys/{repository,service}.ts`
- Create: `apps/api/src/http/routes/api-keys.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/tests/unit/rbac.test.ts`
- Create: `apps/api/tests/http/api-keys.test.ts`
- Create: `apps/api/tests/integration/api-keys.test.ts`

**Interfaces:**
- Consumes: JWT, HMAC API key, RLS e audit.
- Produces: `authenticateRequest`, `requirePermission(permission)`, `issueApiKey`, `listApiKeys`, `revokeApiKey`; rotas de API key registradas por `buildApp`.

- [ ] **Step 1: Escrever matriz RBAC e ciclo da API key**

```ts
expect(can('OWNER', 'api_keys:manage')).toBe(true);
expect(can('ADMIN', 'memberships:change_owner')).toBe(false);
expect(can('VIEWER', 'instances:connect')).toBe(false);
const created = await issueApiKey(ctx, input);
expect(created.secret).toMatch(/^jrc_/);
expect(await persistedRow(created.id)).not.toHaveProperty('secret');
await expect(insertApiKeyForAnotherOrganization({ prefix: created.prefix }))
  .rejects.toMatchObject({ constraint: 'api_keys_prefix_global_unique' });
```

Testar segredo exibido uma vez, prefixo/HMAC somente, comparação constante, prefixo globalmente único entre organizações, regeneração segura após colisão simulada, escopos, expiração, revogação, paginação e `no-store`.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/unit/rbac.test.ts apps/api/tests/http/api-keys.test.ts`

Expected: FAIL por guards/serviço ausentes.

- [ ] **Step 3: Implementar guards e API keys tenant-aware**

Resolver identidade JWT ou `X-JRC-API-Key`, nunca ambas; construir contexto com organização ativa; executar cada consulta em `withOrganizationTransaction`; retornar 404 para recurso de outro tenant. Gerar prefixo com entropia suficiente, tentar o INSERT e, em colisão exclusiva da constraint global `api_keys_prefix_global_unique`, gerar novo prefixo até o máximo fixo de 5 tentativas; qualquer outra violação é propagada e nenhuma chave bruta é persistida/logada.

- [ ] **Step 4: Validar HTTP e persistência**

Run: `npm test -- apps/api/tests/unit/rbac.test.ts apps/api/tests/http/api-keys.test.ts && npm run test:integration -- apps/api/tests/integration/api-keys.test.ts`

Expected: PASS.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: enforce RBAC and hashed API keys"`.

### Task 11: FakeProviderAdapter, Meta tipado e registry

**Files:**
- Create: `packages/providers/src/fake/fake-provider-adapter.ts`
- Create: `packages/providers/src/meta/meta-provider-adapter.ts`
- Create: `packages/providers/src/registry.ts`
- Create: `packages/providers/tests/{fake-provider,meta-provider,registry}.test.ts`

**Interfaces:**
- Consumes: portas da Task 2.
- Produces: `FakeProviderAdapter implements WhatsAppProvider & WhatsAppProviderAdmin`; `MetaProviderAdapter implements WhatsAppProvider`; `ProviderRegistry.getProvider(kind): WhatsAppProvider`; `ProviderRegistry.getAdminProvider(kind): WhatsAppProviderAdmin`.

- [ ] **Step 1: Escrever testes de contrato reutilizáveis**

```ts
runProviderContractTests(() => new FakeProviderAdapter());
await expect(new MetaProviderAdapter().provisionInstance(ctx, input))
  .rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' });
expect(registry.getProvider('BAILEYS')).toBe(fake);
expect(registry.getAdminProvider('BAILEYS')).toBe(fake);
expect(() => registry.getAdminProvider('META')).toThrow('PROVIDER_ADMIN_NOT_AVAILABLE');
```

O fake deve registrar chamadas, permitir respostas/erros determinísticos e verificar `AbortSignal`/deadline.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- packages/providers/tests/fake-provider.test.ts packages/providers/tests/meta-provider.test.ts`

Expected: FAIL por adapters ausentes.

- [ ] **Step 3: Implementar os adapters mínimos**

Não importar nenhum módulo Evolution no fake, Meta ou contratos. Manter mapas separados para providers comuns e administrativos; não usar cast estrutural para promover o Meta. O Meta não implementa nem é registrado em `WhatsAppProviderAdmin`, e todas as operações comuns retornam o erro canônico indisponível.

- [ ] **Step 4: Validar contratos**

Run: `npm test -- packages/providers/tests && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "test: add fake provider and typed Meta skeleton"`.

### Task 12: EvolutionProviderAdapter HTTP e timeouts explícitos

**Files:**
- Create: `packages/providers/src/evolution/{client,mappers,evolution-provider-adapter}.ts`
- Create: `packages/providers/tests/evolution-provider-adapter.test.ts`
- Create: `packages/providers/tests/fixtures/evolution-responses.ts`

**Interfaces:**
- Consumes: `WhatsAppProvider`, `WhatsAppProviderAdmin`, credencial JRC e fetch injetável.
- Produces: `EvolutionProviderAdapter implements WhatsAppProvider, WhatsAppProviderAdmin` e `EvolutionTimeouts` por operação.

- [ ] **Step 1: Escrever testes HTTP do adapter**

```ts
expect(await adapter.beginConnection(ctx, input)).toEqual({
  type: 'QR_CODE', encoding: 'BASE64', value: 'abc', expiresAt: fixedExpiry,
});
expect(recordedRequest.headers).toMatchObject({ apikey: platformSecret });
expect(JSON.stringify(publicResult)).not.toContain('apikey');
await expect(timeoutAdapter.getStatus(shortCtx, ref)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
```

Cobrir provisionar, `lookupInstance` somente leitura por chave/referência, QR, pairing code, NONE, status, desconectar, reconciliar e deprovisionar. Validar que lookup usa apenas requisição GET/read-only e não dispara criação/conexão; validar também redaction de request/response/headers e timeouts distintos.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- packages/providers/tests/evolution-provider-adapter.test.ts`

Expected: FAIL por adapter ausente.

- [ ] **Step 3: Implementar client e mapeadores privados**

Usar URL interna configurada, secret somente em header interno, `AbortSignal.any` com timeout da operação, erros canônicos e mappers que descartam campos desconhecidos. A chave upstream vem da JRC; tenant nunca fornece credencial.

- [ ] **Step 4: Validar adapter**

Run: `npm test -- packages/providers/tests/evolution-provider-adapter.test.ts && npm run typecheck`

Expected: PASS e nenhum snapshot contém o segredo administrativo.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: add isolated Evolution provider adapter"`.

### Task 13: Casos de uso de instâncias, idempotência e reconciliação

**Files:**
- Create: `apps/api/src/modules/instances/{repository,service,idempotency,upstream-key}.ts`
- Create: `apps/api/src/modules/reconciliation/reconcile-provisioning.ts`
- Create: `apps/api/tests/unit/{instance-service,idempotency,reconciliation}.test.ts`
- Create: `apps/api/tests/integration/{instance-isolation,idempotency}.test.ts`

**Interfaces:**
- Consumes: provider comum/admin, RLS, audit e schema de instances.
- Produces: `createInstance`, `listInstances`, `getInstance`, `connectInstance`, `getInstanceStatus`, `disconnectInstance`, `reconcileProvisioning`.

- [ ] **Step 1: Escrever testes do fluxo em duas transações**

```ts
const created = await service.createInstance(ctx, command);
expect(txTimeline).toEqual(['begin', 'commit', 'provider.provision', 'begin', 'commit']);
expect(created.status).toBe('CREATED');
expect(provider.calls.provision[0].input.upstreamInstanceKey).toBe(expectedDeterministicKey);
```

Testar `PROVISIONING_FAILED`, timeout → `reconciliation_required`, `lookupInstance` seguido de retry pela mesma chave somente quando ausente, conflito de idempotência 409, replay 202/NONE, desafio nunca serializado no registro e acesso cruzado sem chamada ao provider. A confirmação de ausência isolada usa `lookupInstance`; `reconcileProvisioning` permanece um comando potencialmente mutável e nunca é tratado como consulta.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/unit/instance-service.test.ts apps/api/tests/unit/idempotency.test.ts apps/api/tests/unit/reconciliation.test.ts`

Expected: FAIL por casos de uso ausentes.

- [ ] **Step 3: Implementar state machine e transações separadas**

Gerar `upstream_instance_key` de UUID interno, sem PII. Persistir `PROVISIONING` e operação, commitar, chamar provider, então atualizar em nova transação. Reconciliação usa somente `WhatsAppProviderAdmin`, é independente de Fastify e não agenda fila.

- [ ] **Step 4: Validar unidade e PostgreSQL**

Run: `npm test -- apps/api/tests/unit/instance-service.test.ts apps/api/tests/unit/idempotency.test.ts apps/api/tests/unit/reconciliation.test.ts && npm run test:integration -- apps/api/tests/integration/instance-isolation.test.ts apps/api/tests/integration/idempotency.test.ts`

Expected: PASS; unique constraints resolvem corridas sem duplicar upstream.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: add recoverable tenant instance lifecycle"`.

### Task 14: Criptografia/TTL de desafios e endpoints de instâncias

**Files:**
- Create: `apps/api/src/modules/instances/challenges.ts`
- Create: `apps/api/src/http/routes/instances.ts`
- Create: `apps/api/src/http/plugins/request-context.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/tests/http/instances.test.ts`
- Create: `apps/api/tests/integration/challenges.test.ts`

**Interfaces:**
- Consumes: casos de uso Task 13, AES-GCM, fake provider, RBAC e Zod.
- Produces: seis endpoints `/v1/instances`; `X-Request-Id`; challenge store cifrado com consume/expiry.

- [ ] **Step 1: Escrever testes HTTP completos com fake**

```ts
const response = await app.inject({
  method: 'POST', url: `/v1/instances/${id}/connect`,
  headers: authHeaders({ 'idempotency-key': 'connect-1', 'x-request-id': requestId }),
});
expect(response.statusCode).toBe(200);
expect(response.headers['x-request-id']).toBe(requestId);
expect(response.headers['cache-control']).toBe('no-store');
expect(response.json()).toMatchObject({ action: { type: 'QR_CODE' } });
```

Cobrir POST/list/detail/connect/status/disconnect, cursor 20/100, invalid request ID, problem+json, permissões, 404 cross-org sem chamada fake, replay e `Pragma: no-cache`.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/http/instances.test.ts`

Expected: FAIL por rotas ausentes.

- [ ] **Step 3: Implementar rotas finas e challenge store**

Rotas validam Zod, montam contexto e delegam. Persistir desafio somente quando replay exigir, sempre AES-256-GCM + nonce + TTL + vínculo org/instance/op; remover após consumo/expiração. Nunca incluir desafio em idempotency response aberta.

- [ ] **Step 4: Validar HTTP e storage**

Run: `npm test -- apps/api/tests/http/instances.test.ts && npm run test:integration -- apps/api/tests/integration/challenges.test.ts`

Expected: PASS; consulta direta mostra somente ciphertext/nonce, nunca QR/pairing em claro.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "feat: expose secure JRC instance endpoints"`.

### Task 15: OpenAPI, servidor, Docker interno e documentação operacional

**Files:**
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/http/openapi.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/tests/http/{openapi,request-id,security-headers}.test.ts`
- Create: `tests/compiled-entrypoint.test.mjs`
- Create: `scripts/test-container-entrypoint.mjs`
- Create: `infra/app/Dockerfile`
- Create: `infra/app/node-image.lock`
- Create: `infra/app/compose.yaml`
- Create: `infra/app/compose.test.yaml`
- Create: `apps/web/README.md`
- Create: `apps/worker/README.md`
- Create: `packages/ui/README.md`
- Create: `docs/architecture/phase-1-increment-1.md`
- Generate: `docs/api/openapi.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: todas as rotas e config.
- Produces: `startServer(config)`, OpenAPI reprodutível e imagem Node 24 com Evolution somente na rede interna.

- [ ] **Step 1: Escrever testes de OpenAPI e headers**

```ts
expect(spec.paths).toHaveProperty('/v1/instances');
expect(spec.paths).not.toHaveProperty('/v1/instances/{id}/deprovision');
expect(JSON.stringify(spec)).not.toMatch(/Evolution|apikey|reconcileProvisioning|deprovisionInstance/i);
expect(authResponse.headers['cache-control']).toBe('no-store');
expect((await productionApp.inject('/documentation')).statusCode).toBe(404);
```

Testar todos os endpoints, schemas, security schemes, paginação, `X-Request-Id`, problem+json e diff determinístico do OpenAPI gerado. Swagger UI fica desabilitado por padrão e `/documentation` retorna 404 em production; habilitação exige `SWAGGER_UI_ENABLED=true` e bind interno explicitamente configurado. Testar também que o Dockerfile contém tag patch + digest `sha256`, `USER node`, e que `NODE_ENV=production` rejeita secrets conhecidos de desenvolvimento, valores vazios, iguais entre si ou vindos de `.env.example`.

- [ ] **Step 2: Confirmar a falha**

Run: `npm test -- apps/api/tests/http/openapi.test.ts apps/api/tests/http/request-id.test.ts apps/api/tests/http/security-headers.test.ts`

Expected: FAIL sem gerador/artefato.

- [ ] **Step 3: Implementar geração e runtime**

Registrar schemas Zod como fonte única, gerar JSON ordenado, manter Swagger UI desligado por padrão em production e fechar pools no shutdown. Resolver a imagem oficial com `docker buildx imagetools inspect node:24.19.0-bookworm-slim`, registrar a tag e o digest retornado em `infra/app/node-image.lock` e copiar literalmente esse digest para a instrução `FROM`, no formato validado `node:24.19.0-bookworm-slim@sha256:` seguido de 64 caracteres hexadecimais. Criar arquivos como root somente no estágio de build, copiar artefatos com `--chown=node:node`, definir `ENTRYPOINT ["node", "apps/api/dist/server.js"]` e executar o runtime com `USER node`. O config loader deve falhar antes de abrir socket quando production receber secrets de desenvolvimento. Compose de produção não publica porta Evolution; README dos diretórios reservados declara explicitamente que não há implementação funcional neste incremento.

- [ ] **Step 4: Validar artefatos**

Run: `npm run clean && npm run build && npm run openapi:generate && git diff --exit-code -- docs/api/openapi.json && npm test -- apps/api/tests/http/openapi.test.ts apps/api/tests/http/request-id.test.ts apps/api/tests/http/security-headers.test.ts && npm run test:compiled`

Run: `docker build --file infra/app/Dockerfile --tag jrc-whatsapp-broker:phase-1-increment-1 .`

Run: `npm run test:container`

Expected: PASS e segunda geração sem diff. `test:compiled` invoca `npm start`, que inicia `apps/api/dist/server.js`, aguarda `/health`, valida shutdown e usa packages por `dist`. `test:container` sobe PostgreSQL/Redis de teste e a imagem já construída via `infra/app/compose.test.yaml`, confirma `/health` pelo ENTRYPOINT real, verifica usuário não-root e encerra/remove somente os recursos nomeados do compose de teste em `finally`.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "docs: publish Increment 1 API and runtime boundaries"`.

### Task 16: Suite de integração PostgreSQL consolidada

**Files:**
- Create: `apps/api/tests/integration/full-tenant-flow.test.ts`
- Modify: `apps/api/tests/integration/helpers/postgres.ts`
- Modify: `package.json`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: migrations e todos os repositórios/casos de uso.
- Produces: comando determinístico `npm run test:integration` contra PostgreSQL real.

- [ ] **Step 1: Escrever cenário vertical real**

```ts
const owner = await seedOwner(orgA);
const tokens = await loginAndSelect(owner, orgA);
const apiKey = await createApiKey(tokens);
const instance = await createInstanceWithFake(apiKey);
expect(await listAs(orgA)).toContainEqual(expect.objectContaining({ id: instance.id }));
expect(await listAs(orgB)).not.toContainEqual(expect.objectContaining({ id: instance.id }));
```

Incluir migrations do zero, constraints compostas, RLS CRUD, pool commit/rollback, OWNER concorrente, refresh concorrente, idempotência concorrente, challenge cifrado e teardown.

- [ ] **Step 2: Confirmar a falha natural do cenário vertical**

Run: `npm run test:integration -- apps/api/tests/integration/full-tenant-flow.test.ts`

Expected: FAIL naturalmente porque a fixture ainda não conecta todos os repositórios, casos de uso e adapters reais do cenário; nenhuma expectativa correta é invertida ou enfraquecida.

- [ ] **Step 3: Conectar fixtures aos casos de uso reais**

Não duplicar SQL de produção no teste. Subir database isolado, rodar migrations reais, usar pools `jrc_auth`/`jrc_app` e FakeProviderAdapter.

- [ ] **Step 4: Executar toda a integração**

Run: `npm run test:integration`

Expected: PASS em PostgreSQL real, sem dependência Evolution/Docker no processo de teste além do serviço PostgreSQL fornecido.

- [ ] **Step 5: Checkpoint e commit condicional**

Após aprovação: `git commit -m "test: cover PostgreSQL tenant security end to end"`.

### Task 17: Smoke Evolution opt-in com cleanup administrativo

**Files:**
- Create: `apps/api/tests/smoke/evolution.smoke.test.ts`
- Create: `apps/api/tests/smoke/helpers/evolution-env.ts`
- Modify: `apps/api/package.json`
- Modify: `.env.example`
- Modify: `docs/architecture/phase-1-increment-1.md`

**Interfaces:**
- Consumes: `EvolutionProviderAdapter`, `WhatsAppProviderAdmin`, Evolution local 2.3.7 e secrets de ambiente.
- Produces: `npm run test:smoke:evolution`, inerte sem `EVOLUTION_SMOKE_ENABLED=true`.

- [ ] **Step 1: Escrever smoke com `finally` obrigatório**

```ts
let reference: ProviderInstanceReference | undefined;
try {
  reference = await adapter.provisionInstance(ctx, uniqueInput).then((x) => x.reference);
  expect(await adapter.beginConnection(ctx, { reference })).toMatchObject({ type: expect.any(String) });
  await adapter.getStatus(ctx, reference);
  await adapter.disconnect(ctx, reference);
} finally {
  if (reference) {
    await admin.deprovisionInstance(ctx, reference);
    await expect(admin.lookupInstance(ctx, reference)).resolves.toEqual({ exists: false });
  }
}
```

- [ ] **Step 2: Confirmar skip seguro e falha sem configuração parcial**

Run: `npm run test:smoke:evolution`

Expected: SKIP quando flag ausente; com flag true e variáveis incompletas, FAIL antes de criar instância e sem imprimir secrets.

- [ ] **Step 3: Completar helper e chave exclusiva**

Gerar UUID por execução, derivar chave determinística sem PII, impor timeout global e confirmar remoção upstream exclusivamente com `lookupInstance`. `disconnect` não conta como cleanup; `reconcileProvisioning` nunca confirma ausência porque pode reprovisionar. Nenhum dado real de cliente é permitido.

- [ ] **Step 4: Executar smoke autorizado**

Run: `$env:EVOLUTION_SMOKE_ENABLED='true'; npm run test:smoke:evolution`

Expected: PASS com provision/connect/status/disconnect/deprovision e confirmação de ausência. Remover a variável da sessão após o teste.

- [ ] **Step 5: Checkpoint e commit condicional**

Apresentar IDs técnicos criados/removidos, nunca credenciais. Após aprovação: `git commit -m "test: add opt-in Evolution lifecycle smoke"`.

### Task 18: CI, auditoria de dependências e gates de segurança

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/check-public-contracts.mjs`
- Create: `scripts/check-submodule-clean.mjs`
- Create: `apps/api/tests/unit/public-contract-boundary.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: todos os scripts/testes anteriores.
- Produces: CI Node 24 + PostgreSQL real e comandos `security:contracts`, `security:submodule`, `ci:verify`.

- [ ] **Step 1: Escrever testes/gates que inicialmente detectam violações fixtureadas**

```ts
expect(scanPublicContract('export type X = { evolutionInstanceName: string }')).toEqual([
  expect.objectContaining({ rule: 'no-upstream-public-contract' }),
]);
expect(scanPublicContract('export type X = { instanceId: string }')).toEqual([]);
```

O scanner cobre imports/termos upstream públicos, segredos em fixtures/snapshots e métodos administrativos expostos em rotas/OpenAPI.

- [ ] **Step 2: Confirmar falha do workflow incompleto**

Run: `npm run security:contracts`

Expected: FAIL até o scanner e allowlist serem definidos.

- [ ] **Step 3: Implementar workflow e gates exatos**

CI usa Node 24.19.0, PostgreSQL real e Redis real, `npm ci`, migrations do zero, `npm run clean`, `npm run build` (`tsc -b`), teste do código compilado, `npm test`, `npm run test:integration`, `npm run openapi:generate`, `git diff --exit-code -- docs/api/openapi.json`, `docker build`, teste do ENTRYPOINT real do container, `npm audit --audit-level=high`, `npm run security:contracts`, `npm run security:submodule` e `git diff --check`. Smoke Evolution permanece fora do CI comum.

- [ ] **Step 4: Rodar gate local completo**

Run: `npm ci && npm run clean && npm run build && npm run typecheck && npm run test:compiled && npm test && npm run test:integration && npm run openapi:generate && git diff --exit-code -- docs/api/openapi.json && npm run security:contracts && npm run security:submodule && npm audit --audit-level=high && docker build --file infra/app/Dockerfile --tag jrc-whatsapp-broker:phase-1-increment-1 . && npm run test:container && git diff --check`

Expected: todos PASS; `git -C upstream/evolution-api status --short` vazio e commit ainda `fa09d37892cdbb1d65a250155d293d92230c5b30`.

- [ ] **Step 5: Checkpoint de segurança e commit condicional**

Apresentar relatório dos gates, achados do audit e justificativa de qualquer advisory aceito. Após aprovação: `git commit -m "ci: enforce Increment 1 security gates"`.

### Task 19: Auditoria de segurança completa e artefatos reproduzíveis

**Files:**
- Create: `docs/security-audit/AUDIT-SPEC.md`
- Create: `docs/security-audit/route-inventory.json`
- Create: `docs/security-audit/findings.json`
- Create: `docs/security-audit/relatorio-auditoria-seguranca.md`
- Create: `docs/security-audit/generate-security-audit.mjs`
- Create: `docs/security-audit/gate-security-audit.mjs`
- Create: `docs/security-audit/lib/{inventory-routes,validate-audit-data,render-markdown,render-pdf,secret-canaries,scan-jrc-history,scan-compiled-bundle}.mjs`
- Create: `docs/security-audit/secret-scan-summary.json`
- Generate: `docs/security-audit/issues/*.md`
- Generate: `docs/security-audit/relatorio-auditoria-seguranca.pdf`
- Create: `tests/security-audit-artifacts.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: aplicação composta, OpenAPI versionado, migrations, Dockerfile, bundle compilado, histórico Git da JRC, audit de dependências e resultados dos gates.
- Produces: `npm run security:audit:generate`, que sempre gera os artefatos independentemente da severidade; `npm run security:audit:gate`, que bloqueia `CRITICAL`/`HIGH` abertos; inventário completo de rotas; coleções estruturadas `findings` e `strengths`; resumo sanitizado da varredura de secrets; issues Markdown; e o PDF obrigatório `docs/security-audit/relatorio-auditoria-seguranca.pdf`.

- [ ] **Step 1: Escrever testes dos artefatos antes dos geradores**

```js
expect(routeInventory.map(({ method, path }) => `${method} ${path}`).sort())
  .toEqual(extractOpenApiRoutes(openapi).sort());
expect(routeInventory).toEqual(expect.arrayContaining([
  expect.objectContaining({
    handlerFile: expect.any(String),
    handlerLine: expect.any(Number),
    ownershipCheck: expect.any(String),
  }),
]));
expect(() => AuditDataSchema.parse(auditData)).not.toThrow();
expect(auditData).toMatchObject({ schemaVersion: 1, findings: expect.any(Array), strengths: expect.any(Array) });
for (const canaryValue of Object.values(TEST_SECRET_CANARIES)) {
  expect(extractedMarkdown).not.toContain(canaryValue);
  expect(extractedPdfText).not.toContain(canaryValue);
}
```

Testar que duas gerações com o mesmo `SOURCE_DATE_EPOCH` produzem SHA-256 idêntico para JSON, Markdown, issues e PDF. O inventário deve conter, para toda rota: método, path, autenticação, permissão RBAC, uso de tenant/RLS, idempotência, schemas request/response, headers de cache, exposição de challenge, `handlerFile`, `handlerLine` e `ownershipCheck`. Para rotas sem recurso tenant, `ownershipCheck` usa valor enumerado explícito, como `NOT_APPLICABLE_PRE_AUTH`, em vez de ficar ausente. Testes de layout verificam A4, margens de 18 mm, cabeçalho a partir da página 2, rodapé `Página X de Y`, ausência de conteúdo fora da media box e presença das seções/camadas gráficas exigidas.

- [ ] **Step 2: Confirmar a falha natural**

Run: `npm test -- tests/security-audit-artifacts.test.mjs`

Expected: FAIL porque `docs/security-audit/AUDIT-SPEC.md`, dados, issues e geradores ainda não existem.

- [ ] **Step 3: Definir AUDIT-SPEC e findings estruturados**

O `AUDIT-SPEC.md` fixa escopo, ameaça, evidência, severidades `CRITICAL|HIGH|MEDIUM|LOW|INFO`, estados `OPEN|ACCEPTED|FIXED|NOT_APPLICABLE`, regra de gate para CRITICAL/HIGH abertos e sanitização. Auditar autenticação/enumeração, autorização/RBAC, RLS/pool, secrets/criptografia, API keys/tokens, rate limiting/trusted proxies/Redis failure, validação/erros, logging/auditoria, SSRF e boundary Evolution, idempotência/DoS, dependências/supply chain, OpenAPI/rotas e container non-root/imagem imutável.

Cada finding JSON contém obrigatoriamente `id`, `title`, `category`, `severity`, `status`, `control`, `file`, `lineStart`, `lineEnd`, `codeExcerptMasked`, `description`, `impact`, `exploitability`, `exploitConditions`, `remediation`, `acceptanceCriteria`, `verification`, `suggestedLabels`, `issueMarkdown` e `evidencePaths`. `lineStart`/`lineEnd` são inteiros positivos e delimitam a evidência; `codeExcerptMasked` preserva estrutura sem valores; `issueMarkdown` contém título, contexto, evidência, passos ou condições de exploração, impacto, correção, critérios de aceite, verificação e labels. A coleção `strengths` contém `id`, `category`, `title`, `description`, `file`, `lineStart`, `lineEnd` e `evidencePaths`.

Registrar frontend e XSS como `NOT_APPLICABLE` com evidência de que este incremento não serve HTML nem implementa `apps/web`; não marcar como N/A qualquer validação de input que afete a API. Sanitização não usa regex de nomes de campo: carregar canários sintéticos distintos para senha, JWT, refresh token, API key, chave Evolution, QR, pairing code, telefone e cookie, exercitar os caminhos de logger/auditoria/gerador e falhar somente se algum valor-canário aparecer nos artefatos. Nomes como `password_hash`, `authorization` e caminhos de arquivos podem constar no relatório.

Adicionar duas varreduras reproduzíveis e sanitizadas ao gerador:

- histórico Git da JRC: enumerar commits e blobs alcançáveis do repositório raiz, excluindo `upstream/evolution-api/**` e sem executar varredura ou comando de histórico dentro do submódulo. O scanner captura conteúdo somente em memória, nunca herda stdout/stderr bruto dos processos e registra apenas regra/categoria, caminho, linha, SHA abreviado e fingerprint HMAC do achado;
- bundle compilado: depois de `npm run build`, percorrer apenas artefatos gerados pela JRC, incluindo `apps/api/dist/**` e as saídas compiladas dos packages. Excluir dependências, source maps de terceiros e todo o conteúdo do submódulo.

Salvar somente o agregado sanitizado em `docs/security-audit/secret-scan-summary.json`, sem trechos nem valores. Testes usam repositórios e bundles temporários com canários para comprovar detecção, exclusão do histórico upstream e ausência do valor secreto em stdout, stderr, JSON, Markdown e PDF. Nenhuma ferramenta ou mensagem de falha pode imprimir o valor encontrado.

- [ ] **Step 4: Implementar inventário, issues e geração reproduzível do PDF**

Gerar o inventário diretamente da composição Fastify/OpenAPI, ordenar arrays/chaves, validar que nenhuma rota está ausente e gerar um arquivo Markdown completo em `issues/` para cada finding a partir de `issueMarkdown`. Instalar as dependências do relatório com `npm install --save-dev --save-exact pdfkit svg-to-pdfkit @types/pdfkit` na raiz. `generate-security-audit.mjs` deve ficar no mesmo diretório do PDF e sempre produzir JSON/Markdown/issues/PDF mesmo com achados CRITICAL/HIGH abertos; somente erro de entrada, schema, I/O ou canário vazado interrompe a geração.

O PDF usa papel A4 retrato, margens de 18 mm, capa integral em pt-BR e o título exato `Relatório de Auditoria de Segurança — JRC WhatsApp Broker`; fase, incremento, commit e data de referência aparecem como metadados separados, sem serem concatenados ao título. Depois da capa: resumo executivo; escopo auditado e nota metodológica das cinco categorias de apresentação `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` e `STRENGTH`, explicando fontes, limitações, exclusões e critérios de classificação; rosca com distribuição por severidade; barras horizontais por categoria; chips de severidade; pontos fortes derivados de `strengths`; pontos fracos derivados de findings; tabela de achados com ID/categoria/severidade/status/arquivo/linhas; prioridades a partir de P1; inventário de rotas; e apêndice com todas as issues Markdown completas. `INFO` permanece reservado a contexto informativo e não constitui uma sexta categoria de achado.

Usar exatamente a paleta abaixo:

| Papel | Cor |
| --- | --- |
| `CRITICAL` | `#B91C1C` |
| `HIGH` | `#EA580C` |
| `MEDIUM` | `#D97706` |
| `LOW` | `#2563EB` |
| `STRENGTH` | `#059669` |
| `INFO` | `#475569` |
| `BACKGROUND` | `#F8FAFC` |

Derivar prioridades de forma explícita: `P1` para `CRITICAL`, `P2` para `HIGH`, `P3` para `MEDIUM` e `P4` para `LOW`/`INFO`, sem prioridade P0. Cada issue no Markdown e no apêndice do PDF fica entre os delimitadores literais `--- ISSUE n ---` e `--- FIM ISSUE n ---`, em que `n` é a numeração sequencial reproduzível da issue, preservando título, contexto, evidência mascarada, impacto, condições de exploração, correção, critérios de aceite, verificação e labels sugeridas.

Da página 2 em diante, usar cabeçalho `JRC WhatsApp Broker | Auditoria de Segurança — Incremento 1`, linha divisória e rodapé `Página X de Y`. Quebras de página não podem separar títulos de seu primeiro parágrafo nem cortar linhas de tabelas/gráficos. Metadados, ordenação, timestamps e ID do trailer do PDF derivam de `SOURCE_DATE_EPOCH` e do hash das entradas para reprodução byte a byte. Ao final, registrar o page count e conferir que a paginação cobre todas as seções obrigatórias.

Rasterizar todas as páginas em PNG, em diretório temporário, com no mínimo 150 DPI; a quantidade de imagens deve ser idêntica ao page count do PDF. Antes do gate final, inspecionar visualmente cada página e registrar no resumo da revisão que não há conteúdo cortado, sobreposto ou ilegível, gráfico/chip ausente, cor divergente, cabeçalho/rodapé quebrado nem página em branco inesperada. Os PNGs temporários não são versionados.

Run: `npm run security:audit:generate && npm test -- tests/security-audit-artifacts.test.mjs`

Expected: PASS, inventário igual ao OpenAPI, layout integral validado e ausência de todos os valores-canário; a geração passa mesmo quando a fixture contém CRITICAL/HIGH aberto.

- [ ] **Step 5: Separar reprodução do gate de severidade**

Run: `npm run security:audit:generate && git diff --exit-code -- docs/security-audit`

Expected: PASS sem diff após a segunda geração, independentemente da severidade dos findings.

Conferir o page count, rasterizar o PDF inteiro e concluir a inspeção visual de todas as páginas antes de executar o gate.

Run: `npm run security:audit:gate`

Expected: PASS somente quando não houver finding `CRITICAL` ou `HIGH` com status `OPEN`; o gate não reescreve artefatos. Apresentar AUDIT-SPEC, strengths, findings, inventário, issues, hash do PDF e resultado dos canários. Após revisão explícita: `git commit -m "docs: add reproducible Increment 1 security audit"`.

No CI, modificar `.github/workflows/ci.yml` e, depois do build, dos testes e da geração do OpenAPI, executar exatamente nesta ordem:

```bash
npm run security:audit:generate
npm run security:audit:gate
git diff --exit-code -- docs/security-audit
```

A geração sempre produz material diagnóstico; o gate aplica a política de bloqueio; e a última linha detecta qualquer artefato de auditoria desatualizado.

### Task 20: Autorrevisão final e checkpoint antes de push

**Files:**
- Modify somente se a revisão encontrar divergência: arquivos do incremento fora de `upstream/evolution-api`.

**Interfaces:**
- Consumes: spec, plano, série de commits aprovados e todos os gates.
- Produces: evidência final de aceite; nenhuma alteração remota automática.

- [ ] **Step 1: Conferir escopo e árvore**

Run: `git branch --show-current`

Expected: exatamente `codex/phase-1-increment-1`.

Run: `git diff --name-only origin/codex/phase-0-baseline...HEAD`

Expected: nenhum caminho em `upstream/evolution-api`; nenhuma implementação funcional em `apps/web`, `apps/worker` ou `packages/ui`; nenhum código Meta real, fila ou webhook completo.

- [ ] **Step 2: Executar a matriz final**

Run: `npm ci && npm run clean && npm run build && npm run typecheck && npm run test:compiled && npm test && npm run test:integration && npm run openapi:generate && git diff --exit-code -- docs/api/openapi.json && npm run security:contracts && npm run security:submodule && npm audit --audit-level=high && docker build --file infra/app/Dockerfile --tag jrc-whatsapp-broker:phase-1-increment-1 . && npm run test:container && npm run security:audit:generate && npm run security:audit:gate && git diff --exit-code -- docs/security-audit && git diff --check`

Expected: PASS em todos os gates. Executar o smoke separadamente apenas em ambiente local autorizado e registrar cleanup confirmado.

- [ ] **Step 3: Revisar segurança manualmente**

Inspecionar diff procurando: secrets/logs, transações envolvendo HTTP, query tenant sem `organization_id`/RLS, acesso `jrc_auth` excessivo, API pública com termos Evolution, desafio persistido em claro, operação admin registrada como rota e Evolution publicada externamente.

- [ ] **Step 4: Apresentar antes de commit final ou push**

Mostrar `git status --short --branch`, log dos commits, diff completo contra a branch remota, resultados dos testes/audit e riscos residuais. Não corrigir por squash/rebase nem fazer push sem aprovação explícita.

- [ ] **Step 5: Push somente após segunda aprovação**

Depois de o usuário aprovar expressamente a série final e confirmar que a branch atual é `codex/phase-1-increment-1`: `git push -u origin codex/phase-1-increment-1`. Se não houver aprovação, encerrar com a branch somente local e o status documentado.

## Matriz de cobertura da especificação

| Requisito | Tasks |
| --- | --- |
| Node 24, monorepo, TS strict, Fastify/Zod/Vitest | 1, 2, 15 |
| PostgreSQL, migrations SQL, roles/grants, RLS/pool | 4, 5, 16 |
| Organizações, usuários, memberships, provider account lógico, bootstrap e OWNER | 4, 7 |
| Segurança, anti-enumeração, login/select-org, refresh | 3, 8, 9 |
| RBAC, API keys com prefixo/HMAC e auditoria separada | 6, 10 |
| Contratos comuns/admin, fake, Meta skeleton, Evolution | 2, 11, 12 |
| Instâncias, idempotência, desafios e reconciliação | 13, 14 |
| API JRC, paginação, request ID, no-store e OpenAPI | 2, 10, 14, 15 |
| Unitários/HTTP sem Docker, integração PostgreSQL e smoke | 1–18, especialmente 16–17 |
| Audit de dependências, boundary scan e submódulo intacto | 18, 19 |
| Auditoria completa, inventário de rotas, findings e PDF sanitizado | 19, 20 |
| Escopo excluído e checkpoints pré-commit/push | Global Constraints, 15, 20 |
