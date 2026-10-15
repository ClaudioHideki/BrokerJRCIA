import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService,createOutboxDispatcher} from '../../src/modules/automations/service.js';
import {createPostgresAutomationRepository} from '../../src/modules/automations/repository.js';
import {createConversationEffectRuntime} from '../../src/modules/automations/conversation-runtime.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});

describe('conversation effect durable wait and reconciliation boundaries',()=>{
  let lab:Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async()=>{lab=await attendanceDatabase();},60000);
  afterAll(async()=>{await lab?.dispose();});
  async function setup(operation:'note'|'resolve'='note'){
    const tenant=await seedAttendanceTenant(lab.database,false);
    await lab.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[tenant.org]);
    const graph={nodes:[node('start','start'),node('action',operation,{conversationEffectVersion:2,operation,
      channelId:tenant.channel,...(operation==='note'?{text:'Private synthetic note'}:{status:'RESOLVED'}),target:'effect.result',timeoutMs:15000}),...(operation==='note'?[node('end','end')]:[])],
      edges:[edge('start','action'),...(operation==='note'?[edge('action','end','success'),edge('action','end','error'),edge('action','end','timeout')]:[])]};
    const service=createAutomationService({transact:lab.transact,enabled:true});
    const draft=await service.create(tenant.org,{name:'P3 persistence fixture',graph});
    await service.publish(tenant.org,draft.id,draft.draft.revision);
    await service.bind(tenant.org,draft.id,{channelId:tenant.channel});
    await lab.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2",[tenant.org,tenant.conversation]);
    const worker=createExecutionService({transact:lab.transact,enabled:true});
    const first=await createEventRouter({transact:lab.transact,enabled:true}).route(tenant.org,
      {channelId:tenant.channel,conversationId:tenant.conversation,eventKey:randomUUID(),text:'Hi'});
    await worker.runOnce(tenant.org);
    const executionId=first.execution!.id;
    const execution=(await lab.database.pool.query('select state,status from automation_executions where organization_id=$1 and id=$2',
      [tenant.org,executionId])).rows[0]!;
    const outbox=(await lab.database.pool.query('select id,status,kind,payload from automation_outbox where organization_id=$1 and execution_id=$2',
      [tenant.org,executionId])).rows[0]!;
    return {...tenant,executionId,execution,outbox,worker};
  }

  it('persists one UUID shared by the execution wait, SQL wait and outbox',async()=>{
    const t=await setup();
    const wait=(await lab.database.pool.query("select id from automation_waits where organization_id=$1 and execution_id=$2 and status='WAITING'",
      [t.org,t.executionId])).rows[0]!;
    expect(t.execution.status).toBe('WAITING');
    expect(t.outbox.kind).toBe('IO_CONVERSATION');
    expect(t.outbox.id).toBe(t.execution.state.waiting.waitId);
    expect(wait.id).toBe(t.outbox.id);
    expect(t.outbox.payload.waitId).toBe(t.outbox.id);
  });

  it('does not allow a manual resume to turn a known wait UUID into a fabricated receipt',async()=>{
    const t=await setup();
    await expect(t.worker.resume(t.org,t.executionId,'manual-forgery',{
      waitId:t.execution.state.waiting.waitId,outcome:'success',output:{confirmed:true},
    })).rejects.toMatchObject({code:'AUTOMATION_EXECUTION_NOT_RESUMABLE'});
    expect((await lab.database.pool.query('select status from automation_executions where organization_id=$1 and id=$2',
      [t.org,t.executionId])).rows[0]?.status).toBe('WAITING');
  });

  it('forbids manual UNKNOWN relabeling from scheduling another mutation',async()=>{
    const t=await setup();
    await lab.database.pool.query("update automation_outbox set status='UNKNOWN' where organization_id=$1 and id=$2",[t.org,t.outbox.id]);
    const actor=(await lab.database.pool.query('select user_id from memberships where organization_id=$1',[t.org])).rows[0]!.user_id;
    await expect(lab.transact(t.org,tx=>createPostgresAutomationRepository().reconcileUnknownOutbox(tx,{
      org:t.org,executionId:t.executionId,outboxId:t.outbox.id,actorId:actor,outcome:'CONFIRMED_NOT_SENT',evidenceCode:'MANUAL',
    }))).rejects.toMatchObject({code:'AUTOMATION_EFFECT_RECEIPT_REQUIRED'});
    expect((await lab.database.pool.query('select status from automation_outbox where organization_id=$1 and id=$2',[t.org,t.outbox.id])).rows[0]?.status)
      .toBe('UNKNOWN');
  });

  it('commits a private local note once with its receipt and resumes only that wait',async()=>{
    const t=await setup(),runtime=createConversationEffectRuntime({transact:lab.transact});
    const dispatcher=createOutboxDispatcher({transact:lab.transact,enabled:true},runtime.dispatcher,['IO_CONVERSATION']);
    expect(await dispatcher.runOnce(t.org)).toMatchObject({status:'SENT'});
    expect(await dispatcher.runOnce(t.org)).toMatchObject({processed:false});
    const notes=(await lab.database.pool.query('select body,origin_outbox_id from automation_private_notes where organization_id=$1',[t.org])).rows;
    expect(notes).toEqual([{body:'Private synthetic note',origin_outbox_id:t.outbox.id}]);
    expect((await lab.database.pool.query('select id from messaging_messages where organization_id=$1',[t.org])).rows).toEqual([]);
    expect((await lab.database.pool.query('select status from automation_executions where organization_id=$1 and id=$2',[t.org,t.executionId])).rows[0]?.status).toBe('QUEUED');
    await t.worker.runOnce(t.org);
    expect((await lab.database.pool.query('select status from automation_executions where organization_id=$1 and id=$2',[t.org,t.executionId])).rows[0]?.status).toBe('COMPLETED');
  });

  it('resolves and completes the current cycle without queuing another automatic turn',async()=>{
    const t=await setup('resolve'),runtime=createConversationEffectRuntime({transact:lab.transact});
    const dispatcher=createOutboxDispatcher({transact:lab.transact,enabled:true},runtime.dispatcher,['IO_CONVERSATION']);
    expect(await dispatcher.runOnce(t.org)).toMatchObject({status:'SENT'});
    expect((await lab.database.pool.query('select status,state from automation_executions where organization_id=$1 and id=$2',[t.org,t.executionId])).rows[0])
      .toMatchObject({status:'COMPLETED',state:{nodeId:null,stack:[]}});
    expect((await lab.database.pool.query('select status from automation_conversation_state where organization_id=$1',[t.org])).rows[0]?.status).toBe('RESOLVED');
    expect((await lab.database.pool.query('select state from attendance_sessions where organization_id=$1 and conversation_id=$2',[t.org,t.conversation])).rows.every(row=>row.state==='RESOLVED')).toBe(true);
    expect(await t.worker.runOnce(t.org)).toMatchObject({processed:false});
  });

  it('settles an expired claim with no persisted admission without making another dispatch',async()=>{
    const t=await setup();
    const runtime=createConversationEffectRuntime({transact:lab.transact});
    await lab.database.pool.query("update automation_outbox set status='UNKNOWN',lease_token=$3,lease_expires_at=now()+interval '1 minute' where organization_id=$1 and id=$2",[t.org,t.outbox.id,randomUUID()]);
    await runtime.reconcileOnce(t.org);
    expect((await lab.database.pool.query('select status from automation_outbox where organization_id=$1 and id=$2',[t.org,t.outbox.id])).rows[0]?.status).toBe('UNKNOWN');
    expect((await lab.database.pool.query('select id from automation_conversation_effects where organization_id=$1',[t.org])).rows).toHaveLength(0);
    await lab.database.pool.query("update automation_outbox set status='UNKNOWN',lease_token=$3,lease_expires_at=now()-interval '1 second' where organization_id=$1 and id=$2",[t.org,t.outbox.id,randomUUID()]);
    await runtime.reconcileOnce(t.org);
    expect((await lab.database.pool.query('select status from automation_outbox where organization_id=$1 and id=$2',[t.org,t.outbox.id])).rows[0]?.status).toBe('FAILED');
    expect((await lab.database.pool.query('select state from automation_conversation_effects where organization_id=$1 and outbox_id=$2',[t.org,t.outbox.id])).rows[0]?.state).toBe('REJECTED');
    expect((await lab.database.pool.query('select id from automation_private_notes where organization_id=$1',[t.org])).rows).toEqual([]);
  });
});
