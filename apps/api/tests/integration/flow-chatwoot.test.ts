import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { welcomeFlow, triageFlow } from '@jrc/contracts';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createFlowService } from '../../src/modules/flows/service.js';
import { createFlowChatwootService } from '../../src/modules/flows/chatwoot-service.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

describe('durable Flow Agent Bot transport', () => {
  let db: IsolatedPostgresDatabase, pool: Pool;
  const key = Buffer.alloc(32, 7).toString('base64'), vault = createIntegrationSecrets(key);
  let nextAccount = 1;
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
  }, 60000);
  afterAll(async () => { await pool?.end(); await db?.dispose(); });
  async function fixture() {
    const org = randomUUID(), accountId = nextAccount++, inboxId = 7, botId = 8;
    const transact = <T>(id: string, fn: Parameters<typeof withOrganizationTransaction<T>>[2]) => withOrganizationTransaction(pool, id, fn);
    const seed=await db.pool.connect();
    try {
      await seed.query('begin');
      await seed.query("insert into organizations(id,name,slug) values($1::uuid,'Synthetic Flow', $1::text)", [org]);
      const owner=(await seed.query("insert into users(email,password_hash) values($1,'synthetic-no-login') returning id", [org+'@example.test'])).rows[0].id;
      await seed.query("insert into memberships(organization_id,user_id,role) values($1,$2,'OWNER')", [org,owner]);
      await seed.query('commit');
    } finally { await seed.query('rollback'); seed.release(); }
    await db.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [org]);
    await db.pool.query("insert into chatwoot_destinations(organization_id,base_url,mode,approval_status) values($1,'https://support.example.test','EXTERNAL','APPROVED')", [org]);
    await db.pool.query("insert into chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) values($1,'https://support.example.test',$2,$3,'READY')", [org, accountId, vault.encrypt(`${org}:chatwoot-account`, 'synthetic-admin')]);
    let remoteBot: Record<string, unknown> | null = null, assigned: Record<string, unknown> | null = null;
    let canonicalStatus = 'pending', failSend = false, supported = true, failAssign = false;
    const deliveries: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/inboxes')) return Response.json({ payload: [{ id: inboxId, name: 'Email sintético', channel_type: 'Channel::Email' }] });
      if (path.endsWith('/agent_bots') && init?.method === 'GET') return Response.json(remoteBot ? [remoteBot] : []);
      if (path.endsWith('/agent_bots')) { remoteBot = { id: botId, name: body.name, outgoing_url: body.outgoing_url,
        ...(supported ? { secret: 'synthetic-signature-secret', access_token: { token: 'synthetic-bot' } } : {}) }; return Response.json(remoteBot); }
      if (path.endsWith('/agent_bot')) return Response.json({ agent_bot: assigned });
      if (path.endsWith('/set_agent_bot')) { assigned = body.agent_bot ? remoteBot : null; if(failAssign){failAssign=false;throw new Error('lost assignment response');} return Response.json({}); }
      if (/\/conversations\/\d+$/.test(path)) return Response.json({ id: Number(path.split('/').at(-1)), account_id: accountId, inbox_id: inboxId, status: canonicalStatus, meta: { sender: { id: 3, name: 'Ana' } } });
      if (path.endsWith('/messages')) { deliveries.push(body); if (failSend) throw new Error('uncertain synthetic network failure'); return Response.json({ id: 123 }); }
      if (path.endsWith('/toggle_status')) { canonicalStatus = body.status; return Response.json({}); }
      throw new Error('Unexpected synthetic request: ' + path);
    });
    const flows = createFlowService({ transact });
    const flow = await flows.create(org, { name: 'Teste', graph: welcomeFlow() }); await flows.publish(org, flow.id, flow.revision);
    const restart = () => createFlowChatwootService({ transact, publicOrigin: 'https://broker.example.test', encryptionKey: key,
      externalDestinationsEnabled: true, fetch, resolveIntegration: async () => undefined,
      resolveBinding: async id => (await pool.query('select * from resolve_flow_chatwoot_binding($1)', [id])).rows[0]?.organization_id });
    const service = restart();
    async function event(bindingId: string, id = 10, extra = {}) {
      const raw = Buffer.from(JSON.stringify({ event: 'message_created', id, account: { id: accountId }, inbox: { id: inboxId },
        conversation: { id: 9, inbox_id: inboxId }, private: false, message_type: 'incoming', content: 'Oi', sender: { id: 3, type: 'contact' }, ...extra }));
      const time = String(Math.floor(Date.now() / 1000));
      const signature = 'sha256=' + createHmac('sha256', 'synthetic-signature-secret').update(time + '.').update(raw).digest('hex');
      return service.ingest(bindingId, raw, time, signature);
    }
    return { org, service, restart, flows, flow, deliveries, fetch, event, transact, setStatus: (v: string) => { canonicalStatus = v; }, getStatus:()=>canonicalStatus,
      failSend: () => { failSend = true; }, unsupported: () => { supported = false; },
      failAssign: () => { failAssign = true; },
      competing: () => { assigned = { id: 99, name: 'Existing bot' }; } };
  }
  it('creates a signed bot, persists a turn once and sends it once after duplicate webhook/restart', async () => {
    const f = await fixture(), binding = await f.service.bind(f.org, f.flow.id, 7);
    expect(binding.status).toBe('READY'); expect(JSON.stringify(binding)).not.toContain('synthetic-');
    await f.event(binding.id); await f.event(binding.id); await f.service.runOnce(f.org); await f.restart().runOnce(f.org);
    expect(f.deliveries).toHaveLength(1);
    expect((await f.service.runs(f.org, f.flow.id)).data).toHaveLength(1);
    expect((await db.pool.query('select state from flow_chatwoot_sessions where organization_id=$1', [f.org])).rows[0].state.status).toBe('completed');
  });
  it('rejects a competing bot and a fork that cannot sign callbacks', async () => {
    const f = await fixture(); f.competing();
    await expect(f.service.bind(f.org, f.flow.id, 7)).rejects.toMatchObject({ code: 'FLOW_INBOX_HAS_BOT' });
    const g = await fixture(); g.unsupported();
    await expect(g.service.bind(g.org, g.flow.id, 7)).rejects.toMatchObject({ code: 'FLOW_CHATWOOT_SIGNING_REQUIRED' });
    expect(g.fetch.mock.calls.some(c => String(c[0]).endsWith('/set_agent_bot'))).toBe(false);
  });
  it('requires a valid signature and tenant ownership, without leaking bot credentials', async () => {
    const f = await fixture(), g = await fixture(), b = await f.service.bind(f.org, f.flow.id, 7);
    await expect(f.service.ingest(b.id, Buffer.from('{}'), '1', 'invalid')).rejects.toMatchObject({ code: 'FLOW_SIGNATURE_INVALID' });
    await expect(g.service.disable(g.org, b.id)).rejects.toMatchObject({ code: 'FLOW_BINDING_NOT_FOUND' });
    expect((await g.transact(g.org, tx => tx.query('select * from flow_chatwoot_bindings where id=$1', [b.id]))).rows).toEqual([]);
  });
  it('rejects malformed JSON after signature verification with a client error', async () => {
    const f=await fixture(),b=await f.service.bind(f.org,f.flow.id,7),raw=Buffer.from('{malformed');
    const time=String(Math.floor(Date.now()/1000));
    const signature='sha256='+createHmac('sha256','synthetic-signature-secret').update(time+'.').update(raw).digest('hex');
    await expect(f.service.ingest(b.id,raw,time,signature)).rejects.toMatchObject({code:'INVALID_REQUEST',statusCode:400});
  });
  it('bounds read retries without blocking other conversations or reordering the affected conversation', async () => {
    const f=await fixture(),b=await f.service.bind(f.org,f.flow.id,7);
    const normalFetch=f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async(url,init)=>String(url).endsWith('/conversations/9')?Response.json({}, {status:503}):normalFetch(url,init));
    await f.event(b.id,10);await f.event(b.id,11);await f.event(b.id,12,{conversation:{id:10,inbox_id:7}});
    await f.service.runOnce(f.org);await f.service.runOnce(f.org);
    expect(f.deliveries).toHaveLength(1);
    let rows=(await db.pool.query('select message_id,status,attempts from flow_chatwoot_events where organization_id=$1 order by message_id',[f.org])).rows;
    expect(rows.map(r=>r.status)).toEqual(['PENDING','PENDING','DONE']);
    expect(rows[0].attempts).toBe(1);expect(rows[1].attempts).toBe(0);
    for(let attempt=1;attempt<5;attempt++){
      await db.pool.query("update flow_chatwoot_events set available_at=now()-interval '1 second' where organization_id=$1 and message_id=10",[f.org]);
      await f.service.runOnce(f.org);
    }
    await f.service.runOnce(f.org);
    rows=(await db.pool.query('select message_id,status,attempts from flow_chatwoot_events where organization_id=$1 order by message_id',[f.org])).rows;
    expect(rows.map(r=>r.status)).toEqual(['FAILED','PENDING','DONE']);expect(rows[0].attempts).toBe(5);
    expect(f.deliveries).toHaveLength(1);
  });
  it('does not execute a private note or its own reply', async () => {
    const f = await fixture(), b = await f.service.bind(f.org, f.flow.id, 7);
    await f.event(b.id, 10, { private: true });
    await f.event(b.id, 11, { message_type: 'outgoing', sender: { id: 8, type: 'agent_bot' } });
    await f.service.runOnce(f.org); expect(f.deliveries).toEqual([]);
  });
  it('lets a human preempt queued work and checks canonical conversation state', async () => {
    const f = await fixture(), b = await f.service.bind(f.org, f.flow.id, 7);
    await f.event(b.id); await f.event(b.id, 11, { message_type: 'outgoing', sender: { id: 1, type: 'user' } });
    await f.service.runOnce(f.org); expect(f.deliveries).toEqual([]);
    const g = await fixture(), c = await g.service.bind(g.org, g.flow.id, 7);
    await g.event(c.id); g.setStatus('open'); await g.service.runOnce(g.org); expect(g.deliveries).toEqual([]);
  });
  it.each(['feature', 'destination', 'disabled'])('revokes queued work on %s changes', async kind => {
    const f = await fixture(), b = await f.service.bind(f.org, f.flow.id, 7); await f.event(b.id);
    if (kind === 'feature') await db.pool.query('update flow_features set enabled=false,revision=revision+1 where organization_id=$1', [f.org]);
    if (kind === 'destination') await db.pool.query('update chatwoot_destinations set revision=revision+1 where organization_id=$1', [f.org]);
    if (kind === 'disabled') await f.service.disable(f.org, b.id);
    await f.service.runOnce(f.org); expect(f.deliveries).toEqual([]);
  });
  it('records uncertain delivery and never automatically repeats it', async () => {
    const f = await fixture(), b = await f.service.bind(f.org, f.flow.id, 7); await f.event(b.id); f.failSend();
    await f.service.runOnce(f.org); await f.service.runOnce(f.org);
    expect(f.deliveries).toHaveLength(1);
    expect((await db.pool.query('select status from flow_chatwoot_outbox where organization_id=$1', [f.org])).rows[0].status).toBe('UNKNOWN');
  });
  it('reconciles an assignment whose response was lost without creating a second bot', async () => {
    const f=await fixture();f.failAssign();
    await expect(f.service.bind(f.org,f.flow.id,7)).rejects.toMatchObject({uncertain:true});
    expect((await f.service.bind(f.org,f.flow.id,7)).status).toBe('READY');
    expect(f.fetch.mock.calls.filter(c=>String(c[0]).endsWith('/agent_bots')&&c[1]?.method==='POST')).toHaveLength(1);
  });
  it('resumes stored inputs on the pinned version then hands off after the last output', async () => {
    const f=await fixture(), saved=await f.flows.save(f.org,f.flow.id,{name:'Triagem',graph:triageFlow(),revision:f.flow.revision});
    await f.flows.publish(f.org,f.flow.id,saved.revision);
    const b=await f.service.bind(f.org,f.flow.id,7);await f.event(b.id);await f.service.runOnce(f.org);
    const changed=await f.flows.save(f.org,f.flow.id,{name:'Novo',graph:welcomeFlow(),revision:saved.revision});
    await f.flows.publish(f.org,f.flow.id,changed.revision);
    await f.event(b.id,11,{content:'Ana'});await f.restart().runOnce(f.org);
    await f.event(b.id,12,{content:'Quero suporte'});await f.restart().runOnce(f.org);
    for(let i=0;i<5;i++)await f.restart().runOnce(f.org);
    const session=(await db.pool.query('select * from flow_chatwoot_sessions where organization_id=$1',[f.org])).rows[0];
    expect(session.version).toBe(2);expect(session.state.status).toBe('handoff');expect(session.human).toBe(true);
    expect(f.getStatus()).toBe('open');
  });
  it('makes an interrupted sending claim unknown and keeps later replies blocked', async () => {
    const f=await fixture(),b=await f.service.bind(f.org,f.flow.id,7);await f.event(b.id);
    // Process the turn, then model a crash after the durable sending claim.
    const worker=f.restart();worker.deliverOnce=async()=>{};await worker.runOnce(f.org);
    await db.pool.query("update flow_chatwoot_outbox set status='SENDING',lease_expires_at=now()-interval '1 second' where organization_id=$1",[f.org]);
    await f.restart().runOnce(f.org);expect(f.deliveries).toEqual([]);
    expect((await db.pool.query('select status from flow_chatwoot_outbox where organization_id=$1',[f.org])).rows[0].status).toBe('UNKNOWN');
  });
});
