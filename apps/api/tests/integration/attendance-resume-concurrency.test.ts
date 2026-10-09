import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { resumeFixture } from './helpers/attendance-resume.js';
import { createAttendanceResumeWorker } from '../../src/modules/attendance/resume-worker.js';
import { readChatwootAttendanceGate } from '../../src/modules/attendance/control-service.js';
import { randomUUID } from 'node:crypto';
import { createMessagingService } from '../../src/modules/messaging/service.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { recordChatwootAttendanceEvent } from '../../src/modules/integrations/chatwoot-attendance-store.js';
import { createEventRouter } from '../../src/modules/automations/service.js';
import { createExecutionService } from '../../src/modules/automations/service.js';

describe('resume coordination across the database and central',()=>{
  let db:Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{db=await attendanceDatabase();},60000);afterAll(async()=>{await db?.dispose();});
  it('explains a queued execution with zero attempts as remote human control',async()=>{
    const t=await resumeFixture(db),id=randomUUID();
    const binding=(await db.database.pool.query('select id from automation_bindings where organization_id=$1',[t.org])).rows[0].id;
    await db.database.pool.query(`insert into automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id)
      values($1,$2,$3,1,$4,$5,$6,'synthetic-blocked',$7)`,[t.org,id,t.automation,binding,t.channel,t.conversation,randomUUID()]);
    expect(await createExecutionService({transact:db.transact}).get(t.org,id)).toMatchObject({status:'QUEUED',attendanceDiagnostic:{allowed:false,reason:'HUMAN_CONTROL'}});
  });
  it('confirms three distinct remote mutations before activating a single fresh cycle',async()=>{
    const t=await resumeFixture(db),op=await t.reserve(),w=createAttendanceResumeWorker({transact:db.transact,client:t.client});
    expect(await w.processAttendanceResume(op.id,t.org)).toMatchObject({state:'APPLIED'});
    expect(t.writes).toEqual([{assignee_id:null},{team_id:null},{status:'pending'}]);
    expect(await db.transact(t.org,tx=>readChatwootAttendanceGate(tx,{organizationId:t.org,channelId:t.channel,conversationId:t.conversation})))
      .toMatchObject({allowed:true,state:'READY',cycle:2});
    await w.processAttendanceResume(op.id,t.org);expect(t.writes).toHaveLength(3);
    expect((await db.database.pool.query('select * from attendance_sessions where organization_id=$1',[t.org])).rows).toHaveLength(1);
    expect((await db.database.pool.query('select input from automation_executions where organization_id=$1',[t.org])).rows[0].input)
      .toEqual({text:'',eventType:'RESUME'});
  });
  it.each([19,23])('resumes the native central inbox only with the persisted own AgentBot (remote %s)',async bot=>{
    const t=await resumeFixture(db,true,true);t.setBot(bot);const op=await t.reserve();
    const result=await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org);
    expect(result).toMatchObject(bot===19?{state:'APPLIED'}:{state:'ACTION_REQUIRED',errorCode:'ATTENDANCE_REMOVE_COMPETING_AGENT_BOT'});
    expect(t.writes).toHaveLength(bot===19?3:0);
  });
  it('resumes through the stock empty bot and omitted assignment serializers with real persisted authority',async()=>{
    const t=await resumeFixture(db);t.canonical.meta.team=null;
    t.setReadSerializer((path,result)=>{
      if(path.endsWith('/agent_bot'))return {};
      if(!path.endsWith('/conversations/51'))return result;
      return {...t.canonical,meta:{sender:{id:41},
        ...(t.canonical.meta.assignee?{assignee:t.canonical.meta.assignee,assignee_type:t.canonical.meta.assignee_type}:{}),
        ...(t.canonical.meta.team?{team:t.canonical.meta.team}:{})}};
    });
    const op=await t.reserve();
    expect(await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org)).toMatchObject({state:'APPLIED'});
    expect(t.writes).toEqual([{assignee_id:null},{team_id:null},{status:'pending'}]);
    expect(await db.transact(t.org,tx=>readChatwootAttendanceGate(tx,{organizationId:t.org,channelId:t.channel,conversationId:t.conversation})))
      .toMatchObject({allowed:true,state:'READY',cycle:2});
    expect((await db.database.pool.query('select observed_remote_updated_at from chatwoot_attendance_controls where organization_id=$1',[t.org])).rows[0].observed_remote_updated_at).toBe(103);
  });
  it('does not dispatch when the stock conversation lacks its factual control timestamp',async()=>{
    const t=await resumeFixture(db);
    t.setReadSerializer((path,result)=>{
      if(!path.endsWith('/conversations/51'))return result;
      const {updated_at:_,...withoutClock}=t.canonical;
      return {...withoutClock,last_activity_at:104};
    });
    const op=await t.reserve();
    expect(await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org))
      .toMatchObject({state:'ACTION_REQUIRED',errorCode:'ATTENDANCE_RESUME_REMOTE_CONTROL_UNVERIFIED'});
    expect(t.writes).toHaveLength(0);
    expect((await db.database.pool.query('select mode from messaging_conversations where id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
  });
  it('never resumes when a human intervenes during HTTP',async()=>{
    const t=await resumeFixture(db),op=await t.reserve();t.setAfterWrite(t.human);
    const w=createAttendanceResumeWorker({transact:db.transact,client:t.client});
    expect(await w.processAttendanceResume(op.id,t.org)).toMatchObject({state:'CANCELED'});
    expect(t.writes).toHaveLength(1);

    expect((await db.database.pool.query('select mode from messaging_conversations where id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
  });
  it.each(['membership','user'] as const)('rejects a disabled %s at admission and stops after revocation during HTTP',async identity=>{
    const t=await resumeFixture(db),owner=randomUUID();
    // Keep an active owner while exercising revocation of the requesting administrator.
    await db.database.pool.query("insert into users(id,email,password_hash) values($1,$2,'synthetic-only')",[owner,`${owner}@example.test`]);
    await db.database.pool.query("insert into memberships(organization_id,user_id,role) values($1,$2,'OWNER')",[t.org,owner]);
    const setStatus=(status:string)=>identity==='membership'
      ?db.database.pool.query('update memberships set status=$3 where organization_id=$1 and user_id=$2',[t.org,t.actor,status])
      :db.database.pool.query('update users set status=$2 where id=$1',[t.actor,status]);
    await setStatus('DISABLED');
    await expect(t.reserve()).rejects.toMatchObject({code:'ATTENDANCE_RESUME_FORBIDDEN'});
    expect(t.writes).toHaveLength(0);
    await setStatus('ACTIVE');
    const op=await t.reserve();t.setAfterWrite(async()=>{await setStatus('DISABLED');});
    expect(await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org))
      .toMatchObject({state:'CANCELED',errorCode:'ATTENDANCE_RESUME_FORBIDDEN'});
    expect(t.writes).toHaveLength(1);
    expect((await db.database.pool.query('select mode from messaging_conversations where id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
    expect((await db.database.pool.query('select id from attendance_sessions where organization_id=$1',[t.org])).rows).toHaveLength(0);
  });
  it('does not retry an unknown remote write or infer authorship from matching pending status',async()=>{
    const t=await resumeFixture(db),op=await t.reserve();t.setTimeout(true);
    const w=createAttendanceResumeWorker({transact:db.transact,client:t.client});
    expect(await w.processAttendanceResume(op.id,t.org)).toMatchObject({state:'UNKNOWN'});
    t.setTimeout(false);t.canonical.status='pending';t.canonical.meta.assignee=null;t.canonical.meta.team=null;
    expect(await w.processAttendanceResume(op.id,t.org)).toMatchObject({state:'ACTION_REQUIRED',errorCode:'ATTENDANCE_RESUME_REMOTE_PROOF_REQUIRED'});
    expect(t.writes).toHaveLength(1);
    const context=await t.service.getContext(t.org,t.conversation);
    await expect(t.service.requestAttendanceResume(t.org,t.actor,randomUUID(),{conversationId:t.conversation,expectedControlRevision:context.diagnostic.controlRevision,
      expectedOwnerRevision:context.ownerRevision,target:{kind:'NEW_SESSION'}})).rejects.toMatchObject({code:'ATTENDANCE_RESUME_IN_PROGRESS'});
  });
  it('invalidates a captured credential while keeping the bot blocked',async()=>{
    const t=await resumeFixture(db),op=await t.reserve();t.setAfterWrite(async()=>{await db.database.pool.query('update chatwoot_accounts set credential_version=credential_version+1 where organization_id=$1',[t.org]);});
    expect(await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org)).toMatchObject({state:'CANCELED'});
    expect(t.writes).toHaveLength(1);
  });
  it.each(['binding','owner'] as const)('invalidates a changed %s before the next remote write',async change=>{
    const t=await resumeFixture(db),op=await t.reserve();t.setAfterWrite(async()=>{
      await db.database.pool.query(change==='binding'
        ?"UPDATE automation_bindings SET status='PAUSED',revision=revision+1 WHERE organization_id=$1"
        :"UPDATE attendance_owners SET revision=revision+1 WHERE organization_id=$1",[t.org]);
    });
    expect(await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org)).toMatchObject({state:'CANCELED'});
    expect(t.writes).toHaveLength(1);
    expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
  });
  it('recovers an expired worker after dispatch without replaying any POST',async()=>{
    const t=await resumeFixture(db),op=await t.reserve();
    await db.database.pool.query("UPDATE attendance_resume_operations SET phase='CLEAR_AGENT',lease_token=$3,lease_expires_at=now()-interval '1 minute' WHERE organization_id=$1 AND id=$2",[t.org,op.id,randomUUID()]);
    expect(await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org))
      .toMatchObject({state:'ACTION_REQUIRED',errorCode:'ATTENDANCE_RESUME_REMOTE_PROOF_REQUIRED'});
    expect(t.writes).toHaveLength(0);
    expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
  });
  it('blocks competing automatic assignment before any remote mutation',async()=>{
    const t=await resumeFixture(db),op=await t.reserve();t.setAutoAssignment(true);
    expect(await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org))
      .toMatchObject({state:'ACTION_REQUIRED',errorCode:'ATTENDANCE_DISABLE_INBOX_AUTO_ASSIGNMENT'});
    expect(t.writes).toHaveLength(0);
  });
  it('works without any central and creates no invented remote identity',async()=>{
    const t=await resumeFixture(db,false),op=await t.reserve();
    expect(await createAttendanceResumeWorker({transact:db.transact}).processAttendanceResume(op.id,t.org)).toMatchObject({state:'APPLIED'});
    expect((await db.database.pool.query('select integration_id,account_id from attendance_sessions where organization_id=$1',[t.org])).rows)
      .toEqual([{integration_id:null,account_id:null}]);
  });
  it.each(['account_id','inbox_id','destination_revision'] as const)('rejects a stale remote %s instead of addressing a different central',async column=>{
    const t=await resumeFixture(db);
    await db.database.pool.query(`update chatwoot_attendance_controls set ${column}=${column}+1 where organization_id=$1`,[t.org]);
    await expect(t.reserve()).rejects.toMatchObject({code:'ATTENDANCE_DESTINATION_NOT_READY'});
    expect(t.writes).toHaveLength(0);
  });
  it('does not let a standalone native bot bypass coordinated resumption through legacy mode',async()=>{
    const t=await resumeFixture(db,false);
    const messaging=createMessagingService({repository:createPostgresMessagingRepository(),runInOrganizationTransaction:db.transact,
      resolveMetaClient:async()=>{throw new Error('UNUSED');},resolveTypebotClient:async()=>{throw new Error('UNUSED');}});
    await expect(messaging.setMode(t.org,t.conversation,'BOT')).rejects.toMatchObject({code:'ATTENDANCE_RESUME_REQUIRED'});
  });
  it('rechecks a connection committed while legacy activation waits for its channel',async()=>{
    const t=await resumeFixture(db,false);
    await db.database.pool.query('DELETE FROM attendance_owners WHERE organization_id=$1',[t.org]);
    const blocker=await db.database.pool.connect();await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM messaging_channels WHERE id=$1 FOR UPDATE',[t.channel]);
    const messaging=createMessagingService({repository:createPostgresMessagingRepository(),runInOrganizationTransaction:db.transact,
      resolveMetaClient:async()=>{throw new Error('UNUSED');},resolveTypebotClient:async()=>{throw new Error('UNUSED');}});
    const activation=messaging.setMode(t.org,t.conversation,'BOT').then(value=>({value}),error=>({error}));
    try{
      // Observe an actual lock wait, not a timer that guesses when the request reached it.
      let waiting=false;
      for(let attempt=0;attempt<100&&!waiting;attempt++){
        waiting=Boolean((await db.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='jrc_app' AND wait_event_type='Lock'")).rowCount);
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      await blocker.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,$2,7,'READY')",[t.org,`https://${t.org}.example.test`]);
      await blocker.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,9,'synthetic','READY')",[t.integration,t.org,t.channel]);
      await blocker.query('COMMIT');
      expect(await activation).toMatchObject({error:{code:'ATTENDANCE_RESUME_REQUIRED'}});
      expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
    }finally{await blocker.query('ROLLBACK');blocker.release();await activation;}
  });
  it('refuses a menu jump when the session has no compatible root state',async()=>{
    const t=await resumeFixture(db,false),op=await t.reserve();
    await createAttendanceResumeWorker({transact:db.transact}).processAttendanceResume(op.id,t.org);
    const graph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'menu',type:'menu',label:'Menu',position:{x:0,y:0},data:{text:'Escolha',options:[{value:'1',label:'Fim'}]}},{id:'end',type:'end',label:'End',position:{x:0,y:0},data:{}}],edges:[{id:'start',source:'start',target:'menu',port:'next'},{id:'option',source:'menu',target:'end',port:'option-1'}]};
    await db.database.pool.query('update automation_versions set graph=$2 where organization_id=$1',[t.org,JSON.stringify(graph)]);
    const context=await t.service.getContext(t.org,t.conversation);
    await expect(t.service.requestAttendanceResume(t.org,t.actor,randomUUID(),{conversationId:t.conversation,expectedOwnerRevision:context.ownerRevision,
      expectedControlRevision:context.diagnostic.controlRevision,target:{kind:'MENU',nodeId:'menu'}})).rejects.toMatchObject({code:'ATTENDANCE_RESUME_NEW_SESSION_REQUIRED'});
  });
  it('ignores delayed intermediate callbacks after confirmation but still honors a new human response',async()=>{
    const t=await resumeFixture(db),op=await t.reserve();
    t.setCallbacks(false);
    await createAttendanceResumeWorker({transact:db.transact,client:t.client}).processAttendanceResume(op.id,t.org);
    await db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,t.scope,{...t.canonical,status:'open',updated_at:101,
      meta:{...t.canonical.meta,team:{id:4}},event:'conversation_updated',account:{id:7}}));
    expect((await db.database.pool.query('select state from chatwoot_attendance_controls where organization_id=$1',[t.org])).rows[0].state).toBe('READY');
    await t.human();
    expect((await db.database.pool.query('select state from chatwoot_attendance_controls where organization_id=$1',[t.org])).rows[0].state).toBe('HUMAN');
  });
  it('continues an event cursor only on a new message, once, after worker replacement',async()=>{
    const t=await resumeFixture(db,false),op=await t.reserve();
    const graph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'ask',type:'input',label:'Nome',position:{x:0,y:0},data:{text:'Nome?',variable:'nome'}},{id:'end',type:'end',label:'End',position:{x:0,y:0},data:{}}],edges:[{id:'start',source:'start',target:'ask',port:'next'},{id:'answer',source:'ask',target:'end',port:'next'}]};
    await db.database.pool.query('update automation_versions set graph=$2 where organization_id=$1',[t.org,JSON.stringify(graph)]);
    await createAttendanceResumeWorker({transact:db.transact}).processAttendanceResume(op.id,t.org);
    await createExecutionService({transact:db.transact}).runOnce(t.org);
    const messaging=createMessagingService({repository:createPostgresMessagingRepository(),runInOrganizationTransaction:db.transact,
      resolveMetaClient:async()=>{throw new Error('UNUSED');},resolveTypebotClient:async()=>{throw new Error('UNUSED');}});
    await messaging.setMode(t.org,t.conversation,'HUMAN');
    const context=await t.service.getContext(t.org,t.conversation);
    const resume=await t.service.requestAttendanceResume(t.org,t.actor,randomUUID(),{conversationId:t.conversation,expectedOwnerRevision:context.ownerRevision,
      expectedControlRevision:context.diagnostic.controlRevision,target:{kind:'CONTINUE'}});
    await createAttendanceResumeWorker({transact:db.transact}).processAttendanceResume(resume.id,t.org);
    expect(await createExecutionService({transact:db.transact}).runOnce(t.org)).toEqual({processed:false});
    const event={channelId:t.channel,conversationId:t.conversation,eventKey:'fresh-answer',text:'Pessoa sintética'},router=createEventRouter({transact:db.transact});
    expect(await router.route(t.org,event)).toMatchObject({resumed:true});
    expect(await router.route(t.org,event)).toMatchObject({duplicate:true});
    expect(await createExecutionService({transact:db.transact}).runOnce(t.org)).toMatchObject({status:'COMPLETED'});
    const state=(await db.database.pool.query("select state from automation_executions where organization_id=$1 and status='COMPLETED'",[t.org])).rows[0].state;
    expect(state.variables.nome).toBe('Pessoa sintética');
  });
});
