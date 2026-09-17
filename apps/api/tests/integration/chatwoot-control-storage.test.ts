import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { readChatwootAccount } from '../../src/modules/integrations/chatwoot-context.js';
import { observeChatwootCapabilities, accountCompatibility } from '../../src/modules/integrations/chatwoot-compatibility.js';
import { createChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { randomUUID } from 'node:crypto';

let db: IsolatedPostgresDatabase, pool: Pool, org: string, otherOrg: string;
const transact = <T>(id: string, work: OrganizationTransaction<T>) => withOrganizationTransaction(pool, id, work);
beforeAll(async () => {
  const admin = requireTestDatabaseAdminUrl();
  db = await createIsolatedPostgresDatabase(admin);
  await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
  pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
  const ids = [];
  for (const label of ['capability', 'other']) ids.push(await runInAdminTransaction(db.pool, async t => {
    const id = (await createOrganization(t, { name: label, slug: label })).id;
    const user = (await t.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${label}@example.test`])).rows[0].id;
    await t.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [id, user]);
    return id;
  }));
  [org, otherOrg] = ids as [string, string];
});
afterAll(async () => { await pool?.end(); await db?.dispose(); });

it('records verified profile access but requires signed evidence, invalidates it on rotation and rejects stale/cross-tenant observations', async () => {
  const service = createChatwootService({ baseUrl: 'https://managed.example.com', publicOrigin: 'https://broker.example.com',
    encryptionKey: Buffer.alloc(32, 7).toString('base64'), transact, resolveIntegration: async () => undefined,
    fetch: async () => Response.json({ accounts: [{ id: 1, role: 'administrator' }] }) });
  await service.bindAccount(org, { accountId: 1, token: 'synthetic-capability-token' });
  const account = (await transact(org, t => readChatwootAccount(t, org)))!;
  expect(accountCompatibility(account).observations).toEqual({ adminAccount: true, apiAccess: true });
  expect(accountCompatibility(account).state).toBe('UNVERIFIED');
  await transact(org, t => observeChatwootCapabilities(t, account, { apiInbox: true, webhookSecret: true }));
  expect((await service.status(org)).account?.compatibility).toBe('UNVERIFIED');
  await transact(otherOrg, t => observeChatwootCapabilities(t, account, { signedCallback: true }));
  expect((await service.status(org)).account?.compatibility).toBe('UNVERIFIED');
  await transact(org, t => observeChatwootCapabilities(t, account, { signedCallback: true }));
  expect((await service.status(org)).account?.compatibility).toBe('SUPPORTED');
  const recorded = (await transact(org, t => t.query('SELECT capabilities,capabilities_verified_at FROM chatwoot_accounts'))).rows[0];
  expect(recorded.capabilities_verified_at).toBeInstanceOf(Date);
  expect(recorded.capabilities).toMatchObject({ credentialVersion: 1, destinationRevision: account.destination!.revision });
  expect(JSON.stringify(recorded)).not.toContain('synthetic-capability-token');
  await service.bindAccount(org, { accountId: 1, token: 'synthetic-rotated-token' });
  await transact(org, t => observeChatwootCapabilities(t, account, { signedCallback: true, apiInbox: true, webhookSecret: true }));
  const rotated = (await transact(org, t => readChatwootAccount(t, org)))!;
  expect(accountCompatibility(rotated).state).toBe('UNVERIFIED');
  expect(accountCompatibility(rotated).observations).toEqual({ adminAccount: true, apiAccess: true });
  await transact(org, t => observeChatwootCapabilities(t, rotated, { webhookSecret: false }));
  expect((await service.status(org)).account?.compatibility).toBe('UNSUPPORTED');
  await db.pool.query('UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1', [org]);
  expect((await service.status(org)).account?.compatibility).toBe('UNVERIFIED');
});

it('refuses non-API inboxes and occupied callbacks without writing to the remote inbox', async () => {
  let remoteType = 'Channel::Whatsapp', remoteId = 31;
  const calls: string[] = [];
  const service = createChatwootService({ baseUrl: 'https://managed.example.com', publicOrigin: 'https://broker.example.com',
    encryptionKey: Buffer.alloc(32, 7).toString('base64'), transact, resolveIntegration: async () => undefined,
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url).endsWith('/profile')) return Response.json({ accounts: [{ id: 2, role: 'administrator' }] });
      return Response.json({ id: remoteId, name: 'Occupied', channel_type: remoteType, webhook_url: 'https://existing.example.com/events', secret: 'synthetic' });
    } });
  await service.bindAccount(otherOrg, { accountId: 2, token: 'synthetic-inbox-token' });
  const provider = (await transact(otherOrg, t => t.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id", [otherOrg]))).rows[0].id;
  for (const code of ['CHATWOOT_API_INBOX_REQUIRED', 'CHATWOOT_WEBHOOK_REPLACEMENT_REQUIRED']) {
    const channel = await transact(otherOrg, async t => {
      const id = randomUUID();
      const instance = (await t.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,$3,'DISCONNECTED') RETURNING id", [otherOrg, provider, id])).rows[0].id;
      return (await ensureQrChannel(t, otherOrg, instance)).id;
    });
    await expect(service.connect(otherOrg, { channelId: channel, name: 'Fixture', inboxId: remoteId, replaceExistingWebhook: false })).rejects.toMatchObject({ code });
    remoteType = 'Channel::Api'; remoteId++;
  }
  expect(calls.every(call => call.startsWith('GET '))).toBe(true);
});
