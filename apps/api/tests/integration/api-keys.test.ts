import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createPostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { createApiKeyService, type ApiKeyService } from '../../src/modules/api-keys/service.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

const HMAC_SECRET = 'api-key-hmac-secret-with-at-least-32-bytes';
const REQUEST_ID = '85a17103-9f0d-4d86-b55d-4184597e17a8';

describe('API keys com PostgreSQL real', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let service: ApiKeyService;
  let tenantA: { organizationId: string; ownerId: string };
  let tenantB: { organizationId: string; ownerId: string };

  async function createTenant(slug: string) {
    return runInAdminTransaction(database.pool, async (transaction) => {
      const organization = await createOrganization(transaction, { name: slug, slug });
      const owner = await createUser(transaction, {
        email: `${slug}@example.test`,
        passwordHash: 'argon2id-test-hash',
      });
      await createOwnerMembership(transaction, { organizationId: organization.id, userId: owner.id });
      return { organizationId: organization.id, ownerId: owner.id };
    });
  }

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    tenantA = await createTenant('api-key-tenant-a');
    tenantB = await createTenant('api-key-tenant-b');
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    const repository = createPostgresApiKeyRepository();
    service = createApiKeyService({
      repository,
      hmacSecret: HMAC_SECRET,
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
    });
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  it('rejects an existing key immediately when its organization is disabled', async () => {
    const tenant = await createTenant('api-key-disabled');
    const issued = await service.issueApiKey({ organizationId: tenant.organizationId,
      actorId: tenant.ownerId, credentialKind: 'JWT', requestId: REQUEST_ID },
      { name: 'disabled-key', scopes: ['instances:read'], expiresAt: null });
    await database.pool.query("UPDATE organizations SET status='DISABLED' WHERE id=$1",[tenant.organizationId]);
    await expect(service.authenticateApiKey(issued.secret)).resolves.toBeNull();
  });

  it('persiste apenas prefixo/HMAC, autentica no tenant e lista sem segredo', async () => {
    const created = await service.issueApiKey({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'runtime', scopes: ['instances:read'], expiresAt: null });

    const persisted = await oneRow<{
      prefix: string;
      keyHmac: string;
      auditCount: number;
    }>(database.pool, `select k.prefix, k.key_hmac as "keyHmac",
        (select count(*)::int from audit_logs a where a.resource_id = k.id) as "auditCount"
      from api_keys k where k.id = $1`, [created.id]);
    expect(persisted.prefix).toBe(created.prefix);
    expect(persisted.keyHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.keyHmac).not.toContain(created.secret);
    expect(persisted.auditCount).toBe(1);

    await expect(service.authenticateApiKey(created.secret)).resolves.toMatchObject({
      apiKeyId: created.id,
      organizationId: tenantA.organizationId,
      scopes: ['instances:read'],
    });
    const page = await service.listApiKeys({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { limit: 20 });
    expect(page.data).toEqual([expect.objectContaining({ id: created.id })]);
    expect(JSON.stringify(page)).not.toContain(created.secret);
    expect(JSON.stringify(page)).not.toContain(persisted.keyHmac);
  });

  it('executa o repositório normal somente como jrc_app dentro do contexto local', async () => {
    const identity = await withOrganizationTransaction(appPool, tenantA.organizationId, async (transaction) => {
      const result = await transaction.query<{
        currentUser: string;
        sessionUser: string;
        organizationId: string | null;
      }>(
        `select current_user as "currentUser",
                session_user as "sessionUser",
                nullif(current_setting('app.organization_id', true), '') as "organizationId"`,
      );
      return result.rows[0];
    });
    expect(identity).toEqual({
      currentUser: 'jrc_app',
      sessionUser: 'jrc_app',
      organizationId: tenantA.organizationId,
    });
  });

  it('isola listagem, revogação e autenticação entre organizações', async () => {
    const created = await service.issueApiKey({
      organizationId: tenantB.organizationId,
      actorId: tenantB.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'tenant-b', scopes: ['instances:read'], expiresAt: null });

    const tenantAPage = await service.listApiKeys({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { limit: 100 });
    expect(tenantAPage.data.map(({ id }) => id)).not.toContain(created.id);
    await expect(service.revokeApiKey({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, created.id)).resolves.toBe(false);
    await expect(service.authenticateApiKey(created.secret)).resolves.toMatchObject({
      organizationId: tenantB.organizationId,
    });
  });

  it('revoga no próprio tenant e a credencial deixa de autenticar', async () => {
    const created = await service.issueApiKey({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'revoke-me', scopes: ['api_keys:manage'], expiresAt: null });
    await expect(service.revokeApiKey({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, created.id)).resolves.toBe(true);
    await expect(service.authenticateApiKey(created.secret)).resolves.toBeNull();
  });

  it('faz rollback de chave e auditoria quando a emissão conflita', async () => {
    await service.issueApiKey({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'unique-name', scopes: ['instances:read'], expiresAt: null });
    await expect(service.issueApiKey({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { name: 'unique-name', scopes: ['instances:read'], expiresAt: null })).rejects.toMatchObject({
      constraint: 'api_keys_org_name_unique',
    });

    const counts = await oneRow<{ keys: number; audits: number }>(database.pool,
      `select
        (select count(*)::int from api_keys where organization_id = $1 and name = 'unique-name') as keys,
        (select count(*)::int from audit_logs a join api_keys k on k.id = a.resource_id
          where a.organization_id = $1 and k.name = 'unique-name'
            and a.event_type = 'API_KEY_ISSUED') as audits`, [tenantA.organizationId]);
    expect(counts.keys).toBe(1);
    expect(counts.audits).toBe(1);
  });

  it('rejeita pool administrativo antes de consultar ou persistir API keys', async () => {
    const unsafe = createApiKeyService({
      repository: createPostgresApiKeyRepository(),
      hmacSecret: HMAC_SECRET,
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(database.pool, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
    });

    await expect(unsafe.listApiKeys({
      organizationId: tenantA.organizationId,
      actorId: tenantA.ownerId,
      credentialKind: 'JWT',
      requestId: REQUEST_ID,
    }, { limit: 20 })).rejects.toThrow('Organization transactions require a direct jrc_app connection');
  });
});
