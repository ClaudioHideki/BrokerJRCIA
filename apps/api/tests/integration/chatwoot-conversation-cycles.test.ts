import {createHmac,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createChatwootService,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {readChatwootAttendanceGate} from '../../src/modules/attendance/control-service.js';
import {captureResume} from '../../src/modules/attendance/resume-repository.js';
import {captureTakeover} from '../../src/modules/integrations/nico-takeover-store.js';
import type {ChatwootControlPrincipal} from '../../src/modules/integrations/chatwoot-control-auth.js';

describe('immutable physical Chatwoot conversation cycles',()=>{
 let db:Awaited<ReturnType<typeof attendanceDatabase>>;
 beforeAll(async()=>{db=await attendanceDatabase();},60000);
 afterAll(async()=>{await db?.dispose();});
 async function fixture(){
  const t=await seedAttendanceTenant(db.database,false),calls:{path:string;method:string}[]=[];
  const contact=(await db.database.pool.query<{contact_id:string}>('SELECT contact_id FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0]!.contact_id;
  await db.database.pool.query("UPDATE messaging_contacts SET external_id='15550000001' WHERE id=$1",[contact]);
  const secret='synthetic-cycle-webhook',origin=`https://${t.org}.example.test`;
  const options:ChatwootOptions={baseUrl:origin,publicOrigin:'https://broker.example.test',encryptionKey:Buffer.alloc(32,7).toString('base64'),transact:db.transact,
   resolveIntegration:async id=>(await db.database.pool.query<{organization_id:string}>('SELECT organization_id FROM chatwoot_connections WHERE id=$1',[id])).rows[0]?.organization_id,
   fetch:async(input,init)=>{
    const path=new URL(String(input)).pathname,method=init?.method??'GET';calls.push({path,method});let value:unknown;
    if(path==='/api/v1/profile')value={accounts:[{id:7,role:'administrator'}]};
    else if(path.endsWith('/inboxes')&&method==='POST')value={id:9,name:'Synthetic',channel_type:'Channel::Api',secret,webhook_url:JSON.parse(String(init?.body)).channel.webhook_url};
    else if(/\/conversations\/(51|52)$/.test(path))value={id:Number(path.split('/').at(-1)),account_id:7,inbox_id:9,status:'open',updated_at:100,meta:{sender:{id:41,name:'Synthetic',phone_number:'+15550000001'},assignee:{id:81,type:'user'},assignee_type:'User',team:null}};
    else if(path.endsWith('/contacts/41'))value={payload:{id:41,phone_number:'+15550000001',contact_inboxes:[{inbox:{id:9},source_id:'cycle-source'}]}};
    else if(method==='PATCH')value={};
    else throw new Error('Unexpected synthetic request '+path);
    return Response.json(value);
   }};
  const service=createChatwootService(options);await service.bindAccount(t.org,{accountId:7,token:'synthetic-only'});
  const integration=(await service.connect(t.org,{channelId:t.channel,name:'Synthetic'})).connections[0]!.id;
  await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
   VALUES($1,$2,$3,41,'cycle-source',51)`,[t.org,integration,t.conversation]);
  const event=async(id=71,remote=52,patch:Record<string,unknown>={})=>{
   const raw=Buffer.from(JSON.stringify({event:'message_created',id,account:{id:7},inbox:{id:9},conversation:{id:remote,inbox_id:9},message_type:'outgoing',private:false,sender:{id:81,type:'user'},content:'Synthetic approved reply',...patch}));
   const timestamp=String(Math.floor(Date.now()/1000)),signature='sha256='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex');
   await service.ingest(integration,raw,timestamp,signature);
  };
  const maps=async()=>(await db.database.pool.query<{conversation_id:string;remote_conversation_id:string}>(`SELECT conversation_id,remote_conversation_id FROM chatwoot_conversations WHERE organization_id=$1 ORDER BY remote_conversation_id`,[t.org])).rows;
  const current=()=>db.transact(t.org,tx=>createPostgresMessagingRepository().getOrCreateConversation(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,contactId:contact}));
  return {...t,contact,integration,options,service,event,maps,current,calls,origin};
 }
 it('creates a separate human cycle for a new remote conversation and preserves the old immutable mapping',async()=>{
  const t=await fixture();await t.event();await createChatwootWorker(t.options).runOnce(t.org);
  expect((await t.service.jobs(t.org)).data[0]?.lastError).toBeNull();
  const maps=await t.maps();expect(maps).toHaveLength(2);
  expect(maps[0]).toEqual({conversation_id:t.conversation,remote_conversation_id:'51'});
  const next=maps[1]!.conversation_id;expect(next).not.toBe(t.conversation);
  expect(await t.current()).toMatchObject({id:next,mode:'HUMAN'});
  expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
  const reply=(await db.database.pool.query('SELECT conversation_id,state FROM messaging_messages WHERE organization_id=$1',[t.org])).rows;
  expect(reply).toEqual([{conversation_id:next,state:'ACCEPTED'}]);
  await t.event();await createChatwootWorker(t.options).runOnce(t.org);
  expect(await t.maps()).toEqual(maps);expect((await db.database.pool.query('SELECT id FROM messaging_messages WHERE organization_id=$1',[t.org])).rows).toHaveLength(1);
 });
 it('keeps a new reply pending while an old physical send is uncertain, committing the human pause',async()=>{
  const t=await fixture();
  await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,state,content)
   VALUES($1,$2,$3,'OUTGOING','OPERATOR','UNKNOWN','{"type":"TEXT","text":"Synthetic previous send"}')`,[t.org,t.channel,t.conversation]);
  await t.event();const worker=createChatwootWorker(t.options);await worker.runOnce(t.org);await worker.runOnce(t.org);
  expect(await t.maps()).toHaveLength(1);
  expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
  expect((await t.service.jobs(t.org)).data).toEqual(expect.arrayContaining([expect.objectContaining({status:'PENDING',lastError:'CHATWOOT_CYCLE_WAITING_PREVIOUS_SEND'})]));
 });
 it('does not allow a retired physical cycle to regain automatic authority',async()=>{
  const t=await fixture();
  await db.database.pool.query('UPDATE messaging_conversations SET remote_conversation_key=$2 WHERE id=$1',[t.conversation,`chatwoot-cycle:${t.integration}:51`]);
  const gate=await db.transact(t.org,tx=>readChatwootAttendanceGate(tx,{organizationId:t.org,channelId:t.channel,conversationId:t.conversation}));
  expect(gate.allowed).toBe(false);
 });
 it('rejects resume and a fresh NICO snapshot for a retired physical cycle',async()=>{
  const t=await fixture();await t.event();await createChatwootWorker(t.options).runOnce(t.org);
  await expect(db.transact(t.org,tx=>captureResume(tx,t.org,{conversationId:t.conversation,expectedControlRevision:0,expectedOwnerRevision:0,target:{kind:'NEW_SESSION'}})))
   .rejects.toThrow('ATTENDANCE_CONVERSATION_SUPERSEDED');
  const principal={organizationId:t.org,accountId:7,destinationRevision:1,chatwootOrigin:t.origin} as ChatwootControlPrincipal;
  await expect(db.transact(t.org,tx=>captureTakeover(tx,principal,t.integration,51))).rejects.toThrow('NICO_TAKEOVER_CONVERSATION_SUPERSEDED');
 });
 it('does not switch back on a historical human reply and pauses the current cycle',async()=>{
  const t=await fixture(),worker=createChatwootWorker(t.options);await t.event();await worker.runOnce(t.org);
  const next=(await t.current()).id;await db.database.pool.query("UPDATE messaging_conversations SET mode='BOT' WHERE id=$1",[next]);
  await t.event(72,51);await worker.runOnce(t.org);await worker.runOnce(t.org);
  expect(await t.current()).toMatchObject({id:next,mode:'HUMAN'});
  // The human reply is mapped through its message row, and remains correlated to the old central conversation.
  const reply=(await db.database.pool.query(`SELECT m.conversation_id FROM chatwoot_messages c JOIN messaging_messages m
   ON m.organization_id=c.organization_id AND m.id=c.message_id WHERE c.organization_id=$1 AND c.remote_message_id=72`,[t.org])).rows;
  expect(reply).toEqual([{conversation_id:t.conversation}]);
 });
 it('blocks a plain Broker operator send in a retired cycle and preserves the active route',async()=>{
  const t=await fixture();await t.event();await createChatwootWorker(t.options).runOnce(t.org);
  await expect(db.transact(t.org,tx=>createPostgresMessagingRepository().enqueueOutgoing(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,
   conversationId:t.conversation,source:'OPERATOR',content:{type:'TEXT',text:'Synthetic stale UI'},idempotencyKey:'old-cycle-send',bodyHash:'a'.repeat(64),policy:{requireOptIn:false}})))
   .rejects.toThrow('CONVERSATION_SUPERSEDED');
 });
 it('resumes a waiting cycle once the old send settles, without replaying the old send',async()=>{
  const t=await fixture();
  const old=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,state,content)
   VALUES($1,$2,$3,'OUTGOING','OPERATOR','UNKNOWN','{"type":"TEXT","text":"Synthetic previous send"}') RETURNING id`,[t.org,t.channel,t.conversation])).rows[0].id;
  await t.event();let worker=createChatwootWorker(t.options);await worker.runOnce(t.org);await worker.runOnce(t.org);
  expect(await t.maps()).toHaveLength(1);
  await db.database.pool.query("UPDATE messaging_messages SET state='SENT' WHERE id=$1",[old]);
  await db.database.pool.query("UPDATE integration_jobs SET available_at=now() WHERE organization_id=$1 AND status='PENDING'",[t.org]);
  worker=createChatwootWorker(t.options);await worker.runOnce(t.org);
  expect(await t.maps()).toHaveLength(2);
  expect((await db.database.pool.query('SELECT state,conversation_id FROM messaging_messages WHERE id=$1',[old])).rows[0])
   .toEqual({state:'SENT',conversation_id:t.conversation});
  expect(t.calls.filter(c=>c.method==='POST'&&c.path.includes('/messages'))).toHaveLength(0);
 });
 it('blocks current-cycle authority and resume while a historical human reply is pending',async()=>{
  const t=await fixture(),worker=createChatwootWorker(t.options);await t.event();await worker.runOnce(t.org);
  const next=(await t.current()).id;await db.database.pool.query("UPDATE messaging_conversations SET mode='BOT' WHERE id=$1",[next]);
  await t.event(72,51);
  expect(await t.current()).toMatchObject({id:next,mode:'HUMAN'});
  const gate=await db.transact(t.org,tx=>readChatwootAttendanceGate(tx,{organizationId:t.org,channelId:t.channel,conversationId:next}));
  expect(gate.allowed).toBe(false);
  await expect(db.transact(t.org,tx=>captureResume(tx,t.org,{conversationId:next,expectedControlRevision:0,expectedOwnerRevision:0,target:{kind:'NEW_SESSION'}})))
   .rejects.toThrow('ATTENDANCE_PREVIOUS_CYCLE_SEND_PENDING');
 });
 it('does not send a historical private note to WhatsApp but immediately preserves human control',async()=>{
  const t=await fixture(),worker=createChatwootWorker(t.options);await t.event();await worker.runOnce(t.org);
  const next=(await t.current()).id;await db.database.pool.query("UPDATE messaging_conversations SET mode='BOT' WHERE id=$1",[next]);
  const jobsBefore=(await t.service.jobs(t.org)).data.length;
  await t.event(73,51,{private:true});
  expect(await t.current()).toMatchObject({id:next,mode:'HUMAN'});
  expect((await t.service.jobs(t.org)).data).toHaveLength(jobsBefore);
 });
 it('keeps a dispatched handoff requiring reconciliation from being superseded',async()=>{
  const t=await fixture();
  const binding=randomUUID(),execution=randomUUID(),outbox=randomUUID();
  await db.database.pool.query('INSERT INTO automation_bindings(organization_id,id,channel_id,automation_id,version) VALUES($1,$2,$3,$4,1)',[t.org,binding,t.channel,t.automation]);
  await db.database.pool.query(`INSERT INTO automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id)
   VALUES($1,$2,$3,1,$4,$5,$6,'synthetic',$7)`,[t.org,execution,t.automation,binding,t.channel,t.conversation,randomUUID()]);
  await db.database.pool.query(`INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,status)
   VALUES($1,$2,$3,'synthetic',0,'HANDOFF','UNKNOWN')`,[t.org,outbox,execution]);
  await db.database.pool.query(`INSERT INTO attendance_handoff_operations(organization_id,outbox_id,execution_id,channel_id,conversation_id,integration_id,lease_token,snapshot,phase,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ASSIGNMENT_DISPATCHED','ACTION_REQUIRED')`,
   [t.org,outbox,execution,t.channel,t.conversation,t.integration,randomUUID(),JSON.stringify({scope:{...t.scope,integrationId:t.integration}})]);
  await t.event();await createChatwootWorker(t.options).runOnce(t.org);
  expect(await t.maps()).toHaveLength(1);
  expect((await t.service.jobs(t.org)).data).toEqual(expect.arrayContaining([expect.objectContaining({status:'PENDING',lastError:'CHATWOOT_CYCLE_WAITING_PREVIOUS_CONTROL'})]));
 });
 it('rejects a stale UI send that waited while the central conversation was superseded',async()=>{
  const t=await fixture();
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const attempt=db.transact(t.org,async tx=>{
   const query=tx.query.bind(tx);
   tx.query=(async(sql:string,values?:unknown[])=>{
    if(sql.includes('FOR UPDATE OF conversation, contact')){entered();await released;}
    return query(sql,values);
   }) as typeof tx.query;
   return createPostgresMessagingRepository().enqueueOutgoing(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,
    conversationId:t.conversation,source:'OPERATOR',content:{type:'TEXT',text:'Synthetic stale send'},idempotencyKey:'racing-old-cycle',bodyHash:'b'.repeat(64),policy:{requireOptIn:false}});
  }).then(()=>null,error=>error);
  try{await ready;await t.event();await createChatwootWorker(t.options).runOnce(t.org);}finally{release();}
  expect(await attempt).toMatchObject({code:'CONVERSATION_SUPERSEDED'});
  expect((await db.database.pool.query("SELECT id FROM messaging_messages WHERE organization_id=$1 AND idempotency_key='racing-old-cycle'",[t.org])).rows).toHaveLength(0);
 });
 it.each(['new','historical'])('does not grant human cycle authority to a selected external automated reply (%s)',async route=>{
  const t=await fixture(),worker=createChatwootWorker(t.options);
  if(route==='historical'){await t.event();await worker.runOnce(t.org);}
  const current=(await t.current()).id;
  await db.database.pool.query("UPDATE messaging_conversations SET mode='BOT' WHERE id=$1",[current]);
  await db.database.pool.query(`INSERT INTO attendance_owners(organization_id,channel_id,integration_id,executor) VALUES($1,$2,$3,'EXTERNAL')
   ON CONFLICT(organization_id,channel_id) DO UPDATE SET executor='EXTERNAL',automation_id=NULL,version=NULL`,[t.org,t.channel,t.integration]);
  await t.event(74,route==='new'?52:51,{content_attributes:{automation_rule_id:123}});
  await worker.runOnce(t.org);if(route==='historical')await worker.runOnce(t.org);
  expect(await t.maps()).toHaveLength(route==='new'?1:2);
  expect(await t.current()).toMatchObject({id:current,mode:'BOT'});
  expect((await t.service.jobs(t.org)).data).toEqual(expect.arrayContaining([expect.objectContaining({status:'FAILED',lastError:route==='new'?'CHATWOOT_CYCLE_HUMAN_REQUIRED':'CONVERSATION_SUPERSEDED'})]));
 });
 it('keeps a historical delivery receipt on its original remote conversation',async()=>{
  const t=await fixture(),worker=createChatwootWorker(t.options);await t.event();await worker.runOnce(t.org);await worker.runOnce(t.org);
  const message=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,state,content)
   VALUES($1,$2,$3,'OUTGOING','OPERATOR','SENT','{"type":"TEXT","text":"Synthetic old receipt"}') RETURNING id`,[t.org,t.channel,t.conversation])).rows[0].id;
  await db.database.pool.query('INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,61)',[t.org,t.integration,message]);
  await worker.runOnce(t.org);
  expect(t.calls).toEqual(expect.arrayContaining([{path:'/api/v1/accounts/7/conversations/51/messages/61',method:'PATCH'}]));
  expect(t.calls.some(c=>c.path.includes('/conversations/52/messages/61'))).toBe(false);
 });
 it('does not pause the current cycle for a historical activity event',async()=>{
  const t=await fixture(),worker=createChatwootWorker(t.options);await t.event();await worker.runOnce(t.org);
  const next=(await t.current()).id;await db.database.pool.query("UPDATE messaging_conversations SET mode='BOT' WHERE id=$1",[next]);
  const jobsBefore=(await t.service.jobs(t.org)).data.length;
  await t.event(75,51,{message_type:'activity'});
  expect(await t.current()).toMatchObject({id:next,mode:'BOT'});
  expect((await t.service.jobs(t.org)).data).toHaveLength(jobsBefore);
 });
 it.each(['source','credential'])('does not promote after the verified %s changes',async change=>{
  const t=await fixture(),fetch=t.options.fetch!;
  t.options.fetch=async(input,init)=>{
   const response=await fetch(input,init);
   if(new URL(String(input)).pathname.endsWith('/contacts/41')){
    if(change==='credential')await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1',[t.org]);
    else return Response.json({payload:{id:41,phone_number:'+15550000001',contact_inboxes:[{inbox:{id:9},source_id:'different-source'}]}});
   }
   return response;
  };
  await t.event();await createChatwootWorker(t.options).runOnce(t.org);
  expect(await t.maps()).toEqual([{conversation_id:t.conversation,remote_conversation_id:'51'}]);
  expect((await t.service.jobs(t.org)).data).toEqual(expect.arrayContaining([expect.objectContaining({status:'FAILED',lastError:change==='credential'?'CHATWOOT_CONTEXT_CHANGED':'CHATWOOT_CYCLE_CONTACT_CHANGED'})]));
  expect((await db.database.pool.query('SELECT id FROM messaging_messages WHERE organization_id=$1',[t.org])).rows).toHaveLength(0);
 });
 it('keeps equal remote conversation and contact IDs isolated between companies',async()=>{
  const a=await fixture(),b=await fixture();await a.event();await b.event();
  await createChatwootWorker(a.options).runOnce(a.org);await createChatwootWorker(b.options).runOnce(b.org);
  const am=await a.maps(),bm=await b.maps();expect(am).toHaveLength(2);expect(bm).toHaveLength(2);
  expect(am.every(x=>bm.every(y=>y.conversation_id!==x.conversation_id))).toBe(true);
  expect(await a.current()).toMatchObject({id:am[1]!.conversation_id,mode:'HUMAN'});
  expect(await b.current()).toMatchObject({id:bm[1]!.conversation_id,mode:'HUMAN'});
 });
});
