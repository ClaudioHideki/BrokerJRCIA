# JRC WhatsApp Broker Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a traceable, license-compliant monorepo and a reproducible Evolution API baseline that future JRC Broker phases can extend safely.

**Architecture:** Use `JRC-WhatsApp-Broker` as a monorepo for the JRC-owned control plane, public API, UI, contracts, adapters and operational tooling. Pin the official Evolution API repository as a Git submodule at `upstream/evolution-api`; keep it immutable behind a JRC adapter so it can evolve or be replaced without breaking customers.

**Tech Stack:** Git, Node.js 20+, TypeScript, npm, Docker Compose, PostgreSQL, Redis, Evolution API, Vitest, shell-based CI checks.

**Spec:** `docs/superpowers/specs/2026-09-03-jrc-whatsapp-broker-design.md`

## Global Constraints

- Preserve access to the complete upstream Git history through the official Git submodule.
- Preserve upstream `LICENSE`, `NOTICE`, copyright, and attribution notices.
- Record the exact upstream repository URL and immutable commit SHA.
- Do not remove or rebrand protected Evolution frontend assets.
- Expose Evolution usage attribution to JRC administrators.
- Never commit Meta tokens, Baileys sessions, API keys, database passwords, or customer data.
- Pin images and dependencies; never use `latest` in production configuration.
- No production deployment or customer migration is part of Phase 0.
- All changes follow test-driven development and end with an independently reviewable commit.

---

### Task 1: Create the JRC control-plane repository baseline

**Files:**
- Create: `jrc-whatsapp-broker/README.md`
- Create: `jrc-whatsapp-broker/AGENTS.md`
- Create: `jrc-whatsapp-broker/package.json`
- Create: `jrc-whatsapp-broker/.gitignore`
- Create: `jrc-whatsapp-broker/.env.example`
- Create: `jrc-whatsapp-broker/docs/architecture/system-boundaries.md`
- Create: `jrc-whatsapp-broker/scripts/check-repository-baseline.mjs`
- Create: `jrc-whatsapp-broker/tests/repository-baseline.test.mjs`

**Interfaces:**
- Consumes: approved architecture specification.
- Produces: a Git repository with `npm run test:baseline` as the first mandatory quality gate.

- [ ] **Step 1: Initialize the repository without creating remote state**

Run:

```bash
mkdir jrc-whatsapp-broker
cd jrc-whatsapp-broker
git init -b main
```

Expected: an empty Git repository on branch `main`.

- [ ] **Step 2: Write the failing repository-baseline test**

Create `tests/repository-baseline.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { validateRepositoryBaseline } from '../scripts/check-repository-baseline.mjs';

describe('repository baseline', () => {
  it('contains governance, environment, and architecture files', async () => {
    const result = await validateRepositoryBaseline(process.cwd());
    expect(result.missing).toEqual([]);
    expect(result.forbiddenTrackedFiles).toEqual([]);
  });
});
```

- [ ] **Step 3: Create the package manifest and run the test to verify failure**

Create `package.json`:

```json
{
  "name": "@jrc/whatsapp-broker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:baseline": "vitest run tests/repository-baseline.test.mjs"
  },
  "devDependencies": {
    "vitest": "3.2.4"
  }
}
```

Run:

```bash
npm install
npm run test:baseline
```

Expected: FAIL because `check-repository-baseline.mjs` does not exist.

- [ ] **Step 4: Implement the baseline validator**

Create `scripts/check-repository-baseline.mjs`:

```js
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const required = [
  'README.md',
  'AGENTS.md',
  '.gitignore',
  '.env.example',
  'docs/architecture/system-boundaries.md'
];

const forbiddenPatterns = [
  /^\.env$/,
  /\.session(\/|$)/,
  /auth[_-]?state/i,
  /credentials?\.json$/i
];

export async function validateRepositoryBaseline(root) {
  const missing = [];
  for (const file of required) {
    try {
      await access(join(root, file), constants.F_OK);
    } catch {
      missing.push(file);
    }
  }

  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    tracked = [];
  }

  const forbiddenTrackedFiles = tracked.filter((file) =>
    forbiddenPatterns.some((pattern) => pattern.test(file))
  );

  return { missing, forbiddenTrackedFiles };
}

if (process.argv[1]?.endsWith('check-repository-baseline.mjs')) {
  const result = await validateRepositoryBaseline(process.cwd());
  if (result.missing.length || result.forbiddenTrackedFiles.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log('Repository baseline is valid.');
}
```

