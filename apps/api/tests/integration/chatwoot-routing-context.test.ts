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
import { createChatwootRoutingContext } from '../../src/modules/integrations/chatwoot-routing-context.js';
import type { ChatwootControlPrincipal } from '../../src/modules/integrations/chatwoot-control-auth.js';

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

async function humanRoutingFixture(state = 'HUMAN_ACTIVE') {
  const t = await seedAttendanceTenant(db.database), session = randomUUID();
  await db.database.pool.query(`INSERT INTO attendance_owners(organization_id,channel_id,integration_id,revision,executor)
    VALUES($1,$2,$3,5,'NONE')`, [t.org,t.channel,t.integration]);
  await db.database.pool.query(`INSERT INTO attendance_sessions(organization_id,id,channel_id,conversation_id,cycle,state,owner_revision)
    VALUES($1,$2,$3,$4,1,$5,4)`, [t.org,session,t.channel,t.conversation,state]);
  const principal = { organizationId:t.org,accountId:7,destinationRevision:1,chatwootOrigin:`https://${t.org}.example.test`,
    authentication:{kind:'API_KEY',organizationId:t.org} } as ChatwootControlPrincipal;
  const read = createChatwootRoutingContext({transact:db.transact,auth:{revalidate:vi.fn(async()=>principal)} as never});
  const actor = (await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0].user_id as string;
  return {...t,session,actor,read:async()=> (await read(principal,[t.integration])).data[0]!.state};
}

