import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createChatwootService, chatwootEnvironment, readChatwootAccount, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootProvisioner } from '../../src/modules/integrations/chatwoot-provisioner.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';
import { createQrMessagingService, ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

describe('tenant Chatwoot destinations with real PostgreSQL and two HTTP fixtures', () => {
  let db: IsolatedPostgresDatabase, pool: Pool, options: ChatwootOptions;
  let service: ReturnType<typeof createChatwootService>;
  const tenants: { org: string; origin: string; local: string; token: string; channel: string; server: Server; calls: string[]; rejectSearch: boolean }[] = [];
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl();
    db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
    for (const label of ['a', 'b']) {
      const org = await runInAdminTransaction(db.pool, async tx => {
        const org = (await createOrganization(tx, { name: `HTTP tenant ${label}`, slug: `http-tenant-${label}` })).id;
        const user = (await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${label}@example.test`])).rows[0];
        await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [org, user.id]);
        return org;
      });
      const channel = await withOrganizationTransaction(pool, org, async tx => {
        const provider = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id", [org])).rows[0];
        const instance = (await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Fixture',$3,'CONNECTED') RETURNING id", [org, provider.id, `fixture-${label}`])).rows[0];
        return (await ensureQrChannel(tx, org, instance.id)).id;
      });
      const item = { org, channel, origin: `https://${label}.example.com`, local: '', token: `synthetic-token-${label}`, server: createServer(), calls: [] as string[], rejectSearch: false };
      item.server.on('request', async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const path = new URL(req.url!, item.origin).pathname;
        item.calls.push(`${req.method} ${path}`);
        if (path.startsWith('/rails/active_storage/')) {
          if (req.headers.api_access_token) { res.writeHead(400); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(`%PDF-1.7\nfixture-${label}`); return;
        }
        if (req.headers.api_access_token !== item.token) { res.writeHead(401); res.end('{}'); return; }
        let result: unknown;
        if (path === '/api/v1/profile') result = { accounts: [{ id: 1, role: 'administrator' }] };
        else if (path.endsWith('/inboxes') && req.method === 'POST') result = { id: 31, name: 'Fixture', channel_type: 'Channel::Api', webhook_url: body.channel.webhook_url, secret: `fixture-secret-${label}` };
        else if (path.endsWith('/inboxes')) result = { payload: [{ id: 31, name: `Inbox ${label}`, channel_type: 'Channel::Api' }] };
        else if (path.endsWith('/contacts/search')) {
          if (item.rejectSearch) { item.rejectSearch = false; res.writeHead(503); res.end('{}'); return; }
          result = { payload: [] };
        } else if (path.endsWith('/contacts')) result = { payload: { contact: { id: 41 } } };
        else if (path.endsWith('/contact_inboxes')) result = { source_id: 'fixture-source' };
        else if (path.endsWith('/conversations')) result = { id: 51 };
        else if (path.endsWith('/conversations/51')) result = { id: 51, account_id: 1, inbox_id: 31, meta: { sender: { id: 41, phone_number: null } } };
        else if (path.endsWith('/messages') && req.method === 'GET') result = { payload: [{ id: 61, attachments: [{ id: 71, account_id: 1, message_id: 61, file_type: 'file', data_url: `${item.origin}/rails/active_storage/blobs/signed/fixture.pdf` }] }] };
        else if (path.endsWith('/messages')) result = { id: 61 };
        else { res.writeHead(404); res.end('{}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
      });
      item.server.listen(0, '127.0.0.1'); await once(item.server, 'listening');
      item.local = `http://127.0.0.1:${(item.server.address() as { port: number }).port}`;
      tenants.push(item);
    }
    options = { publicOrigin: 'https://broker.example.com', encryptionKey: Buffer.alloc(32, 7).toString('base64'), externalDestinationsEnabled: true,
      transact: (org, op) => withOrganizationTransaction(pool, org, op), resolveIntegration: async () => undefined,
      // Controlled HTTP fixtures. Production DNS/TLS policy is exercised separately by the real TLS socket suite.
      fetch: async (input, init) => {
        const url = new URL(String(input)), tenant = tenants.find(t => t.origin === url.origin);
        if (!tenant) throw new Error('Unexpected fixture origin');
        return fetch(tenant.local + url.pathname + url.search, init);
      } };
    service = createChatwootService(options);
  });
  afterAll(async () => { for (const t of tenants) { t.server.closeAllConnections(); await new Promise<void>(r => t.server.close(() => r())); } await pool?.end(); await db?.dispose(); });

  it('does not send a credential to a pending destination, then binds equal account IDs to distinct origins', async () => {
    for (const t of tenants) {
      await service.destinations.request(t.org, { mode: 'EXTERNAL', baseUrl: t.origin });
      await expect(service.bindAccount(t.org, { accountId: 1, token: t.token })).rejects.toMatchObject({ code: 'CHATWOOT_DESTINATION_NOT_APPROVED' });
      expect(t.calls).toEqual([]);
      // Test operator approval, independent of the separately tested platform HTTP/CSRF boundary.
      await db.pool.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1", [t.org]);
      const status = await service.bindAccount(t.org, { accountId: 1, token: t.token });
      expect(status).toMatchObject({ configured: true, baseUrl: t.origin, account: { accountId: 1, credentialVersion: 1, compatibility: 'UNVERIFIED' } });
      expect(JSON.stringify(status)).not.toContain(t.token);
      await service.connect(t.org, { channelId: t.channel, name: 'Fixture' });
      expect((await service.inboxes(t.org)).data[0]?.name).toBe(`Inbox ${t.origin.includes('//a.') ? 'a' : 'b'}`);
    }
  });
  it('keeps the previous credential after rejection and increments its version only after successful rotation', async () => {
    const t = tenants[0]!;
    const before = await withOrganizationTransaction(pool, t.org, tx => readChatwootAccount(tx, t.org));
    await expect(service.bindAccount(t.org, { accountId: 1, token: 'revoked-synthetic-token' })).rejects.toMatchObject({ code: 'CHATWOOT_REQUEST_REJECTED' });
    expect((await withOrganizationTransaction(pool, t.org, tx => readChatwootAccount(tx, t.org)))?.encrypted_token).toBe(before?.encrypted_token);
    t.token = 'synthetic-rotated-a';
    await service.bindAccount(t.org, { accountId: 1, token: t.token });
    expect((await service.status(t.org)).account?.credentialVersion).toBe(2);
  });
  it('routes durable jobs, safe retries and attachments to the tenant origin with the feature disabled', async () => {
    const qrKey = 'synthetic-signing-key-for-fixtures';
    const qr = createQrMessagingService({ baseUrl: 'https://unused.example.com', apiKey: 'synthetic', signingKey: qrKey, webhookOrigin: options.publicOrigin,
      transact: options.transact, resolveChannel: async id => {
        const row = (await pool.query('SELECT * FROM resolve_qr_channel($1)', [id])).rows[0];
        return row ? { organizationId: row.organization_id, instanceId: row.instance_id } : undefined;
      } });
    const transport = { ...options, externalDestinationsEnabled: false };
    for (const [index, t] of tenants.entries()) {
      t.rejectSearch = true;
      const authorization = 'Bearer ' + createHmac('sha256', qrKey).update(`qr-webhook\0${t.org}\0${t.channel}`).digest('base64url');
      await qr.ingest(t.channel, authorization, { event: 'messages.upsert', instance: `fixture-${index === 0 ? 'a' : 'b'}`, data: {
        key: { id: 'same-remote-id', remoteJid: '15550000001@s.whatsapp.net', fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'Synthetic HTTP fixture' } } });
      await createChatwootWorker(transport).runOnce(t.org);
      expect((await service.jobs(t.org)).data[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
      await withOrganizationTransaction(pool, t.org, tx => tx.query('UPDATE integration_jobs SET available_at=now() WHERE organization_id=$1', [t.org]));
      await createChatwootWorker(transport).runOnce(t.org);
      expect((await service.jobs(t.org)).data[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
      expect(t.calls.filter(c => c === 'POST /api/v1/accounts/1/conversations/51/messages')).toHaveLength(1);
      const a = await withOrganizationTransaction(pool, t.org, tx => readChatwootAccount(tx, t.org));
      const file = await chatwootEnvironment(transport).client(a!).downloadAttachment(1, 31, 51, 61, 71);
      expect(Buffer.from(file.bytes).toString()).toContain(`fixture-${index === 0 ? 'a' : 'b'}`);
    }
  });
  it('never provisions an external account with the global platform credential', async () => {
    const before = tenants.map(t => t.calls.length);
    const provisioner = createChatwootProvisioner({ ...options, baseUrl: 'https://managed.example.com', platformToken: 'synthetic-global-token' });
    for (const t of tenants) await expect(provisioner.start(t.org, { name: 'Fixture', email: 'fixture@example.test', password: 'Synthetic!12345' }))
      .rejects.toMatchObject({ code: 'CHATWOOT_PLATFORM_DESTINATION_FORBIDDEN' });
    expect(tenants.map(t => t.calls.length)).toEqual(before);
  });
  it('does not let concurrent credential rotations overwrite a newly verified token', async () => {
    const t = tenants[0]!;
    let release!: () => void, arrived = 0;
    const both = new Promise<void>(r => { release = r; });
    const rotating = createChatwootService({ ...options, fetch: async (input, init) => {
      if (new URL(String(input)).pathname === '/api/v1/profile') {
        if (++arrived === 2) release();
        await both;
      }
      return options.fetch!(input, init);
    } });
    const results = await Promise.allSettled([1, 2].map(() => rotating.bindAccount(t.org, { accountId: 1, token: t.token })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'CHATWOOT_CONTEXT_CHANGED' } });
  });
  it('blocks approved-context clients after operator revocation', async () => {
    const t = tenants[0]!, before = t.calls.length;
    await db.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1", [t.org]);
    await expect(service.inboxes(t.org)).rejects.toMatchObject({ code: 'CHATWOOT_DESTINATION_NOT_APPROVED' });
    expect(t.calls).toHaveLength(before);
    await withOrganizationTransaction(pool, t.org, tx => tx.query("UPDATE integration_jobs SET status='PENDING',available_at=now() WHERE organization_id=$1", [t.org]));
    await createChatwootWorker(options).runOnce(t.org);
    expect((await service.jobs(t.org)).data[0]).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(t.calls).toHaveLength(before);
  });
});
