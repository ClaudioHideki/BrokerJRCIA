import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createChatwootControlService } from '../../src/modules/integrations/chatwoot-control-service.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { createFlowChatwootService } from '../../src/modules/flows/chatwoot-service.js';
import { transitionChannelOwner } from '../../src/modules/attendance/transition.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
let app: ReturnType<typeof buildApp>;
const origin = 'https://managed.example.com';
const broker = 'https://broker.example.com';
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const vault = createIntegrationSecrets(encryptionKey);
const jwtSecret = 'synthetic-routing-jwt-at-least-32-characters';

beforeAll(async () => { db = await attendanceDatabase(); }, 180000);
afterAll(async () => { await app?.close(); await db?.dispose(); });

it('uses canonical creation defaults to prove no automation, then detects a real published binding without changing health', async () => {
  const tenant = await seedAttendanceTenant(db.database, false);
  const org = tenant.org;
  const actor = (await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'", [org])).rows[0].user_id as string;
  const instance = randomUUID();
  await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode,approval_status) VALUES($1,$2,'MANAGED','APPROVED')", [org, origin]);
  await db.transact(org, async tx => {
    await tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,7,$3,'READY')", [org, origin, vault.encrypt(`${org}:chatwoot-account`, 'synthetic-token')]);
    const provider = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic routing') RETURNING id", [org])).rows[0].id;
    await tx.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1::uuid,$2,$3,'Synthetic routing',$4,'CONNECTED')", [instance, org, provider, `synthetic-${instance}`]);
  });
  // Production activation and inbox creation paths; no attendance_owners row is manufactured.
  const channel = await db.transact(org, tx => ensureQrChannel(tx, org, instance));
  const remote = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/inboxes') && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)) as { channel: { webhook_url: string } };
      return Response.json({ id: 31, name: 'Synthetic routing', channel_type: 'Channel::Api', secret: 'synthetic-only', webhook_url: input.channel.webhook_url });
    }
    throw new Error('UNEXPECTED_SYNTHETIC_HTTP');
  });
  const options: ChatwootOptions = { baseUrl: origin, publicOrigin: broker, encryptionKey, transact: db.transact,
    fetch: remote, resolveIntegration: async () => org };
  const chatwoot = createChatwootService(options);
  await chatwoot.connect(org, { channelId: channel.id, name: 'Synthetic routing' }, actor);
  const integration = (await db.database.pool.query('SELECT id FROM chatwoot_connections WHERE organization_id=$1 AND channel_id=$2', [org, channel.id])).rows[0].id as string;
  expect((await db.database.pool.query('SELECT 1 FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2', [org, channel.id])).rowCount).toBe(0);
  const auth = createChatwootControlAuth({ enabled: true, hmacSecret: jwtSecret, managedOrigin: origin, transact: db.transact,
    resolveCurrentRole: async (id, organization) => id === actor && organization === org ? 'OWNER' : null });
  const issued = await auth.issueCredential({ kind: 'JWT', organizationId: org, actorId: actor, role: 'OWNER' },
    { name: 'Synthetic read only', scopes: ['chatwoot:read'], expiresAt: null }, randomUUID());
  const authenticateApiKey = async (raw: string) => raw === issued.secret ? { organizationId: org, apiKeyId: issued.id, scopes: ['chatwoot:read'] } : null;
  const control = createChatwootControlService({ ...options, auth, chatwoot, instances: {} as never, health: {} as never });
  app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    chatwootControl: { jwtSecret, authenticateApiKey, service: auth, facade: control } });
  const headers = { 'x-jrc-api-key': issued.secret };
  const url = `/v1/integrations/chatwoot/control/routing-context?integrationIds=${integration}`;
  const healthBefore = (await db.database.pool.query('SELECT * FROM chatwoot_connection_health WHERE organization_id=$1 ORDER BY integration_id', [org])).rows;
  const initial = await app.inject({ method: 'GET', url, headers });
  expect(initial.statusCode).toBe(200);
  expect(initial.json().data).toEqual([expect.objectContaining({ integrationId: integration, channelId: channel.id, inboxId: 31, state: 'NONE', ownerRevision: null })]);
  expect((await db.database.pool.query('SELECT * FROM chatwoot_connection_health WHERE organization_id=$1 ORDER BY integration_id', [org])).rows).toEqual(healthBefore);

  const foreign = await seedAttendanceTenant(db.database, true);
  const forbidden = await app.inject({ method: 'GET', url: `/v1/integrations/chatwoot/control/routing-context?integrationIds=${foreign.integration}`, headers });
  expect(forbidden.statusCode).toBe(404);
  expect(forbidden.body).not.toContain(foreign.channel);

  await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)', [org]);
  const remoteFlow = randomUUID(), remoteBinding = randomUUID();
  await db.database.pool.query("INSERT INTO flows(id,organization_id,name,graph) VALUES($1,$2,'Synthetic remote','{}')", [remoteFlow, org]);
  await db.database.pool.query(`INSERT INTO flow_chatwoot_bindings(id,organization_id,flow_id,inbox_id,account_id,destination_revision,credential_version,feature_revision,name,channel_type,status,bot_id,operation_state)
    VALUES($1,$2,$3,31,7,1,1,1,'Synthetic remote','Channel::Api','READY',8,'IDLE')`, [remoteBinding, org, remoteFlow]);
  await db.transact(org, tx => transitionChannelOwner(tx, org, { channelId: channel.id, botPublicId: null, botOriginReference: null,
    executor: 'BROKER', remoteBindingId: remoteBinding, expectedOwnerRevision: 0 }));
  let detached = false;
  const flowTransport = vi.fn(async () => detached ? Response.json({}) : Response.json({}, { status: 503 }));
  const remoteFlows = createFlowChatwootService({ ...options, fetch: flowTransport, resolveBinding: async () => org });
  expect(await remoteFlows.disable(org, remoteBinding, 1)).toMatchObject({ remoteDetached: false });
  expect((await db.database.pool.query('SELECT status,operation_state,bot_id,last_error FROM flow_chatwoot_bindings WHERE id=$1', [remoteBinding])).rows[0])
    .toEqual({ status: 'DISABLED', operation_state: 'IDLE', bot_id: '8', last_error: 'FLOW_REMOTE_BOT_DETACH_UNVERIFIED' });
  const uncertain = await app.inject({ method: 'GET', url, headers });
  expect(uncertain.statusCode).toBe(200);
  expect(uncertain.json().data[0].state).not.toBe('NONE');
  detached = true;
  expect(await remoteFlows.disable(org, remoteBinding, 2)).toMatchObject({ remoteDetached: true });
  expect((await app.inject({ method: 'GET', url, headers })).json().data[0].state).toBe('NONE');
  expect((await db.database.pool.query('SELECT bot_id FROM flow_chatwoot_bindings WHERE id=$1', [remoteBinding])).rows[0].bot_id).toBeNull();

  const automations = createAutomationService({ transact: db.transact, enabled: true });
  const graph = { nodes: [
    { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 }, data: {} },
    { id: 'end', type: 'end', label: 'End', position: { x: 1, y: 0 }, data: {} },
  ], edges: [{ id: 'next', source: 'start', target: 'end', port: 'next' }] };
  const automation = await automations.create(org, { name: 'Synthetic routing flow', graph });
  await automations.publish(org, automation.id, automation.draft.revision);
  await automations.bind(org, automation.id, { channelId: channel.id });
  const routed = await app.inject({ method: 'GET', url, headers });
  expect(routed.statusCode).toBe(200);
  expect(routed.json().data[0]).toMatchObject({ state: 'ROUTED', integrationId: integration });
  expect((await db.database.pool.query('SELECT * FROM chatwoot_connection_health WHERE organization_id=$1 ORDER BY integration_id', [org])).rows).toEqual(healthBefore);
  expect(remote).toHaveBeenCalledTimes(1);
});