- [ ] **Step 5: Add the baseline documentation files**

Create `README.md` with the product goal, Phase 0 status, local prerequisites, explicit statement that the repository does not yet contain a production broker, and links to the spec and system-boundaries document.

Create `AGENTS.md` with these mandatory rules:

```markdown
# JRC WhatsApp Broker contributor rules

- Read the approved design and the current phase plan before editing.
- Use TDD for every feature and bug fix.
- Never commit secrets, customer payloads, telephone numbers, or Baileys auth state.
- Preserve all third-party licenses and attributions.
- Do not deploy to production without an explicit approved release task.
- Run `npm test` and review `git diff --check` before every commit.
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
*.log
.sessions/
auth-state/
credentials.json
```

Create `.env.example` containing names only and safe local defaults:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://jrc:jrc@localhost:5432/jrc_broker
REDIS_URL=redis://localhost:6379
EVOLUTION_BASE_URL=http://localhost:8080
EVOLUTION_API_KEY=dev-only-jrc-broker-key
```

Create `docs/architecture/system-boundaries.md` documenting that the JRC control plane owns tenants, plans, API keys and the stable public contract, while the Evolution engine remains an attributed replaceable provider implementation.

- [ ] **Step 6: Run the baseline test**

Run:

```bash
npm run test:baseline
```

Expected: PASS with one passing test.

- [ ] **Step 7: Commit the repository baseline**

```bash
git add README.md AGENTS.md package.json package-lock.json .gitignore .env.example docs scripts tests
git commit -m "chore: establish JRC broker repository baseline"
```

---

### Task 2: Add the traceable Evolution engine monorepo baseline

**Files:**
- Create: `.gitmodules`
- Pin: `upstream/evolution-api` at an immutable official commit
- Preserve through submodule: `upstream/evolution-api/LICENSE`
- Preserve through submodule: `upstream/evolution-api/NOTICE`
- Preserve through submodule: `upstream/evolution-api/TRADEMARKS.md`
- Create: `docs/legal/evolution/UPSTREAM.md`
- Create: `docs/legal/evolution/USAGE-NOTICE.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `scripts/check-evolution-upstream.mjs`
- Create: `tests/evolution-upstream.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: official Evolution API Git repository and its complete history.
- Produces: a pinned, attributed upstream inside the monorepo with `npm run test:evolution-upstream` as a legal traceability gate.

- [x] **Step 1: Add the official upstream as a pinned submodule**

```bash
git submodule add -b main https://github.com/evolution-foundation/evolution-api.git upstream/evolution-api
git -C upstream/evolution-api checkout fa09d37892cdbb1d65a250155d293d92230c5b30
git submodule status
```

Expected: `upstream/evolution-api` is a `160000` gitlink pinned to the selected official commit.

- [x] **Step 2: Record the immutable upstream commit and legal notice**

Create `docs/legal/evolution/UPSTREAM.md`, `docs/legal/evolution/USAGE-NOTICE.md` and `THIRD_PARTY_NOTICES.md` using the verified URL, SHA and approved administrative wording.

- [x] **Step 3: Write the failing upstream-compliance test**

Create `tests/evolution-upstream.test.mjs` validating the official URL, immutable SHA, `160000` gitlink, legal files and administrative usage notice.

- [x] **Step 4: Run the new test to verify failure**

```bash
npm run test:evolution-upstream
```

Expected: FAIL because `check-evolution-upstream.mjs` does not exist.

- [x] **Step 5: Implement the upstream compliance validator**

Create `scripts/check-evolution-upstream.mjs` and validate all recorded provenance and attribution requirements.

- [x] **Step 6: Run the compliance test and full regression suite**

```bash
npm run test:evolution-upstream
npm test
```

Expected: both tests PASS.

- [x] **Step 7: Publish the monorepo upstream baseline on the existing feature branch**

```bash
git add .gitmodules upstream/evolution-api THIRD_PARTY_NOTICES.md docs/legal package.json scripts/check-evolution-upstream.mjs tests/evolution-upstream.test.mjs
git commit -m "chore: record Evolution upstream and license baseline"
```

---

### Task 3: Add a reproducible local baseline environment

**Files:**
- Create: `jrc-whatsapp-broker/infra/baseline/compose.yaml`
- Create: `jrc-whatsapp-broker/infra/baseline/.env.example`
- Create: `jrc-whatsapp-broker/scripts/check-compose-pins.mjs`
- Create: `jrc-whatsapp-broker/tests/compose-pins.test.mjs`
- Modify: `jrc-whatsapp-broker/package.json`
- Modify: `jrc-whatsapp-broker/README.md`

**Interfaces:**
- Consumes: a locally built immutable `upstream/evolution-api` image tag and safe local credentials.
- Produces: `docker compose -f infra/baseline/compose.yaml up -d` and a deterministic health-check target.

- [x] **Step 1: Write the failing image-pin test**

Create `tests/compose-pins.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { findUnpinnedImages } from '../scripts/check-compose-pins.mjs';