type HumanRoutingFixture = Awaited<ReturnType<typeof humanRoutingFixture>>;
async function addSettledExecution(t:HumanRoutingFixture) {
  const binding=randomUUID(),execution=randomUUID(),outbox=randomUUID();
  await db.database.pool.query(`INSERT INTO automation_bindings(organization_id,id,automation_id,version,channel_id,status)
    VALUES($1,$2,$3,1,$4,'DISABLED')`,[t.org,binding,t.automation,t.channel]);
  await db.database.pool.query(`INSERT INTO automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,
    trigger_event_key,correlation_id,status) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,'CANCELED')`,
  [t.org,execution,t.automation,binding,t.channel,t.conversation,randomUUID(),randomUUID()]);
  await db.database.pool.query(`INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,status)
    VALUES($1,$2,$3,'synthetic',0,'HANDOFF','SENT')`,[t.org,outbox,execution]);
  return {execution,outbox,binding};
}
async function deliveryLedgerSnapshot(t:HumanRoutingFixture) {
  const tables=['chatwoot_mirror_attempts','chatwoot_attendance_observations','integration_jobs','messaging_messages','attendance_sessions'];
  return Object.fromEntries(await Promise.all(tables.map(async table=>[table,
    (await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY id`,[t.org])).rows])));
}
async function addUnknownDelivery(t:HumanRoutingFixture) {
  const message=randomUUID(),job=randomUUID();
  // The local transport outcome is known; only its Chatwoot mirror receipt is uncertain.
  await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
    VALUES($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic delivered message"}','SENT',$1::text,$5)`,[message,t.org,t.channel,t.conversation,'a'.repeat(64)]);
  await db.database.pool.query(`INSERT INTO integration_jobs(id,organization_id,integration_id,kind,dedupe_key,message_id,status)
    VALUES($1::uuid,$2,$3,'MIRROR_MESSAGE',$1::text,$4,'UNKNOWN')`,[job,t.org,t.integration,message]);
  await db.database.pool.query(`INSERT INTO chatwoot_mirror_attempts(organization_id,channel_id,integration_id,destination_revision,account_id,inbox_id,
    conversation_id,remote_conversation_id,cycle,message_id,job_id,lease_token,state)
    VALUES($1,$2,$3,1,7,9,$4,11,1,$5,$6,$7,'UNKNOWN')`,[t.org,t.channel,t.integration,t.conversation,message,job,randomUUID()]);
  for(const disposition of ['ECHO_PENDING','RECONCILE']) {
    await db.database.pool.query(`INSERT INTO chatwoot_attendance_observations(organization_id,integration_id,channel_id,destination_revision,
      credential_revision,account_id,inbox_id,remote_conversation_id,conversation_id,cycle,event_key,event,disposition)
      VALUES($1,$2,$3,1,1,7,9,11,$4,1,$5,'{}',$6)`,[t.org,t.integration,t.channel,t.conversation,randomUUID(),disposition]);
  }
}

it.each(['HUMAN_ACTIVE','ADMIN_PAUSED','RESOLVED'])('proves NONE for an isolated %s session without modifying its state',async state=>{
  const t=await humanRoutingFixture(state),before=await deliveryLedgerSnapshot(t);
  expect(await t.read()).toBe('NONE');
  expect(await deliveryLedgerSnapshot(t)).toEqual(before);
});

it.each(['HUMAN_ACTIVE','ADMIN_PAUSED'])('permits reading %s with mirror UNKNOWN and echo/reconcile observations without settling or replaying them',async state=>{
  const t=await humanRoutingFixture(state);await addUnknownDelivery(t);
  const before=await deliveryLedgerSnapshot(t);
  expect(await t.read()).toBe('NONE');
  expect(await t.read()).toBe('NONE');
  expect(await deliveryLedgerSnapshot(t)).toEqual(before);
});

it('uses the actual NONE transition to leave a prior bot session paused while proving automation absence',async()=>{
  const t=await humanRoutingFixture('BOT_ACTIVE');
  await db.database.pool.query("UPDATE messaging_channels SET bot_public_id='synthetic-bot',bot_origin_reference='synthetic' WHERE id=$1",[t.channel]);
  await db.database.pool.query("UPDATE attendance_owners SET executor='EXTERNAL' WHERE organization_id=$1 AND channel_id=$2",[t.org,t.channel]);
  expect(await t.read()).toBe('ROUTED');
  await db.transact(t.org,tx=>transitionChannelOwner(tx,t.org,{channelId:t.channel,botPublicId:null,botOriginReference:null,executor:'NONE',expectedOwnerRevision:5}));
  expect((await db.database.pool.query('SELECT state FROM attendance_sessions WHERE organization_id=$1',[t.org])).rows[0].state).toBe('ADMIN_PAUSED');
  expect(await t.read()).toBe('NONE');
});

it.each(['BOT_ACTIVE','WAITING_INPUT','HANDOFF_PENDING','WAITING_HUMAN'])('keeps %s session evidence closed without a configured bot',async state=>{
  expect(await (await humanRoutingFixture(state)).read()).toBe('ROUTED');
});

it('keeps the existing automation outbox UNKNOWN guard with a human session',async()=>{
  const t=await humanRoutingFixture(),e=await addSettledExecution(t);
  await db.database.pool.query("UPDATE automation_outbox SET status='UNKNOWN' WHERE organization_id=$1 AND id=$2",[t.org,e.outbox]);
  const before=(await db.database.pool.query('SELECT * FROM automation_outbox WHERE organization_id=$1',[t.org])).rows;
  expect(await t.read()).toBe('ROUTED');
  expect((await db.database.pool.query('SELECT * FROM automation_outbox WHERE organization_id=$1',[t.org])).rows).toEqual(before);
});

it('keeps unknown canonical ownership, active bot pointers and paused routing bindings closed',async()=>{
  const t=await humanRoutingFixture();
  // A non-ready canonical mapping cannot establish absence.
  await db.database.pool.query("UPDATE chatwoot_connections SET status='FAILED' WHERE organization_id=$1",[t.org]);
  expect(await t.read()).toBe('UNKNOWN');
  await db.database.pool.query("UPDATE chatwoot_connections SET status='READY' WHERE organization_id=$1",[t.org]);
  await db.database.pool.query("UPDATE messaging_channels SET bot_public_id='synthetic-bot',bot_origin_reference='synthetic' WHERE id=$1",[t.channel]);
  expect(await t.read()).toBe('ROUTED');
  await db.database.pool.query('UPDATE messaging_channels SET bot_public_id=NULL,bot_origin_reference=NULL WHERE id=$1',[t.channel]);
  const e=await addSettledExecution(t);
  await db.database.pool.query("UPDATE automation_bindings SET status='PAUSED' WHERE organization_id=$1 AND id=$2",[t.org,e.binding]);
  expect(await t.read()).toBe('ROUTED');
});

it('preserves an UNKNOWN remote routing binding operation even after its bot pointer was locally cleared',async()=>{
  const t=await humanRoutingFixture(),flow=randomUUID();
  await db.database.pool.query("INSERT INTO flows(id,organization_id,name,graph) VALUES($1,$2,'Synthetic uncertain route','{}')",[flow,t.org]);
  await db.database.pool.query(`INSERT INTO flow_chatwoot_bindings(organization_id,flow_id,inbox_id,account_id,destination_revision,
    credential_version,feature_revision,name,channel_type,status,operation_state)
    VALUES($1,$2,9,7,1,1,1,'Synthetic uncertain route','Channel::Api','DISABLED','UNKNOWN')`,[t.org,flow]);
  const before=(await db.database.pool.query('SELECT * FROM flow_chatwoot_bindings WHERE organization_id=$1',[t.org])).rows;
  expect(await t.read()).toBe('ROUTED');
  expect((await db.database.pool.query('SELECT * FROM flow_chatwoot_bindings WHERE organization_id=$1',[t.org])).rows).toEqual(before);
});
