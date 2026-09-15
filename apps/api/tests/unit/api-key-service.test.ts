import { describe, expect, it } from 'vitest';

import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import {
  ApiKeyServiceError,
  createApiKeyService,
  type ApiKeyRepository,
  type ApiKeyRow,
} from '../../src/modules/api-keys/service.js';

const ORGANIZATION_A = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const ORGANIZATION_B = '0a010601-c3a6-42e7-b904-a858970299f9';
const USER_ID = 'd8caa763-c0b0-40bd-94c5-dbb558a48729';
const REQUEST_ID = '85a17103-9f0d-4d86-b55d-4184597e17a8';
const HMAC_SECRET = 'api-key-hmac-secret-with-at-least-32-bytes';
const NOW = new Date('2030-01-01T12:00:00.000Z');

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: '81555d45-b1a2-4a3f-ab95-c1459b0df0d0',
    organizationId: ORGANIZATION_A,
    name: 'automation',
    prefix: '4f2491a268534ac2a7efc997813a9182-AQEBAQEBAQEB',
    keyHmac: '0'.repeat(64),
    scopes: ['instances:read'],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function createHarness(overrides: Partial<ApiKeyRepository> = {}) {
  const inserted: Array<Omit<ApiKeyRow, 'id' | 'createdAt' | 'revokedAt' | 'lastUsedAt'>> = [];
  const audits: unknown[] = [];
  let generatedId = 0;
  const repository: ApiKeyRepository = {
    async insert(_transaction, input) {
      inserted.push(input);
      generatedId += 1;
      return row({
        id: `81555d45-b1a2-4a3f-ab95-c1459b0df0d${generatedId}`,
        ...input,
      });
    },
    async list() { return []; },
    async revoke() { return null; },
    async findActiveByPrefix() { return null; },
    async markUsed() { return undefined; },
    ...overrides,
  };
  let randomFill = 1;
  const service = createApiKeyService({
    repository,
    hmacSecret: HMAC_SECRET,
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, randomFill++),
    runInOrganizationTransaction: async (_organizationId, operation) => operation({
      query: async (text: string) => ({
        rows: text.includes('current_user')
          ? [{ currentUser: 'jrc_app', sessionUser: 'jrc_app' }]
          : [],
        rowCount: text.includes('current_user') ? 1 : 0,
      }),
    } as unknown as TenantTransaction),
    writeAudit: async (_transaction, event) => { audits.push(event); },
  });
  return { audits, inserted, repository, service };
}

