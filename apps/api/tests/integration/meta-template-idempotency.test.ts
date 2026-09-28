import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { createMessagingService } from '../../src/modules/messaging/service.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

const input = { name: 'aviso_entrega', language: 'pt_BR', category: 'UTILITY' as const, body: 'Pedido pronto.' };

describe('idempotência PostgreSQL do template Meta', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let firstOrganization: string;
  let secondOrganization: string;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    [firstOrganization, secondOrganization] = await runInAdminTransaction(database.pool, async tx => {
      const first = await createOrganization(tx, { name: 'Meta One', slug: 'meta-one' });
      const second = await createOrganization(tx, { name: 'Meta Two', slug: 'meta-two' });
      const firstOwner = await createUser(tx, { email: 'meta-one@example.test', passwordHash: 'argon2id-test-hash' });
      const secondOwner = await createUser(tx, { email: 'meta-two@example.test', passwordHash: 'argon2id-test-hash' });
      await createOwnerMembership(tx, { organizationId: first.id, userId: firstOwner.id });
      await createOwnerMembership(tx, { organizationId: second.id, userId: secondOwner.id });
      return [first.id, second.id];
    });
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
  }, 60_000);

  afterAll(async () => { await appPool?.end(); await database?.dispose(); });

  function serviceFor(wabas: Record<string, string>, provider: {
    listTemplates(waba: string): Promise<unknown[]>;
    createTextTemplate(waba: string): Promise<{ id: string; status?: string; category?: string }>;
    findTemplateByName?(waba: string, name: string, language: string): Promise<unknown>;
  }) {
    return createMessagingService({
      repository: { async findChannel(_tx: unknown, organizationId: string, channelId: string) {
        const wabaId = wabas[organizationId];
        return channelId === `channel-${organizationId}` && wabaId
          ? { id: channelId, organizationId, provider: 'META', wabaId } : null;
      } } as unknown as MessagingRepository,
      runInOrganizationTransaction: (org, operation) => withOrganizationTransaction(appPool, org, operation),
      async resolveMetaClient(channel) { return {
        listTemplates: () => provider.listTemplates(channel.wabaId!) as never,
        findTemplateByName: (name: string, language: string) => provider.findTemplateByName
          ? provider.findTemplateByName(channel.wabaId!, name, language) as never
          : provider.listTemplates(channel.wabaId!).then(items => items.find(item =>
            (item as {name?: string;language?: string}).name === name &&
            (item as {name?: string;language?: string}).language === language,
          )) as never,
        createTextTemplate: () => provider.createTextTemplate(channel.wabaId!),
      }; },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
  }

  it('reserva antes do POST, não repete após timeout e reconcilia pela WABA', async () => {
    let posts = 0;
    let observed = false;
    const provider = {
      async listTemplates() { return observed ? [{ id: '20001', name: input.name, language: input.language,
        status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: input.body }] }] : []; },
      async createTextTemplate() { posts++; throw Object.assign(new Error('timeout'), { code: 'META_TEMPLATE_SUBMISSION_UNKNOWN' }); },
    };
    const service = serviceFor({ [firstOrganization]: 'waba-one' }, provider);
    const channel = `channel-${firstOrganization}`;
    await expect(service.createTextTemplate(firstOrganization, channel, input, 'timeout-key'))
      .rejects.toMatchObject({ code: 'META_TEMPLATE_SUBMISSION_UNKNOWN', status: 503 });
    expect(posts).toBe(1);
    await expect(service.createTextTemplate(firstOrganization, channel, input, 'timeout-key'))
      .rejects.toMatchObject({ code: 'META_TEMPLATE_SUBMISSION_UNKNOWN', status: 503 });
    expect(posts).toBe(1);
    observed = true;
    await expect(service.createTextTemplate(firstOrganization, channel, input, 'timeout-key'))
      .resolves.toMatchObject({ id: '20001', status: 'PENDING' });
    expect(posts).toBe(1);
    const rows = await database.pool.query<{ status: string; response_metadata: Record<string, unknown> }>(
      "SELECT status, response_metadata FROM idempotency_records WHERE organization_id=$1 AND route='POST /v1/messaging/channels/:id/templates'",
      [firstOrganization],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('COMPLETED');
    expect(rows.rows[0]?.response_metadata).toEqual({ templateId: '20001' });
  });

  it('falha antes do POST sem reservar o nome e permite nova tentativa após o Graph voltar', async () => {
    let unavailable = true;
    let posts = 0;
    const service = serviceFor({ [firstOrganization]: 'waba-one' }, {
      async listTemplates() { if (unavailable) throw new Error('Graph temporarily unavailable'); return []; },
      async createTextTemplate() { posts++; return { id: '20113' }; },
    });
    const channel = `channel-${firstOrganization}`;
    const submitted = { ...input, name: 'aviso_recuperavel' };
    await expect(service.createTextTemplate(firstOrganization, channel, submitted, 'preflight-retry'))
      .rejects.toMatchObject({ code: 'META_TEMPLATE_SUBMISSION_UNKNOWN', status: 503 });
    const before = await database.pool.query<{count: string}>(
      'SELECT count(*) FROM idempotency_records WHERE organization_id=$1 AND idempotency_key=$2',
      [firstOrganization, 'preflight-retry'],
    );
    expect(before.rows[0]?.count).toBe('0');
    unavailable = false;
    await expect(service.createTextTemplate(firstOrganization, channel, submitted, 'preflight-retry'))
      .resolves.toMatchObject({ id: '20113' });
    expect(posts).toBe(1);
  });

  it('usa consulta filtrada por nome na WABA sem listar todos os templates antes de criar', async () => {
    let posts = 0;
    const queried: Array<[string, string, string]> = [];
    const service = serviceFor({ [firstOrganization]: 'waba-one' }, {
      async listTemplates() { throw new Error('unbounded template scan'); },
      async findTemplateByName(waba, name, language) { queried.push([waba, name, language]); return undefined; },
      async createTextTemplate() { posts++; return { id: '20114' }; },
    });
    const submitted = { ...input, name: 'aviso_filtrado' };
    await expect(service.createTextTemplate(firstOrganization, `channel-${firstOrganization}`, submitted, 'filtered-key'))
      .resolves.toMatchObject({ id: '20114' });
    expect(queried).toEqual([['waba-one', 'aviso_filtrado', 'pt_BR']]);
    expect(posts).toBe(1);
  });

  it('permite corrigir um template recusado com nova chave sem repetir a chave antiga', async () => {
    let posts = 0;
    const service = serviceFor({ [firstOrganization]: 'waba-one' }, {
      async listTemplates() { return []; },
      async createTextTemplate() {
        posts++;
        if (posts === 1) throw Object.assign(new Error('rejected'), { code: 'META_REQUEST_REJECTED' });
        return { id: '20115' };
      },
    });
    const channel = `channel-${firstOrganization}`;
    const rejected = { ...input, name: 'aviso_corrigivel', body: 'Texto recusado.' };
    await expect(service.createTextTemplate(firstOrganization, channel, rejected, 'rejected-key'))
      .rejects.toMatchObject({ code: 'META_TEMPLATE_REJECTED', status: 422 });
    await expect(service.createTextTemplate(firstOrganization, channel, rejected, 'rejected-key'))
      .rejects.toMatchObject({ code: 'META_TEMPLATE_REJECTED', status: 422 });
    expect(posts).toBe(1);
    await expect(service.createTextTemplate(firstOrganization, channel,
      { ...rejected, body: 'Texto corrigido.' }, 'corrected-key'))
      .resolves.toMatchObject({ id: '20115' });
    expect(posts).toBe(2);
  });

  it('chaves concorrentes para mesmo nome e idioma não fazem dois POSTs e chave reaproveitada com outro corpo conflita', async () => {
    let posts = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const posted = new Promise<void>(resolve => { started = resolve; });
    const service = serviceFor({ [firstOrganization]: 'waba-one' }, {
      async listTemplates() { return []; },
      async createTextTemplate() { posts++; started(); await held; return { id: '20002' }; },
    });
    const channel = `channel-${firstOrganization}`;
    const first = service.createTextTemplate(firstOrganization, channel, { ...input, name: 'aviso_concorrente' }, 'key-a');
    await posted;
    await expect(service.createTextTemplate(firstOrganization, channel, { ...input, name: 'aviso_concorrente' }, 'key-b'))
      .rejects.toMatchObject({ code: 'META_TEMPLATE_SUBMISSION_UNKNOWN', status: 503 });
    expect(posts).toBe(1);
    release();
    await first;
    await expect(service.createTextTemplate(firstOrganization, channel, { ...input, name: 'aviso_concorrente', body: 'Outro texto.' }, 'key-a'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('isola reserva e reconciliação entre duas empresas e não consulta canal alheio', async () => {
    const posts: string[] = [];
    const service = serviceFor({ [firstOrganization]: 'waba-one', [secondOrganization]: 'waba-two' }, {
      async listTemplates() { return []; },
      async createTextTemplate(waba) { posts.push(waba); return { id: waba === 'waba-one' ? '20101' : '20202' }; },
    });
    const name = 'aviso_isolado';
    await expect(service.createTextTemplate(firstOrganization, `channel-${secondOrganization}`, { ...input, name }, 'same-key'))
      .rejects.toMatchObject({ status: 404 });
    const first = await service.createTextTemplate(firstOrganization, `channel-${firstOrganization}`, { ...input, name }, 'same-key');
    const second = await service.createTextTemplate(secondOrganization, `channel-${secondOrganization}`, { ...input, name }, 'same-key');
    expect(first.id).toBe('20101');
    expect(second.id).toBe('20202');
    expect(posts).toEqual(['waba-one', 'waba-two']);
  });
});
