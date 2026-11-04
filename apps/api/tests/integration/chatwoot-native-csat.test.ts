import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {initializeChatwootAttendanceMap,recordChatwootAttendanceEvent} from '../../src/modules/integrations/chatwoot-attendance-store.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';

describe('native CSAT durable transport without attendance control',()=>{
  let db:Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{db=await attendanceDatabase();},600000);
  afterAll(async()=>{await db?.dispose();});
  async function fixture(){
    const t=await seedAttendanceTenant(db.database),scope={...t.scope,credentialRevision:1};
    await db.database.pool.query(`insert into attendance_owners(organization_id,channel_id,integration_id,executor,revision,automation_id,version)
      values($1,$2,$3,'BROKER',1,$4,1)`,[t.org,t.channel,t.integration,t.automation]);
    await db.database.pool.query(`insert into attendance_sessions(organization_id,channel_id,conversation_id,integration_id,destination_revision,account_id,inbox_id,cycle,state,owner_revision)
      values($1,$2,$3,$4,1,7,9,1,'BOT_ACTIVE',1)`,[t.org,t.channel,t.conversation,t.integration]);
    await db.database.pool.query(`insert into chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      values($1,$2,$3,41,'synthetic-csat-source',51)`,[t.org,t.integration,t.conversation]);
    await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,scope,{conversationId:t.conversation,remoteConversationId:51,
      canonical:{id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100,meta:{assignee:null,assignee_type:null,team:null}}}));
    const invitation={event:'message_created',id:61,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},
      message_type:'template',content_type:'input_csat',private:false,sender:null,
      content:'Avalie o atendimento https://example.test/survey/responses/synthetic'};
    const record=(raw:unknown=invitation)=>db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,raw));
    const attendance=async()=>({
      owner:(await db.database.pool.query('select executor,revision,automation_id,version from attendance_owners where organization_id=$1',[t.org])).rows,
      session:(await db.database.pool.query('select state,revision,cycle from attendance_sessions where organization_id=$1',[t.org])).rows,
      control:(await db.database.pool.query('select state,revision from chatwoot_attendance_controls where organization_id=$1',[t.org])).rows,
      conversation:(await db.database.pool.query('select mode,remote_conversation_key from messaging_conversations where id=$1',[t.conversation])).rows,
      events:(await db.database.pool.query('select event_key from automation_events where organization_id=$1',[t.org])).rows,
    });
    const worker=createChatwootWorker({baseUrl:`https://${t.org}.example.test`,publicOrigin:'https://broker.example.test',
      encryptionKey:Buffer.alloc(32,6).toString('base64'),transact:db.transact,
      resolveIntegration:async id=>id===t.integration?t.org:undefined,
      fetch:async()=>{throw Error('A mapped CSAT must not create or reopen a remote conversation');}});
    return {...t,scope,invitation,record,attendance,worker};
  }
  it('queues and processes exactly one native invitation while keeping all bot and human control unchanged',async()=>{
    const t=await fixture(),before=await t.attendance();
    expect(await t.record()).toMatchObject({disposition:'APPLIED',duplicate:false});
    expect(await t.record()).toMatchObject({disposition:'APPLIED',duplicate:true});
    const jobs=(await db.database.pool.query("select status,payload from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rows;
    expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({status:'PENDING',payload:{attendanceKind:'NATIVE_CSAT',messageId:61,conversationId:51}});
    await t.worker.runOnce(t.org);
    expect((await db.database.pool.query("select status,last_error from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rows).toEqual([{status:'SUCCEEDED',last_error:null}]);
    expect((await db.database.pool.query('select content,conversation_id from messaging_messages where organization_id=$1',[t.org])).rows)
      .toEqual([{content:{type:'TEXT',text:t.invitation.content},conversation_id:t.conversation}]);
    expect((await db.database.pool.query('select message_id from messaging_outbox where organization_id=$1',[t.org])).rowCount).toBe(1);
    expect(await t.attendance()).toEqual(before);
  });
  it('preserves an already resolved human session when transporting its survey invitation',async()=>{
    const t=await fixture();
    await db.database.pool.query("update attendance_sessions set state='RESOLVED' where organization_id=$1",[t.org]);
    await db.database.pool.query("update messaging_conversations set mode='HUMAN' where id=$1",[t.conversation]);
    await db.database.pool.query("update chatwoot_attendance_controls set state='HUMAN' where organization_id=$1",[t.org]);
    const before=await t.attendance();await t.record();await t.worker.runOnce(t.org);
    expect((await db.database.pool.query("select status from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rows).toEqual([{status:'SUCCEEDED'}]);
    expect(await t.attendance()).toEqual(before);
  });
  it.each(['observation','message','conversation','credential','destination'] as const)('refuses a native invitation with changed %s proof',async change=>{
    const t=await fixture();await t.record();const before=await t.attendance();
    if(change==='observation')await db.database.pool.query("update integration_jobs set payload=payload-'attendanceObservationId' where organization_id=$1",[t.org]);
    if(change==='message')await db.database.pool.query("update integration_jobs set payload=payload||'{\"messageId\":62}' where organization_id=$1",[t.org]);
    if(change==='conversation')await db.database.pool.query("update integration_jobs set payload=payload||'{\"conversationId\":52}' where organization_id=$1",[t.org]);
    if(change==='credential')await db.database.pool.query('update chatwoot_attendance_observations set credential_revision=2 where organization_id=$1',[t.org]);
    if(change==='destination')await db.database.pool.query('update chatwoot_destinations set revision=2 where organization_id=$1',[t.org]);
    await t.worker.runOnce(t.org);
    expect((await db.database.pool.query("select status from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rows).toEqual([{status:'FAILED'}]);
    expect((await db.database.pool.query('select message_id from messaging_outbox where organization_id=$1',[t.org])).rowCount).toBe(0);
    expect(await t.attendance()).toEqual(before);
  });
  it('keeps unrelated templates and survey responses out of transport',async()=>{
    const t=await fixture(),before=await t.attendance();
    for(const [index,patch] of [{content_type:'form'},{private:true},{sender:{id:12,type:'user'}},{message_type:'incoming'},
      {content_attributes:{jrc_broker_message_id:randomUUID()}},{attachments:[{id:9}]}].entries())await t.record({...t.invitation,id:100+index,...patch});
    expect((await db.database.pool.query("select id from integration_jobs where organization_id=$1 and kind='CHATWOOT_REPLY'",[t.org])).rowCount).toBe(0);
    expect(await t.attendance()).toEqual(before);
  });
  it('upgrades saved legacy reply payloads without rewriting them and rejects the previous runtime baseline',async()=>{
    const t=await fixture();
    const oldCheck=`CHECK(reply_payload IS NULL OR (event->>'mayForwardReply'='true' AND event->>'kind' IN ('HUMAN_PUBLIC','EXTERNAL_BOT','AUTOMATED_REPLY')))`;
    const migration=await readFile(new URL('../../drizzle/migrations/0084_native_csat_transport.sql',import.meta.url),'utf8');
    const savedEvent={kind:'HUMAN_PUBLIC',mayForwardReply:true,interruptsBot:true,senderId:12,remoteMessageId:61,remoteConversationId:51};
    const payload={messageId:61,conversationId:51,content:{type:'TEXT',text:'Saved legacy public reply'}};
    const admin=await db.database.pool.connect();
    try{
      await admin.query('begin');
      await admin.query('alter table chatwoot_attendance_observations drop constraint chatwoot_attendance_reply_transport_v2');
      await admin.query(`alter table chatwoot_attendance_observations add constraint chatwoot_attendance_observations_check ${oldCheck}`);
      const id=randomUUID();
      await admin.query(`insert into chatwoot_attendance_observations(organization_id,id,integration_id,channel_id,destination_revision,credential_revision,
        account_id,inbox_id,remote_conversation_id,event_key,event,disposition,reply_payload)
        values($1,$2,$3,$4,1,1,7,9,51,'message:61',$5,'WAITING_MAP',$6)`,[t.org,id,t.integration,t.channel,savedEvent,payload]);
      expect(await probeRequiredRuntimeSchema(sql=>admin.query(sql))).toBe(false);
      await admin.query(migration);
      expect((await admin.query('select event,reply_payload from chatwoot_attendance_observations where id=$1',[id])).rows)
        .toEqual([{event:savedEvent,reply_payload:payload}]);
      expect(await probeRequiredRuntimeSchema(sql=>admin.query(sql))).toBe(true);
    }finally{await admin.query('rollback');admin.release();}
  });
  it('requires complete typed CSAT proof when persisting its transport payload',async()=>{
    const t=await fixture();await t.record();
    const event={kind:'NATIVE_CSAT',mayForwardReply:true,interruptsBot:false,remoteMessageId:61,remoteConversationId:51};
    const payload={messageId:61,conversationId:51,content:{type:'TEXT',text:'Native invitation'}};
    for(const [field,value] of [['mayForwardReply',undefined],['mayForwardReply',false],['mayForwardReply','true'],
      ['interruptsBot',undefined],['interruptsBot',true],['interruptsBot','false'],['senderId',12],['senderId',null],['campaignIntentId',randomUUID()]] as const){
      await expect(db.database.pool.query('update chatwoot_attendance_observations set event=$2,reply_payload=$3 where organization_id=$1',
        [t.org,{...event,[field]:value},payload])).rejects.toMatchObject({code:'23514',constraint:'chatwoot_attendance_reply_transport_v2'});
    }
    for(const changed of [{...payload,messageId:62},{...payload,conversationId:52},{...payload,attachments:[]},
      {...payload,campaignIntentId:randomUUID()},...['',42,'x'.repeat(4097)].map(text=>({...payload,content:{type:'TEXT',text}}))]){
      await expect(db.database.pool.query('update chatwoot_attendance_observations set event=$2,reply_payload=$3 where organization_id=$1',
        [t.org,event,changed])).rejects.toMatchObject({code:'23514',constraint:'chatwoot_attendance_reply_transport_v2'});
    }
  });
});
