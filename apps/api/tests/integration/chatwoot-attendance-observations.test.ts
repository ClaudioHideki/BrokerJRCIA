import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { recordChatwootAttendanceEvent, beginChatwootMirrorAttempt, confirmChatwootMirrorAttempt,failChatwootMirrorAttempt,
  initializeChatwootAttendanceMap } from '../../src/modules/integrations/chatwoot-attendance-store.js';
import { readChatwootAttendanceGate } from '../../src/modules/attendance/control-service.js';
import { createChatwootService,chatwootEnvironment,type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';

describe('durable Chatwoot attendance observations', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => {db = await attendanceDatabase();}, 60000);
  afterAll(async () => { await db?.dispose(); });
  async function fixture() {
    const t = await seedAttendanceTenant(db.database);
    await db.database.pool.query(`insert into attendance_owners(organization_id,channel_id,integration_id,executor,revision,automation_id,version)
      values($1,$2,$3,'BROKER',1,$4,1)`, [t.org,t.channel,t.integration,t.automation]);
    await db.database.pool.query(`insert into attendance_sessions(organization_id,channel_id,conversation_id,integration_id,destination_revision,account_id,inbox_id,cycle,state,owner_revision)
      values($1,$2,$3,$4,1,7,9,1,'BOT_ACTIVE',1)`, [t.org,t.channel,t.conversation,t.integration]);
    const scope = {...t.scope, credentialRevision:1};
    const record = (raw:unknown) => db.transact(t.org, tx => recordChatwootAttendanceEvent(tx, scope, raw));
    const gate = () => db.transact(t.org, tx => readChatwootAttendanceGate(tx, {organizationId:t.org,channelId:t.channel,conversationId:t.conversation}));
    const map = (status='pending', actor:unknown=null) => db.transact(t.org, tx => initializeChatwootAttendanceMap(tx, scope,
      {conversationId:t.conversation,remoteConversationId:51,canonical:{id:51,account_id:7,inbox_id:9,status,updated_at:100,meta:{assignee:actor,assignee_type:actor?'User':null,team:null}}}));
    const message = (patch:Record<string,unknown>={}) => ({event:'message_created',id:61,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},message_type:'outgoing',private:false,sender:{id:12,type:'user'},content:'Synthetic public response',...patch});
    return {...t,scope,record,gate,map,message};
  }
  async function transport(t:Awaited<ReturnType<typeof fixture>>,fetch?:typeof globalThis.fetch){
    const options:ChatwootOptions={baseUrl:`https://${t.org}.example.test`,publicOrigin:'https://broker.example.test',
      encryptionKey:Buffer.alloc(32,6).toString('base64'),transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined,...(fetch?{fetch}:{})};
    const secret='synthetic-callback-secret',vault=chatwootEnvironment(options).vault;
    await db.database.pool.query('update chatwoot_accounts set encrypted_token=$2 where organization_id=$1',[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic-token')]);
    await db.database.pool.query('update chatwoot_connections set encrypted_webhook_secret=$2 where id=$1',[t.integration,vault.encrypt(`${t.org}:chatwoot-webhook:${t.integration}`,secret)]);
    const service=createChatwootService(options);
    return {options,service,ingest:(value:unknown)=>{const raw=Buffer.from(JSON.stringify(value)),timestamp=String(Math.floor(Date.now()/1000));
      return service.ingest(t.integration,raw,timestamp,'sha256='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex'));}};
  }
  it('retains early human control before the map and consumes it before allowing the bot',async()=>{
    const t=await fixture();
    expect(await t.record(t.message())).toMatchObject({disposition:'WAITING_MAP',duplicate:false});
    await t.map();
    expect(await t.gate()).toMatchObject({allowed:false,state:'HUMAN'});
    const state=(await db.database.pool.query('select state,revision from attendance_sessions where organization_id=$1',[t.org])).rows[0];
    expect(state).toMatchObject({state:'HUMAN_ACTIVE',revision:2});
    expect((await db.database.pool.query('select revision from attendance_owners where organization_id=$1',[t.org])).rows[0].revision).toBe(1);
  });
  it('pauses on a private note, never persists its body or creates a transport job, and deduplicates control',async()=>{
    const t=await fixture(); await t.map();
    const raw=t.message({private:true,content:'PRIVATE BODY MUST NEVER PERSIST'});
    expect(await t.record(raw)).toMatchObject({disposition:'APPLIED'});
    const before=await t.gate();
    expect(await t.record(raw)).toMatchObject({duplicate:true});
    expect(await t.gate()).toEqual(before);
    const rows=(await db.database.pool.query('select * from chatwoot_attendance_observations where organization_id=$1',[t.org])).rows;
    expect(JSON.stringify(rows)).not.toContain('PRIVATE BODY');
    expect((await db.database.pool.query("select id from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(0);
  });
  it('does not turn a callback received during a mirror POST into human control',async()=>{
    const t=await fixture(); await t.map();
    const messageId=randomUUID(),jobId=randomUUID(),leaseToken=randomUUID();
    await db.database.pool.query(`insert into messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
      values($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic"}','SENT',$1::text,$5)`,[messageId,t.org,t.channel,t.conversation,'a'.repeat(64)]);
    await db.database.pool.query(`insert into integration_jobs(id,organization_id,integration_id,kind,dedupe_key,message_id,status,lease_token,lease_expires_at)
      values($1::uuid,$2,$3,'MIRROR_MESSAGE',$1::text,$4,'RUNNING',$5,now()+interval '3 minutes')`,[jobId,t.org,t.integration,messageId,leaseToken]);
    const attempt=await db.transact(t.org, tx=>beginChatwootMirrorAttempt(tx,t.scope,{jobId,leaseToken,messageId,conversationId:t.conversation,remoteConversationId:51}));
    expect(await t.record(t.message({content_attributes:{jrc_broker_message_id:messageId}}))).toMatchObject({disposition:'ECHO_PENDING'});
    expect(await t.gate()).toMatchObject({allowed:false,state:'READY'});
    expect((await db.database.pool.query('select mode from messaging_conversations where id=$1',[t.conversation])).rows[0].mode).toBe('BOT');
    await db.transact(t.org, tx=>confirmChatwootMirrorAttempt(tx,t.scope,{attemptId:attempt.id,remoteMessageId:61}));
    expect(await t.gate()).toMatchObject({allowed:true,state:'READY'});
    expect((await db.database.pool.query('select state from attendance_sessions where organization_id=$1',[t.org])).rows[0].state).toBe('BOT_ACTIVE');
    expect((await db.database.pool.query("select id from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(0);
  });
  it('does not accept a claimed marker without a matching dispatched mirror attempt',async()=>{
    const t=await fixture(); await t.map();
    await t.record(t.message({content_attributes:{jrc_broker_message_id:randomUUID()}}));
    expect(await t.gate()).toMatchObject({allowed:false,state:'HUMAN'});
  });
  it('does not resume on delayed pending events after human control',async()=>{
    const t=await fixture(); await t.map(); await t.record(t.message());
    await t.record({event:'conversation_status_changed',id:51,account:{id:7},inbox_id:9,status:'pending',updated_at:1,meta:{assignee:null,assignee_type:null,team:null}});
    expect(await t.gate()).toMatchObject({allowed:false,state:'HUMAN'});
  });
  it('preserves an existing human conversation returned by create instead of forcing pending',async()=>{
    const t=await fixture(); await t.map('open',{id:12,type:'user'});
    expect(await t.gate()).toMatchObject({allowed:false,state:'HUMAN'});
  });
  it('rejects wrong scopes and isolates durable observations between tenants',async()=>{
    const a=await fixture(),b=await fixture();
    await a.record(a.message());
    expect((await db.transact(b.org,tx=>tx.query('select id from chatwoot_attendance_observations'))).rows).toEqual([]);
    await expect(a.record(a.message({inbox:{id:10}}))).rejects.toThrow('CHATWOOT_BINDING_MISMATCH');
    await expect(db.transact(a.org,tx=>recordChatwootAttendanceEvent(tx,{...a.scope,destinationRevision:2},a.message()))).rejects.toMatchObject({code:'CHATWOOT_CONTEXT_CHANGED'});
  });
  it('closes the gate when destination authorization is revoked without changing its scope',async()=>{
    const t=await fixture();await t.map();
    expect(await t.gate()).toMatchObject({allowed:true});
    await db.database.pool.query("update chatwoot_destinations set approval_status='REVOKED' where organization_id=$1",[t.org]);
    expect(await t.gate()).toMatchObject({allowed:false});
  });
  it('does not lose a reused message ID after changing the destination revision',async()=>{
    const t=await fixture();await t.record(t.message());
    await db.database.pool.query('update chatwoot_destinations set revision=2 where organization_id=$1',[t.org]);
    await db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,{...t.scope,destinationRevision:2},t.message()));
    expect((await db.database.pool.query("select id from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(2);
  });
  it('authenticates and applies conversation and private control before the reply worker runs',async()=>{
    const t=await fixture(); await t.map(); const api=await transport(t);
    await api.ingest(t.message({private:true,content:'PRIVATE CALLBACK'}));
    expect(await t.gate()).toMatchObject({allowed:false,state:'HUMAN'});
    await api.ingest({event:'conversation_status_changed',id:51,account:{id:7},inbox_id:9,status:'pending',updated_at:2,meta:{assignee:null,assignee_type:null,team:null}});
    expect((await db.database.pool.query('select id from chatwoot_attendance_observations where organization_id=$1',[t.org])).rowCount).toBe(2);
    expect((await db.database.pool.query("select id from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(0);
  });
  it('still observes human control when reply content cannot be transported',async()=>{
    const t=await fixture(); await t.map(); await t.record(t.message({content:null}));
    expect(await t.gate()).toMatchObject({state:'HUMAN',allowed:false});
  });
  it.each(['confirmed','unknown','unknown-without-callback','confirmed-context-change','unknown-context-change'] as const)('mirrors Broker v2 with a %s POST outcome',async outcome=>{
    const t=await fixture();
    let callback!: (raw:unknown)=>Promise<unknown>; const calls:{path:string;body:Record<string,unknown>}[]=[];
    const api=await transport(t,async(input,init)=>{
      const path=new URL(String(input)).pathname,body=typeof init?.body==='string'?JSON.parse(init.body):{};calls.push({path,body});
      let response:unknown;
      if(path.endsWith('/inboxes/9'))response={id:9,name:'Synthetic',channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:false};
      else if(path.endsWith('/agent_bot'))response={agent_bot:null};
      else if(path.endsWith('/contacts/search'))response={payload:[{id:41,phone_number:'synthetic'}]};
      else if(path.endsWith('/contacts'))response={payload:{contact:{id:41}}};
      else if(path.endsWith('/contact_inboxes'))response={source_id:'synthetic-source'};
      else if(path.endsWith('/conversations'))response={id:51};
      else if(path.endsWith('/conversations/51'))response={id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100,meta:{sender:{id:41},assignee:null,assignee_type:null,team:null}};
      else if(path.endsWith('/messages')){
        if(outcome!=='unknown-without-callback')await callback(t.message({content_attributes:body.content_attributes}));
        if(outcome.endsWith('context-change'))await db.database.pool.query('update chatwoot_accounts set credential_version=2 where organization_id=$1',[t.org]);
        if(!outcome.startsWith('confirmed'))throw new Error('Synthetic timeout after remote write');response={id:61};
      }
      else if(path.endsWith('/messages/61'))response={}; else throw new Error('Unexpected local fixture '+path);
      return new Response(JSON.stringify(response));
    });callback=api.ingest;
    const messageId=randomUUID();
    await db.database.pool.query(`insert into messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
      values($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic"}','SENT',$1::text,$5)`,[messageId,t.org,t.channel,t.conversation,'a'.repeat(64)]);
    await createChatwootWorker(api.options).runOnce(t.org);
    expect(calls.find(call=>call.path.endsWith('/conversations'))?.body.status).toBe('pending');
    expect((await api.service.jobs(t.org)).data).toHaveLength(1);
    if(outcome!=='confirmed'){
      expect((await api.service.jobs(t.org)).data[0]).toMatchObject({status:'UNKNOWN'});
      expect(await t.gate()).toMatchObject({allowed:false,state:'READY'});
      expect((await db.database.pool.query('select state from chatwoot_mirror_attempts where organization_id=$1',[t.org])).rows[0].state).toBe(outcome.endsWith('context-change')?'DISPATCHED':'UNKNOWN');
      await createChatwootWorker(api.options).runOnce(t.org);
      expect(calls.filter(call=>call.path.endsWith('/messages'))).toHaveLength(1);
      await expect(api.service.reconcileJob(t.org,(await api.service.jobs(t.org)).data[0]!.id,'Synthetic review',61))
        .rejects.toMatchObject({code:'CHATWOOT_MIRROR_EVIDENCE_REQUIRED'});
      return;
    }
    expect((await api.service.jobs(t.org)).data[0]).toMatchObject({status:'SUCCEEDED'});
    expect(await t.gate()).toMatchObject({allowed:true,state:'READY'});
    expect((await db.database.pool.query('select event from chatwoot_attendance_observations where organization_id=$1',[t.org])).rows[0].event.kind).toBe('BROKER_ECHO');
  });
  it('does not forward another executor while Broker owns the conversation or call it human',async()=>{
    const t=await fixture(); await t.map();
    await t.record(t.message({sender:{id:30,type:'agent_bot'}}));
    expect(await t.gate()).toMatchObject({state:'PAUSED',allowed:false});
    expect((await db.database.pool.query('select state from attendance_sessions where organization_id=$1',[t.org])).rows[0].state).toBe('ADMIN_PAUSED');
    expect((await db.database.pool.query("select id from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(0);
  });
  it('also closes the gate after existing local human control or a new cycle',async()=>{
    const t=await fixture(); await t.map();
    await db.database.pool.query("update messaging_conversations set mode='HUMAN' where id=$1",[t.conversation]);
    expect(await t.gate()).toMatchObject({allowed:false});
    await db.database.pool.query("update messaging_conversations set mode='BOT' where id=$1",[t.conversation]);
    await db.database.pool.query("update attendance_sessions set state='RESOLVED' where organization_id=$1",[t.org]);
    await db.database.pool.query(`insert into attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision)
      values($1,$2,$3,2,'BOT_ACTIVE',1)`,[t.org,t.channel,t.conversation]);
    expect(await t.gate()).toMatchObject({allowed:false});
  });
  it('forwards the selected external executor without changing it into a human session',async()=>{
    const t=await fixture();await t.map();
    await db.database.pool.query("update attendance_owners set executor='EXTERNAL',automation_id=null,version=null where organization_id=$1",[t.org]);
    await t.record(t.message({sender:{id:30,type:'agent_bot'}}));
    expect((await db.database.pool.query("select id from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(1);
    expect((await db.database.pool.query('select mode from messaging_conversations where id=$1',[t.conversation])).rows[0].mode).toBe('BOT');
    expect((await db.database.pool.query('select state from attendance_sessions where organization_id=$1',[t.org])).rows[0].state).toBe('BOT_ACTIVE');
  });
  it.each(['human-before-confirm','wrong-response-id','rejected'] as const)('never clears human control for mirror %s',async outcome=>{
    const t=await fixture();await t.map();
    const messageId=randomUUID(),jobId=randomUUID(),leaseToken=randomUUID();
    await db.database.pool.query(`insert into messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
      values($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic"}','SENT',$1::text,$5)`,[messageId,t.org,t.channel,t.conversation,'a'.repeat(64)]);
    await db.database.pool.query(`insert into integration_jobs(id,organization_id,integration_id,kind,dedupe_key,message_id,status,lease_token,lease_expires_at)
      values($1::uuid,$2,$3,'MIRROR_MESSAGE',$1::text,$4,'RUNNING',$5,now()+interval '3 minutes')`,[jobId,t.org,t.integration,messageId,leaseToken]);
    const attempt=await db.transact(t.org,tx=>beginChatwootMirrorAttempt(tx,t.scope,{jobId,leaseToken,messageId,conversationId:t.conversation,remoteConversationId:51}));
    await t.record(t.message({content_attributes:{jrc_broker_message_id:messageId}}));
    if(outcome==='human-before-confirm')await t.record(t.message({id:62,private:true,content:'NEVER PERSIST'}));
    if(outcome==='rejected')await db.transact(t.org,tx=>failChatwootMirrorAttempt(tx,t.scope,{attemptId:attempt.id,uncertain:false}));
    else await db.transact(t.org,tx=>confirmChatwootMirrorAttempt(tx,t.scope,{attemptId:attempt.id,remoteMessageId:outcome==='wrong-response-id'?99:61}));
    expect(await t.gate()).toMatchObject({allowed:false,state:'HUMAN'});
    expect((await db.database.pool.query('select state from attendance_sessions where organization_id=$1',[t.org])).rows[0].state).toBe('HUMAN_ACTIVE');
  });
  it('cancels only unsent effects in the controlled conversation and preserves in-flight uncertainty',async()=>{
    const t=await fixture();await t.map();
    const otherConversation=randomUUID();
    const contact=(await db.database.pool.query("insert into messaging_contacts(organization_id,external_id) values($1,'other-synthetic') returning id",[t.org])).rows[0].id;
    await db.database.pool.query('insert into messaging_conversations(id,organization_id,channel_id,contact_id) values($1,$2,$3,$4)',[otherConversation,t.org,t.channel,contact]);
    const ids:Record<string,string>={};
    for(const state of ['ACCEPTED','SENDING','UNKNOWN','OTHER'] as const){
      const id=randomUUID();ids[state]=id;
      await db.database.pool.query(`insert into messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
        values($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic"}',$5,$1::text,$6)`,[id,t.org,t.channel,state==='OTHER'?otherConversation:t.conversation,state==='OTHER'?'ACCEPTED':state,'a'.repeat(64)]);
      await db.database.pool.query('insert into messaging_outbox(organization_id,message_id) values($1,$2)',[t.org,id]);
    }
    const binding=(await db.database.pool.query('insert into automation_bindings(organization_id,automation_id,version,channel_id) values($1,$2,1,$3) returning id',[t.org,t.automation,t.channel])).rows[0].id;
    const execution=(await db.database.pool.query(`insert into automation_executions(organization_id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status)
      values($1,$2,1,$3,$4,$5,'synthetic',$6,'WAITING') returning id`,[t.org,t.automation,binding,t.channel,t.conversation,randomUUID()])).rows[0].id;
    await db.database.pool.query("insert into automation_outbox(organization_id,execution_id,node_id,ordinal,kind,status) values($1,$2,'p',0,'SEND_TEXT','PENDING'),($1,$2,'s',1,'SEND_TEXT','SENDING'),($1,$2,'u',2,'SEND_TEXT','UNKNOWN')",[t.org,execution]);
    await t.record(t.message({private:true}));
    const messages=(await db.database.pool.query('select id,state from messaging_messages where organization_id=$1',[t.org])).rows;
    expect(Object.fromEntries(messages.map(row=>[Object.keys(ids).find(key=>ids[key]===row.id),row.state]))).toEqual({ACCEPTED:'FAILED',SENDING:'SENDING',UNKNOWN:'UNKNOWN',OTHER:'ACCEPTED'});
    expect((await db.database.pool.query('select message_id from messaging_outbox where organization_id=$1',[t.org])).rows.map(row=>row.message_id).sort()).toEqual([ids.SENDING,ids.UNKNOWN,ids.OTHER].sort());
    expect((await db.database.pool.query('select status from automation_outbox where organization_id=$1 order by ordinal',[t.org])).rows.map(row=>row.status)).toEqual(['CANCELED','SENDING','UNKNOWN']);
    expect((await db.database.pool.query('select mode from messaging_conversations where id=$1',[otherConversation])).rows[0].mode).toBe('BOT');
  });
});