describe('baseline compose', () => {
  it('does not use latest or untagged images', async () => {
    expect(await findUnpinnedImages('infra/baseline/compose.yaml')).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test to verify failure**

Run:

```bash
npm test -- tests/compose-pins.test.mjs
```

Expected: FAIL because `check-compose-pins.mjs` does not exist.

- [x] **Step 3: Implement the image-pin validator**

Create `scripts/check-compose-pins.mjs`:

```js
import { readFile } from 'node:fs/promises';

export async function findUnpinnedImages(path) {
  const yaml = await readFile(path, 'utf8');
  return yaml
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('image:'))
    .map((line) => line.slice('image:'.length).trim())
    .filter((image) => !image.includes(':') || image.endsWith(':latest'));
}
```

- [x] **Step 4: Create the baseline Compose file**

Create `infra/baseline/compose.yaml` with these services and pinned tags:

```yaml
services:
  postgres:
    image: postgres:16.4-alpine
    environment:
      POSTGRES_DB: evolution
      POSTGRES_USER: evolution
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U evolution -d evolution"]
      interval: 5s
      timeout: 3s
      retries: 20
    volumes:
      - baseline_postgres:/var/lib/postgresql/data

  redis:
    image: redis:7.4.0-alpine
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD}"]
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  evolution:
    image: jrc-evolution-engine:${EVOLUTION_ENGINE_TAG}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    ports:
      - "127.0.0.1:8080:8080"
    env_file:
      - .env

volumes:
  baseline_postgres:
```

Create `infra/baseline/.env.example`:

```dotenv
POSTGRES_PASSWORD=dev-only-postgres-password
REDIS_PASSWORD=dev-only-redis-password
EVOLUTION_ENGINE_TAG=phase0-local
AUTHENTICATION_API_KEY=dev-only-evolution-api-key
```

- [x] **Step 5: Add the test script and run all tests**

Add to `package.json`:

```json
"test:compose": "vitest run tests/compose-pins.test.mjs"
```

Run:

```bash
npm test
docker compose -f infra/baseline/compose.yaml config
```

Expected: all Vitest tests PASS and Compose configuration parses successfully when required environment variables are supplied.

- [x] **Step 6: Document build and startup without secrets**

Add exact local commands to `README.md`:

```bash
cd upstream/evolution-api
docker build -t jrc-evolution-engine:phase0-local .
cd ../..
cp infra/baseline/.env.example infra/baseline/.env
docker compose --env-file infra/baseline/.env -f infra/baseline/compose.yaml up -d
```

State that `.env` must be edited locally and must never be committed.

- [x] **Step 7: Publish the reproducible environment and external validation**

```bash
git add README.md package.json package-lock.json infra scripts/check-compose-pins.mjs tests/compose-pins.test.mjs
git commit -m "chore: add reproducible Evolution baseline environment"
```

---

### Task 4: Prove the baseline and publish the reuse matrix

**Files:**
- Create: `jrc-whatsapp-broker/tests/smoke/evolution-health.test.mjs`
- Create: `jrc-whatsapp-broker/docs/baseline/evolution-smoke-results.md`
- Create: `jrc-whatsapp-broker/docs/baseline/evolution-reuse-matrix.md`
- Create: `jrc-whatsapp-broker/docs/baseline/third-party-inventory.md`
- Modify: `jrc-whatsapp-broker/package.json`

**Interfaces:**
- Consumes: healthy local Evolution engine at `EVOLUTION_BASE_URL` and the pinned upstream record.
- Produces: evidence that the baseline runs plus an approve/adapt/replace/defer decision for every relevant Evolution module.

- [ ] **Step 1: Write the smoke test**

Create `tests/smoke/evolution-health.test.mjs`:

```js
import { describe, expect, it } from 'vitest';

const baseUrl = process.env.EVOLUTION_BASE_URL ?? 'http://127.0.0.1:8080';

describe('Evolution engine baseline', () => {
  it('responds without a server error on the documented health endpoint', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Add the smoke-test command and verify the expected initial failure**

Add to `package.json`:

```json
"test:smoke": "vitest run tests/smoke/evolution-health.test.mjs"
```

Run before starting the Compose stack:

```bash
npm run test:smoke
```

Expected: FAIL with a connection error because the engine is not running.

- [ ] **Step 3: Start the baseline and rerun the smoke test**

Run:

```bash
docker compose --env-file infra/baseline/.env -f infra/baseline/compose.yaml up -d
npm run test:smoke
```

Expected: PASS with an HTTP status below 500 from `/`. A non-2xx status is acceptable for this availability probe because authenticated upstream versions may protect the root route; later contract tests will use authenticated documented endpoints.

- [ ] **Step 4: Record reproducible smoke evidence**

Create `docs/baseline/evolution-smoke-results.md` containing:

- selected upstream commit;
- local engine image tag;
- test date and environment;
- exact commands executed;
- container health output;
- endpoint and HTTP status;
- failures encountered and resolutions;
- confirmation that no customer credentials or production data were used.

- [ ] **Step 5: Create the module reuse matrix**

Create `docs/baseline/evolution-reuse-matrix.md` with one row for each module or integration discovered in the pinned source and these columns:

| Module | Source path | License/notice | JRC decision | Reason | Required adapter | Phase |
|---|---|---|---|---|---|---|

Allowed decisions are exactly `REUSE`, `ADAPT`, `REPLACE`, and `DEFER`. At minimum, classify instance lifecycle, Baileys, Cloud API, webhooks, RabbitMQ, Socket.IO, S3/MinIO, Chatwoot, Typebot, OpenAI, Dify, database/Prisma, authentication, manager/frontend, telemetry, and metrics.

- [ ] **Step 6: Create the third-party inventory**

Create `docs/baseline/third-party-inventory.md` with package name, resolved version, repository, detected license, use in JRC, redistribution obligation, and review status. Populate it from the pinned lockfile rather than memory. Mark unknown or conflicting license metadata as `BLOCKED` and do not reuse that component until resolved.

- [ ] **Step 7: Run the final Phase 0 verification**

Run:

```bash
npm test
npm run test:smoke
git diff --check
git status --short
```

Expected: all tests PASS, `git diff --check` is silent, and `git status --short` lists only the Phase 0 evidence files awaiting commit.

- [ ] **Step 8: Commit the verified Phase 0 evidence**

```bash
git add package.json package-lock.json tests/smoke docs/baseline
git commit -m "test: verify Evolution baseline and reuse decisions"
```

## Phase 0 completion gate

Phase 0 is complete only when:

1. both repositories have clean Git histories and explicit remotes;
2. the Evolution commit is immutable and recorded;
3. license, notice, trademark, and attribution files are present;
4. the baseline runs locally from pinned artifacts;
5. automated tests pass;
6. the reuse matrix has no unresolved item selected for Phase 1;
7. no secret or customer data is tracked;
8. no production system has been changed.
