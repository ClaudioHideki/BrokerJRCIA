import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createChannelFacade } from '../../src/modules/channels/facade.js';
import { attendanceDatabase,seedAttendanceTenant } from './helpers/attendance.js';

describe('one transactional authority for bot mutations',()=>{
  let db:Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{db=await attendanceDatabase();},60000);
  afterAll(async()=>db?.dispose());
  async function fixture(remote=false){
    const t=await seedAttendanceTenant(db.database,remote);
    await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
    const service=createAutomationService({transact:db.transact});
    return {...t,service};
  }
  it('returns a real revision and performs an exact no-op without replacing binding or conversation state',async()=>{
    const t=await fixture();
    const input={channelId:t.channel,version:1,expectedOwnerRevision:0};
    const first=await t.service.bind(t.org,t.automation,input);
    expect(first).toMatchObject({ownerRevision:1});
    await db.database.pool.query("update messaging_conversations set mode='HUMAN',typebot_session_id='preserve' where id=$1",[t.conversation]);
    const second=await t.service.bind(t.org,t.automation,{...input,expectedOwnerRevision:1});
    expect(second).toMatchObject({id:first.id,revision:first.revision,ownerRevision:1});
    expect((await db.database.pool.query('select mode,typebot_session_id from messaging_conversations where id=$1',[t.conversation])).rows)
      .toEqual([{mode:'HUMAN',typebot_session_id:'preserve'}]);
    await expect(t.service.bind(t.org,t.automation,input)).rejects.toMatchObject({code:'ATTENDANCE_OWNER_CHANGED'});
  });
  it('serializes competing native and external claims using the same expected revision',async()=>{
    const t=await fixture();const messaging=createPostgresMessagingRepository();
    const results=await Promise.allSettled([
      t.service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0}),
      db.transact(t.org,tx=>messaging.setChannelBot(tx,{organizationId:t.org,channelId:t.channel,botPublicId:'external-test',botOriginReference:'test-origin',expectedOwnerRevision:0})),
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'ATTENDANCE_OWNER_CHANGED'}});
    expect((await db.database.pool.query('select revision from attendance_owners where channel_id=$1',[t.channel])).rows).toEqual([{revision:1}]);
  });
  it('disables locally while remote destination is unavailable, preserving HUMAN and invalidating old jobs',async()=>{
    const t=await fixture(true),messaging=createPostgresMessagingRepository();
    const binding=await t.service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0});
    const message=randomUUID();
    await db.transact(t.org,tx=>messaging.recordIncoming(tx,{id:message,organizationId:t.org,channelId:t.channel,conversationId:t.conversation,webhookEventKey:message,upstreamMessageId:message,content:{type:'TEXT',text:'synthetic'}}));
    await db.database.pool.query("update messaging_conversations set mode='HUMAN' where id=$1",[t.conversation]);
    await db.database.pool.query("update chatwoot_connections set status='UNKNOWN' where id=$1",[t.integration]);
    await t.service.setBindingStatus(t.org,binding.id,{status:'DISABLED',revision:binding.revision,expectedOwnerRevision:1},t.automation);
    expect((await db.database.pool.query('select mode,bot_public_id from messaging_conversations where id=$1',[t.conversation])).rows).toEqual([{mode:'HUMAN',bot_public_id:null}]);
    expect((await db.database.pool.query('select status from messaging_bot_jobs where message_id=$1',[message])).rows).toEqual([{status:'PAUSED'}]);
    expect((await db.database.pool.query('select executor,revision from attendance_owners where channel_id=$1',[t.channel])).rows).toEqual([{executor:'NONE',revision:2}]);
  });
  it('facade replacement cannot ignore a stale owner revision from another API path',async()=>{
    const t=await fixture(),connection=randomUUID();
    await db.database.pool.query(`insert into meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,graph_version,status) values($1::uuid,$2,$3,'test',$1::text,'v23','REVOKED')`,[connection,t.org,t.channel]);
    const facade=createChannelFacade({transact:db.transact,instances:{} as never,meta:{start:async()=>{throw new Error('unused');}}});
    await t.service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0});
    await expect(facade.bindAutomation(t.org,connection,{automationId:t.automation,version:1,expectedOwnerRevision:0})).rejects.toMatchObject({code:'ATTENDANCE_OWNER_CHANGED'});
    expect(await facade.getAutomation(t.org,connection)).toMatchObject({ownerRevision:1});
  });
  it('serializes an ingress channel snapshot before conversation creation against owner replacement',async()=>{
    const t=await fixture(),repo=createPostgresMessagingRepository();
    let release!:()=>void,observed!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const snapshot=new Promise<void>(resolve=>{observed=resolve;});
    const incoming=db.transact(t.org,async tx=>{
      await repo.findChannel(tx,t.org,t.channel,{lock:true});
      observed();await barrier;
      const contact=await repo.upsertContact(tx,{id:randomUUID(),organizationId:t.org,externalId:'second',displayName:null,consentStatus:'UNKNOWN',consentUpdatedAt:null});
      return repo.getOrCreateConversation(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,contactId:contact.id});
    });
    await snapshot;
    let completed=false;
    const change=t.service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0}).then(result=>{completed=true;return result;});
    // Wait for the contender to reach the database; held SHARE must prevent its commit.
    await new Promise(resolve=>setTimeout(resolve,100));
    const changedBeforeIngress=completed;release();
    const [conversation]=await Promise.all([incoming,change]);
    expect(changedBeforeIngress).toBe(false);
    expect((await db.database.pool.query('select bot_public_id from messaging_conversations where id=$1',[conversation.id])).rows[0].bot_public_id).toBe(t.automation);
  });
  it('repairs a retained binding during NONE and preserves a human attendance session',async()=>{
    const t=await fixture();
    const binding=await t.service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0});
    await db.database.pool.query('update messaging_channels set bot_public_id=null,bot_origin_reference=null where id=$1',[t.channel]);
    await db.database.pool.query("insert into attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision) values($1,$2,$3,1,'HUMAN_ACTIVE',1)",[t.org,t.channel,t.conversation]);
    await t.service.setBindingStatus(t.org,binding.id,{status:'DISABLED',revision:binding.revision,expectedOwnerRevision:1},t.automation);
    expect((await db.database.pool.query('select status from automation_bindings where id=$1',[binding.id])).rows[0].status).toBe('DISABLED');
    expect((await db.database.pool.query('select state from attendance_sessions where channel_id=$1',[t.channel])).rows[0].state).toBe('HUMAN_ACTIVE');
  });
  it('cancels unsent legacy bot outputs and retains uncertain outputs on release',async()=>{
    const t=await fixture(),repo=createPostgresMessagingRepository();
    await db.transact(t.org,tx=>repo.setChannelBot(tx,{organizationId:t.org,channelId:t.channel,botPublicId:'legacy',botOriginReference:'test',expectedOwnerRevision:0}));
    const pending=randomUUID(),unknown=randomUUID();
    for(const [id,state] of [[pending,'ACCEPTED'],[unknown,'UNKNOWN']]){
      await db.database.pool.query(`insert into messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) values($1,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"synthetic"}',$5)`,[id,t.org,t.channel,t.conversation,state]);
      await db.database.pool.query('insert into messaging_outbox(organization_id,message_id) values($1,$2)',[t.org,id]);
    }
    await db.transact(t.org,tx=>repo.setChannelBot(tx,{organizationId:t.org,channelId:t.channel,botPublicId:null,botOriginReference:null,expectedOwnerRevision:1}));
    expect((await db.database.pool.query('select state from messaging_messages where id=$1',[pending])).rows[0].state).toBe('FAILED');
    expect((await db.database.pool.query('select state from messaging_messages where id=$1',[unknown])).rows[0].state).toBe('UNKNOWN');
    expect((await db.database.pool.query('select message_id from messaging_outbox where message_id=$1',[pending])).rowCount).toBe(0);
  });
  it('allows an admitted router to finish before replacement, including channel lifecycle triggers',async()=>{
    const t=await fixture(),repo=createPostgresMessagingRepository();
    await t.service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0});
    let replacement!:Promise<{error?:unknown}>;
    await db.transact(t.org,async tx=>{
      await tx.query("set local statement_timeout='1500ms'");
      const pid=(await tx.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid;
      const workerTx={...tx,query:async(sql:string,args?:unknown[])=>{
        const result=await tx.query(sql,args);
        if(sql.includes('from automation_bindings')&&sql.includes('for update')){
          replacement=db.transact(t.org,other=>repo.setChannelBot(other,{organizationId:t.org,channelId:t.channel,botPublicId:'external',botOriginReference:'test',expectedOwnerRevision:1})).then(()=>({}),error=>({error}));
          let blocked=false;
          for(let attempt=0;attempt<100;attempt++){
            blocked=Boolean((await db.database.pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount);
            if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
          }
          expect(blocked).toBe(true);
        }
        return result;
      }} as typeof tx;
      await t.service._repository.routeEvent(workerTx,{org:t.org,eventId:randomUUID(),executionId:randomUUID(),correlationId:randomUUID(),channelId:t.channel,conversationId:t.conversation,eventKey:'lock-order',input:{text:'synthetic'}});
    });
    expect(await replacement).toEqual({});
    expect((await db.database.pool.query('select status from automation_executions where channel_id=$1',[t.channel])).rows[0].status).toBe('CANCELED');
  });
  it('archives retained native bindings even when an old pointer is absent',async()=>{
    const t=await fixture(),binding=await t.service.bind(t.org,t.automation,{channelId:t.channel,version:1,expectedOwnerRevision:0});
    await db.database.pool.query('update messaging_channels set bot_public_id=null,bot_origin_reference=null where id=$1',[t.channel]);
    await t.service.setArchived(t.org,t.automation,true);
    expect((await db.database.pool.query('select status from automation_bindings where id=$1',[binding.id])).rows[0].status).toBe('DISABLED');
  });
});
