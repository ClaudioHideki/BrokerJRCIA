import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { createAutomationService, createEventRouter } from '../../src/modules/automations/service.js';
import { transitionChannelOwner } from '../../src/modules/attendance/transition.js';
import { AUTOMATION_ORIGIN } from '@jrc/contracts';
import { createChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
import {readCentralTransportBinding} from '../../src/modules/messaging/central-transport.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
const codec = createIntegrationSecrets(Buffer.alloc(32, 19).toString('base64'));
beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
afterAll(async () => { await db?.dispose(); });
async function implementation() {
  const path = '../../src/modules/integrations/chatwoot-runtime-ingress.js';
  const module = await import(path).catch(() => null);
  expect(module, 'durable central ingress must exist').not.toBeNull();
  return module!;
}
async function fixture(originOverride?: string) {
  const org = randomUUID(), channel = randomUUID(), integration = randomUUID();
  const origin = originOverride ?? `https://${org}.example.test`, secret = 'synthetic-callback-secret';
  const seed = await db.database.pool.connect();
  try {
  await seed.query('BEGIN');
  await seed.query("INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Central ingress',$1::text)", [org]);
  const user = randomUUID();
  await seed.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'no-login')", [user, `${user}@example.test`]);
  await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [org, user]);
  await seed.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)', [org]);
  await seed.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status,encrypted_token) VALUES($1,$2,7,'READY',$3)", [org, origin, codec.encrypt(`chatwoot:${org}`, 'synthetic-account-token')]);
  await seed.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1", [org]);
  await seed.query('COMMIT');
  } catch(error) { await seed.query('ROLLBACK'); throw error; } finally { seed.release(); }
  const { createCentralTransportChannel } = await implementation();
  const binding = await db.transact(org, tx => createCentralTransportChannel(tx, { organizationId: org, channelId: channel, integrationId: integration,
    origin, accountId: 7, inboxId: 9, destinationRevision: 1, credentialVersion: 1, ownerRevision: 0,
    encryptedWebhookSecret: codec.encrypt(`${org}:chatwoot-webhook:${integration}`, secret), name: 'Synthetic central' }));
  return { org, channel, integration, secret, binding };
}
function signed(t: Awaited<ReturnType<typeof fixture>>, remoteMessageId = 201, remoteConversationId = 101, extra = {}) {
  const payload = { event: 'message_created', id: remoteMessageId, account: { id: 7 }, inbox: { id: 9 },
    conversation: { id: remoteConversationId, inbox_id: 9, contact_inbox: { contact_id: 301 } },
    private: false, message_type: 'incoming', content: 'Synthetic greeting', sender: { id: 301, type: 'contact' }, ...extra };
  const raw = Buffer.from(JSON.stringify(payload)), timestamp = String(Math.floor(Date.now() / 1000));
  return { integrationId: t.integration, raw, timestamp, signature: 'sha256=' + createHmac('sha256', t.secret).update(timestamp + '.').update(raw).digest('hex') };
}
async function receiver(extra = {}) {
  const { createChatwootRuntimeIngress } = await implementation();
  return createChatwootRuntimeIngress({ transact: db.transact, secrets: codec, resolveIntegration: async (id:string) =>
    (await db.transact('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT organization_id FROM resolve_chatwoot_integration($1)', [id]))).rows[0]?.organization_id ?? null, ...extra });
}
it('installs tenant-isolated central storage with no invented physical identity', async () => {
  const table = (await db.database.pool.query("SELECT to_regclass('public.central_runtime_events') AS name")).rows[0].name;
  expect(table).toBe('central_runtime_events');
  const t = await fixture();
  const row = (await db.transact(t.org, tx => tx.query('SELECT transport,provider,provider_account_id,instance_id,phone_number_id,waba_id,credential_reference FROM messaging_channels WHERE id=$1', [t.channel]))).rows[0];
  expect(row).toEqual({ transport: 'CENTRAL_TRANSPORT', provider: null, provider_account_id: null, instance_id: null, phone_number_id: null, waba_id: null, credential_reference: null });
  const other = await fixture();
  expect((await db.transact(other.org, tx => tx.query('SELECT * FROM central_transport_bindings WHERE channel_id=$1', [t.channel]))).rowCount).toBe(0);
  expect((await db.database.pool.query("SELECT has_table_privilege('jrc_auth','central_runtime_events','SELECT') AS allowed")).rows[0].allowed).toBe(false);
});
it('keeps the central ingress usable after a canonical owner transition without manual revision updates',async()=>{
 const t=await fixture(),automation=createAutomationService({transact:db.transact,enabled:true});
 const graph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'end',type:'end',label:'End',position:{x:100,y:0},data:{}}],edges:[{id:'next',source:'start',target:'end',port:'next'}]};
 const draft=await automation.create(t.org,{name:'Synthetic transition',graph});await automation.publish(t.org,draft.id,1);
 const changed=await db.transact(t.org,tx=>transitionChannelOwner(tx,t.org,{channelId:t.channel,botPublicId:draft.id,botOriginReference:AUTOMATION_ORIGIN,expectedOwnerRevision:0}));
 expect((await db.transact(t.org,tx=>readCentralTransportBinding(tx,t.org,t.integration))).binding.ownerRevision).toBe(changed.ownerRevision);
});
it('records individual callback evidence only for authenticated events in the current binding context',async()=>{
 const t=await fixture(),service=await receiver();
 await expect(service.receive({...signed(t),signature:'sha256='+'0'.repeat(64)})).rejects.toThrow();
 expect((await db.transact(t.org,tx=>tx.query('SELECT callback_verified_at FROM central_transport_bindings WHERE channel_id=$1',[t.channel]))).rows[0].callback_verified_at).toBeNull();
 await service.receive(signed(t));
 expect((await db.transact(t.org,tx=>tx.query('SELECT callback_verified_at,callback_credential_version,callback_destination_revision FROM central_transport_bindings WHERE channel_id=$1',[t.channel]))).rows[0]).toEqual({callback_verified_at:expect.any(Date),callback_credential_version:1,callback_destination_revision:1});
});
it('does not let a second company claim the same remote origin/account/inbox or leave a partial channel', async () => {
  const t = await fixture();
  await expect(fixture(t.binding.origin)).rejects.toMatchObject({code:'23505'});
  expect((await db.database.pool.query('SELECT channel_id FROM central_transport_bindings WHERE origin=$1 AND account_id=7 AND inbox_id=9',[t.binding.origin])).rows)
    .toEqual([{channel_id:t.channel}]);
  expect((await db.database.pool.query('SELECT m.id FROM messaging_channels m JOIN chatwoot_accounts a ON a.organization_id=m.organization_id WHERE a.base_url=$1',[t.binding.origin])).rows)
    .toEqual([{id:t.channel}]);
});
async function ownedFixture() {
 const t=await fixture(),automation=createAutomationService({transact:db.transact,enabled:true});
 const graph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'menu',type:'menu',label:'Menu',position:{x:100,y:0},data:{text:'Synthetic menu',variable:'choice',options:[{value:'1',label:'End'},{value:'2',label:'Finish'}]}},{id:'end',type:'end',label:'End',position:{x:200,y:0},data:{}}],edges:[{id:'next',source:'start',target:'menu',port:'next'},{id:'end',source:'menu',target:'end',port:'option-1'},{id:'finish',source:'menu',target:'end',port:'option-2'}]};
 const draft=await automation.create(t.org,{name:'Synthetic central menu',graph});
 expect(await automation.validate(t.org,draft.id)).toMatchObject({valid:true});
 await automation.publish(t.org,draft.id,1);
 await db.transact(t.org,async tx=>{
  const owner=await transitionChannelOwner(tx,t.org,{channelId:t.channel,botPublicId:draft.id,botOriginReference:AUTOMATION_ORIGIN,version:1});
  await tx.query('UPDATE central_transport_bindings SET owner_revision=$3 WHERE organization_id=$1 AND channel_id=$2',[t.org,t.channel,owner.ownerRevision]);
 });
 return t;
}
const canonical = (status='pending',createdAt=Math.floor(Date.now()/1000)) => ({
 conversation:{id:101,account_id:7,inbox_id:9,status,meta:{assignee:null,team:null}},
 message:{id:201,conversation_id:101,message_type:'incoming',private:false,content:'Synthetic greeting',content_type:'text',sender:{id:301,type:'contact'},created_at:createdAt},
});
it('admits one fresh canonical input through the existing runtime after concurrent GETs and restart',async()=>{
 const t=await ownedFixture(),service=await receiver({readCanonical:async()=>canonical(),router:createEventRouter({transact:db.transact,enabled:true})});
 const receipt=await service.receive(signed(t));
 expect(typeof service.process).toBe('function');
 const results=await Promise.all([service.process(t.org,receipt.eventId),service.process(t.org,receipt.eventId)]);
 expect(results.map((r:{duplicate:boolean})=>r.duplicate).sort()).toEqual([false,true]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT id,status FROM automation_executions'))).rows).toEqual([expect.objectContaining({status:'QUEUED'})]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT message_id FROM messaging_bot_jobs'))).rows).toEqual([]);
});
it.each(['history','human','mismatched message','credential changed during GET'])('stores but never starts the bot for %s',async reason=>{
 const t=await ownedFixture(),service=await receiver({router:createEventRouter({transact:db.transact,enabled:true}),readCanonical:async()=>{
  if(reason==='credential changed during GET')await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);
  const result=canonical(reason==='human'?'open':'pending',reason==='history'?1:Math.floor(Date.now()/1000));
  if(reason==='mismatched message')result.message.id=202;
  return result;
 }});
 const receipt=await service.receive(signed(t));expect(typeof service.process).toBe('function');
 if(reason==='credential changed during GET'||reason==='mismatched message')await expect(service.process(t.org,receipt.eventId)).rejects.toThrow();
 else expect(await service.process(t.org,receipt.eventId)).toMatchObject({disposition:'IGNORED'});
 expect((await db.transact(t.org,tx=>tx.query('SELECT id FROM automation_executions'))).rowCount).toBe(0);
 expect((await db.transact(t.org,tx=>tx.query('SELECT id FROM messaging_messages'))).rowCount).toBe(1);
});
it('applies a human reply and pending observation without mirroring or resuming',async()=>{
 const t=await ownedFixture(),service=await receiver({readCanonical:async()=>canonical(),router:createEventRouter({transact:db.transact,enabled:true})});
 const first=await service.receive(signed(t));expect(typeof service.process).toBe('function');await service.process(t.org,first.eventId);
 await service.receive(signed(t,202,101,{message_type:'outgoing',sender:{id:401,type:'user'},content:'Synthetic human reply'}));
 const payload={event:'conversation_updated',id:101,account:{id:7},inbox_id:9,status:'pending',meta:{assignee:null,team:null}};
 const raw=Buffer.from(JSON.stringify(payload)),timestamp=String(Math.floor(Date.now()/1000));
 await service.receive({integrationId:t.integration,raw,timestamp,signature:'sha256='+createHmac('sha256',t.secret).update(timestamp+'.').update(raw).digest('hex')});
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'HUMAN'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT id FROM integration_jobs'))).rows).toEqual([]);
});
it.each(['public reply','private reply','control'])('retains human precedence for signed %s with canonical decimal string IDs',async kind=>{
 const t=await ownedFixture(),service=await receiver({readCanonical:async()=>canonical(),router:createEventRouter({transact:db.transact,enabled:true})});
 const first=await service.receive(signed(t));await service.process(t.org,first.eventId);
 const payload=kind==='control'?{event:'conversation_updated',id:'101',account:{id:'7'},inbox_id:'9',status:'open',meta:{assignee:{id:401,type:'user'},team:null}}
  :{event:'message_created',id:'202',account:{id:'7'},inbox:{id:'9'},conversation:{id:'101',inbox_id:'9'},private:kind==='private reply',message_type:'outgoing',sender:{id:'401',type:'user'},content:'Synthetic human reply'};
 const raw=Buffer.from(JSON.stringify(payload)),timestamp=String(Math.floor(Date.now()/1000)),request={integrationId:t.integration,raw,timestamp,signature:'sha256='+createHmac('sha256',t.secret).update(timestamp+'.').update(raw).digest('hex')};
 expect(await service.receive(request)).toMatchObject({disposition:'OBSERVED',duplicate:false});
 expect(await service.receive(request)).toMatchObject({disposition:'OBSERVED',duplicate:true});
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'HUMAN'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT id FROM integration_jobs'))).rows).toEqual([]);
});
it('uses the existing integration ingress for a central inbox without invoking the legacy flow executor',async()=>{
 const t=await fixture(),service=createChatwootService({publicOrigin:'https://broker.example.test',baseUrl:t.binding.origin,
  encryptionKey:Buffer.alloc(32,19).toString('base64'),transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined});
 const request=signed(t);await service.ingest(request.integrationId,request.raw,request.timestamp,request.signature);
 expect((await db.transact(t.org,tx=>tx.query('SELECT content FROM messaging_messages'))).rows).toEqual([{content:{type:'TEXT',text:'Synthetic greeting'}}]);
 await expect(service.ingest(request.integrationId,request.raw,request.timestamp,'sha256'+'0'.repeat(64))).rejects.toMatchObject({status:401});
});
it('does not let the physical bot-job path schedule a central message before canonical admission',async()=>{
 const t=await ownedFixture(),service=await receiver();await service.receive(signed(t));
 const {createPostgresMessagingRepository}=await import('../../src/modules/messaging/repository.js');
 await db.transact(t.org,async tx=>{
  const conversation=(await tx.query('SELECT id FROM messaging_conversations')).rows[0].id;
  await createPostgresMessagingRepository().recordIncoming(tx,{organizationId:t.org,id:randomUUID(),channelId:t.channel,conversationId:conversation,
    upstreamMessageId:'synthetic-bypass',webhookEventKey:'synthetic-bypass',content:{type:'TEXT',text:'Synthetic bypass'}});
  expect((await tx.query('SELECT message_id FROM messaging_bot_jobs')).rows).toEqual([]);
 });
});
it('does not claim a central outbox through a QR or Meta worker',async()=>{
 const t=await fixture(),service=await receiver();const incoming=await service.receive(signed(t));
 const {createPostgresMessagingRepository}=await import('../../src/modules/messaging/repository.js');const messaging=createPostgresMessagingRepository();
 await db.transact(t.org,async tx=>{
  await messaging.enqueueOutgoing(tx,{organizationId:t.org,id:randomUUID(),channelId:t.channel,conversationId:incoming.conversationId,source:'OPERATOR',
   content:{type:'TEXT',text:'Synthetic output'},idempotencyKey:'central-output',bodyHash:'a'.repeat(64),policy:{requireOptIn:false}});
  expect(await messaging.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(Date.now()+1000),leaseMs:30000,limit:10})).toEqual([]);
 });
});
it('rejects a secret rotated between signature snapshot and durable admission',async()=>{
 const t=await fixture();let reads=0;
 const service=await receiver({transact:async <T>(org:string,work:Parameters<typeof db.transact<T>>[1])=>{
  const result=await db.transact(org,work);
  if(++reads===1)await db.database.pool.query('UPDATE chatwoot_connections SET encrypted_webhook_secret=$2 WHERE id=$1',[t.integration,codec.encrypt(`${t.org}:chatwoot-webhook:${t.integration}`,'rotated-synthetic-secret')]);
  return result;
 }});
 await expect(service.receive(signed(t))).rejects.toThrow('CENTRAL_CONTEXT_CHANGED');
 expect((await db.transact(t.org,tx=>tx.query('SELECT id FROM central_runtime_events'))).rowCount).toBe(0);
});
it('rolls back the reservation, contact, map and message when storage fails',async()=>{
 const t=await fixture();
 await db.database.pool.query(`CREATE FUNCTION synthetic_reject_central() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$;
 CREATE TRIGGER synthetic_reject_central BEFORE INSERT ON chatwoot_messages FOR EACH ROW EXECUTE FUNCTION synthetic_reject_central()`);
 try{
  await expect((await receiver()).receive(signed(t))).rejects.toThrow('synthetic rollback');
  for(const table of ['central_runtime_events','messaging_contacts','messaging_conversations','messaging_messages','chatwoot_conversations','messaging_inbox_events'])
   expect((await db.transact(t.org,tx=>tx.query(`SELECT 1 FROM ${table}`))).rowCount,table).toBe(0);
 }finally{await db.database.pool.query('DROP TRIGGER synthetic_reject_central ON chatwoot_messages; DROP FUNCTION synthetic_reject_central()');}
});
it('rejects physical identities on a central channel and null identities on a physical channel', async () => {
  const t = await fixture();
  await expect(db.transact(t.org, tx => tx.query("UPDATE messaging_channels SET provider='META' WHERE id=$1", [t.channel]))).rejects.toMatchObject({ code: '23514' });
  await expect(db.transact(t.org, tx => tx.query("INSERT INTO messaging_channels(organization_id,transport) VALUES($1,'BROKER_TRANSPORT')", [t.org]))).rejects.toMatchObject({ code: '23514' });
});
it('reserves both callback deliveries once and stores incoming without mirror, reply or automatic execution', async () => {
  const t = await fixture(), service = await receiver();
  const results = await Promise.all([service.receive(signed(t)), service.receive(signed(t))]);
  expect(results.map((r: { duplicate: boolean }) => r.duplicate).sort()).toEqual([false, true]);
  expect(results[0].eventId).toBe(results[1].eventId);
  const rows = await db.transact(t.org, async tx => ({
    messages: (await tx.query('SELECT content,direction,source FROM messaging_messages WHERE channel_id=$1', [t.channel])).rows,
    mirror: (await tx.query('SELECT id FROM integration_jobs WHERE integration_id=$1', [t.integration])).rows,
    jobs: (await tx.query('SELECT message_id FROM messaging_bot_jobs')).rows,
    executions: (await tx.query('SELECT id FROM automation_executions')).rows,
  }));
  expect(rows).toEqual({ messages: [{ content: { type: 'TEXT', text: 'Synthetic greeting' }, direction: 'INCOMING', source: 'CONTACT' }], mirror: [], jobs: [], executions: [] });
  expect((await (await receiver()).receive(signed(t))).duplicate).toBe(true);
});
it('separates identical remote IDs across tenants and remote conversations for the same contact', async () => {
  const a = await fixture(), b = await fixture(), service = await receiver();
  const first = await service.receive(signed(a)), other = await service.receive(signed(b));
  const reopened = await service.receive(signed(a, 202, 102));
  expect(first.conversationId).not.toBe(other.conversationId);
  expect(first.conversationId).not.toBe(reopened.conversationId);
  expect((await db.transact(a.org, tx => tx.query('SELECT id FROM messaging_contacts'))).rowCount).toBe(1);
});
it.each(['credential', 'destination', 'owner', 'suspended', 'disabled'])('rejects ingress after %s context changes', async change => {
  const t = await fixture(), service = await receiver();
  if (change === 'credential') await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1', [t.org]);
  if (change === 'destination') await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1", [t.org]);
  if (change === 'owner') await db.database.pool.query("INSERT INTO attendance_owners(organization_id,channel_id,executor,revision) VALUES($1,$2,'NONE',1)", [t.org,t.channel]);
  if (change === 'suspended') await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [t.org]);
  if (change === 'disabled') await db.database.pool.query("UPDATE chatwoot_connections SET status='DISABLED' WHERE id=$1", [t.integration]);
  await expect(service.receive(signed(t))).rejects.toThrow();
  expect((await db.database.pool.query('SELECT id FROM central_runtime_events WHERE organization_id=$1', [t.org])).rowCount).toBe(0);
});
it('ignores private input and rejects invalid signatures before storing customer content', async () => {
  const t = await fixture(), service = await receiver();
  expect(await service.receive(signed(t, 201, 101, { private: true }))).toMatchObject({ disposition: 'IGNORED' });
  await expect(service.receive({ ...signed(t), signature: 'sha256=' + '0'.repeat(64) })).rejects.toThrow('CENTRAL_SIGNATURE_INVALID');
  expect((await db.transact(t.org, tx => tx.query('SELECT id FROM messaging_messages'))).rowCount).toBe(0);
});
it('routes validated fresh input through the canonical router in the SAME transaction and rolls back together', async () => {
  const router = createEventRouter({ transact: db.transact, enabled: true });
  expect(typeof router.routeWithinTransaction).toBe('function');
  const t = await fixture();
  const automation = createAutomationService({ transact: db.transact, enabled: true });
  const graph = { nodes: [{ id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{} },{ id:'end',type:'end',label:'End',position:{x:1,y:0},data:{} }], edges:[{id:'next',source:'start',target:'end',port:'next'}] };
  const draft = await automation.create(t.org, { name: 'Synthetic flow', graph });
  await automation.publish(t.org, draft.id, 1);
  await db.transact(t.org, tx => transitionChannelOwner(tx, t.org, {channelId:t.channel, botPublicId:draft.id,botOriginReference:AUTOMATION_ORIGIN,version:1}));
  await expect(db.transact(t.org, async tx => {
    await router.routeWithinTransaction(tx, t.org, { channelId: t.channel, eventKey: 'rolled-back', text: 'Synthetic' });
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect((await db.transact(t.org, tx => tx.query("SELECT id FROM automation_events WHERE event_key='rolled-back'"))).rowCount).toBe(0);
});