describe('serviço de API keys', () => {
  it('exibe o segredo apenas na emissão e persiste somente prefixo e HMAC', async () => {
    const harness = createHarness();

    const created = await harness.service.issueApiKey({
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, {
      name: 'automation',
      scopes: ['instances:read'],
      expiresAt: null,
    });

    expect(created.secret).toMatch(/^jrc_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).not.toHaveProperty('secret');
    expect(harness.inserted[0]?.keyHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(harness.inserted)).not.toContain(created.secret);
    expect(harness.audits).toEqual([expect.objectContaining({
      type: 'API_KEY_ISSUED',
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      resourceId: created.id,
    })]);
  });

  it('repete no máximo cinco vezes somente a colisão do prefixo global', async () => {
    let attempts = 0;
    const harness = createHarness({
      async insert(_transaction, input) {
        attempts += 1;
        if (attempts < 5) {
          throw Object.assign(new Error('prefix collision'), {
            code: '23505',
            constraint: 'api_keys_prefix_global_unique',
          });
        }
        return row({ ...input });
      },
    });

    await expect(harness.service.issueApiKey({
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'retry', scopes: ['instances:read'], expiresAt: null })).resolves.toBeDefined();
    expect(attempts).toBe(5);

    const nameConflict = Object.assign(new Error('name conflict'), {
      code: '23505',
      constraint: 'api_keys_org_name_unique',
    });
    const noRetry = createHarness({ async insert() { throw nameConflict; } });
    await expect(noRetry.service.issueApiKey({
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'duplicate', scopes: ['instances:read'], expiresAt: null })).rejects.toBe(nameConflict);
  });

  it('autentica em transação do tenant e rejeita segredo, expiração e revogação inválidos', async () => {
    const issuedHarness = createHarness();
    const issued = await issuedHarness.service.issueApiKey({
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'runtime', scopes: ['instances:read'], expiresAt: null });
    const persisted = issuedHarness.inserted[0]!;
    const used: Date[] = [];
    const authHarness = createHarness({
      async findActiveByPrefix() {
        return row({ ...persisted, id: issued.id });
      },
      async markUsed(_transaction, _id, usedAt) { used.push(usedAt); },
    });

    await expect(authHarness.service.authenticateApiKey(issued.secret)).resolves.toEqual({
      apiKeyId: issued.id,
      organizationId: ORGANIZATION_A,
      scopes: ['instances:read'],
    });
    expect(used).toEqual([NOW]);
    await expect(authHarness.service.authenticateApiKey(`${issued.secret}x`)).resolves.toBeNull();

    for (const unavailable of [
      row({ ...persisted, revokedAt: NOW }),
      row({ ...persisted, expiresAt: new Date(NOW.getTime() - 1) }),
    ]) {
      const unavailableHarness = createHarness({ async findActiveByPrefix() { return unavailable; } });
      await expect(unavailableHarness.service.authenticateApiKey(issued.secret)).resolves.toBeNull();
    }
  });

  it('faz paginação estável e rejeita cursor pertencente a outro tenant', async () => {
    const first = row({ id: '00000000-0000-4000-8000-000000000001' });
    const second = row({ id: '00000000-0000-4000-8000-000000000002' });
    const harness = createHarness({ async list() { return [first, second]; } });

    const page = await harness.service.listApiKeys({
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { limit: 1 });

    expect(page.data).toEqual([expect.not.objectContaining({ keyHmac: expect.anything() })]);
    expect(page.pageInfo.hasNextPage).toBe(true);
    expect(page.pageInfo.nextCursor).toEqual(expect.any(String));

    const other = createHarness({ async list() { return [row({ organizationId: ORGANIZATION_B })]; } });
    await expect(other.service.listApiKeys({
      organizationId: ORGANIZATION_B,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { limit: 1, cursor: page.pageInfo.nextCursor! })).rejects.toMatchObject({
      code: 'CURSOR_NOT_FOUND',
    });
  });

  it('revoga somente a chave visível no tenant e audita a mutação bem-sucedida', async () => {
    const target = row();
    const harness = createHarness({ async revoke() { return target; } });
    await expect(harness.service.revokeApiKey({
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, target.id)).resolves.toBe(true);
    expect(harness.audits).toEqual([expect.objectContaining({
      type: 'API_KEY_REVOKED',
      resourceId: target.id,
    })]);

    const foreign = createHarness();
    await expect(foreign.service.revokeApiKey({
      organizationId: ORGANIZATION_A,
      actorId: USER_ID,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, target.id)).resolves.toBe(false);
    expect(foreign.audits).toEqual([]);
  });

  it('atribui emissão feita por API key sem fingir identidade de usuário', async () => {
    const harness = createHarness();
    await harness.service.issueApiKey({
      organizationId: ORGANIZATION_A,
      actorId: null,
      credentialKind: 'API_KEY',
      apiKeyId: '153eaf0b-bfc4-4411-a085-04882048d952',
      requestId: REQUEST_ID,
    }, { name: 'machine-created', scopes: ['instances:read'], expiresAt: null });

    expect(harness.audits).toEqual([expect.objectContaining({
      actorId: null,
      actorKind: 'API_KEY',
      actorApiKeyId: '153eaf0b-bfc4-4411-a085-04882048d952',
    })]);
  });
});
