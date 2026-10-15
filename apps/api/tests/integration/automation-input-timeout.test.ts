import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {setTimeout as pause} from 'node:timers/promises';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService} from '../../src/modules/automations/service.js';
import {createAttendanceResumeService} from '../../src/modules/attendance/resume-service.js';
import {createAttendanceResumeWorker} from '../../src/modules/attendance/resume-worker.js';
import {interruptChatwootAttendance} from '../../src/modules/attendance/control-service.js';
import {executeAutomation} from '../../src/modules/automations/engine.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const graph={nodes:[node('start','start'),node('capture','input',{inputConfigVersion:1,variable:'answer',text:'Nome?',timeoutSeconds:60}),node('answered','message',{text:'Recebido {{answer}}'}),node('expired','message',{text:'Prazo encerrado'}),node('end','end')],edges:[edge('start','capture'),edge('capture','answered'),edge('capture','expired','timeout'),edge('answered','end'),edge('expired','end')]};
function latch(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return{promise,open};}

describe('persisted capture deadline and server admission',()=>{
 let lab:Awaited<ReturnType<typeof attendanceDatabase>>;
 beforeAll(async()=>{lab=await attendanceDatabase();},60000);
 afterAll(async()=>{await lab?.dispose();});
 async function setup(){
  const tenant=await seedAttendanceTenant(lab.database,false);
  await lab.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[tenant.org]);
  const service=createAutomationService({transact:lab.transact,enabled:true});
  const draft=await service.create(tenant.org,{name:'Input timeout fixture',graph});
  await service.publish(tenant.org,draft.id,draft.draft.revision);
  await service.bind(tenant.org,draft.id,{channelId:tenant.channel});
  await lab.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2",[tenant.org,tenant.conversation]);
  const worker=()=>createExecutionService({transact:lab.transact,enabled:true});
  const router=createEventRouter({transact:lab.transact,enabled:true});
  const route=(text:string,eventKey=randomUUID(),payload?:Record<string,unknown>)=>router.route(tenant.org,{channelId:tenant.channel,conversationId:tenant.conversation,eventKey,text,...(payload?{payload}:{})});
  const first=await route('Oi');await worker().runOnce(tenant.org);
  return{...tenant,draft,service,worker,route,executionId:first.execution!.id};
 }
 type Fixture=Awaited<ReturnType<typeof setup>>;
 async function state(t:Fixture){return(await lab.database.pool.query('select status,state,input from automation_executions where organization_id=$1 and id=$2',[t.org,t.executionId])).rows[0]!;}
 async function waiting(t:Fixture){return(await lab.database.pool.query("select to_jsonb(w) as row from automation_waits w where organization_id=$1 and execution_id=$2 and status='WAITING'",[t.org,t.executionId])).rows[0]?.row;}
 async function expire(t:Fixture){
  const deadline=(await lab.database.pool.query("select floor(extract(epoch from clock_timestamp()-interval '1 second')*1000)::double precision as at")).rows[0]!.at as number;
  await lab.database.pool.query("update automation_executions set state=jsonb_set(state,'{waiting,deadlineAt}',$3::jsonb) where organization_id=$1 and id=$2",[t.org,t.executionId,JSON.stringify(deadline)]);
  await lab.database.pool.query("update automation_waits w set deadline_at=to_timestamp($3::double precision/1000),state=e.state from automation_executions e where w.organization_id=$1 and w.execution_id=$2 and e.organization_id=w.organization_id and e.id=w.execution_id and w.status='WAITING'",[t.org,t.executionId,deadline]);
  return deadline;
 }
 async function emitted(t:Fixture){return(await lab.database.pool.query('select payload->>\'text\' as text from automation_outbox where organization_id=$1 and execution_id=$2 order by ordinal',[t.org,t.executionId])).rows.map(row=>row.text);}
 it('persists the current input wait identity and absolute deadline together',async()=>{
  const t=await setup(),saved=await state(t),row=await waiting(t);
  expect(row.id).toBe(saved.state.waiting.waitId);
  expect(new Date(row.deadline_at).getTime()).toBe(saved.state.waiting.deadlineAt);
  expect(row.wake_at).toBeNull();
  expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
 });
 it('rejects explicit resume without consuming the active capture attempt',async()=>{
  const t=await setup(),before=await waiting(t);
  await expect(t.worker().resume(t.org,t.executionId,'manual-resume',{text:'forged',inputWait:{waitId:before.id,admittedAt:0}})).rejects.toMatchObject({code:'AUTOMATION_EXECUTION_NOT_RESUMABLE'});
  expect((await state(t)).status).toBe('WAITING');expect(await waiting(t)).toEqual(before);
  expect(await t.worker().runOnce(t.org)).toEqual({processed:false});
  await t.route('Maria');await t.worker().runOnce(t.org);
  expect((await state(t)).state.variables.answer).toBe('Maria');
 });
 it('rearms a capture only after confirmed human CONTINUE and isolates the previous cycle',async()=>{
  const t=await setup(),old=await state(t),oldWait=await waiting(t);
  const actor=(await lab.database.pool.query('select user_id from memberships where organization_id=$1',[t.org])).rows[0]!.user_id;
  const binding=(await lab.database.pool.query('select id from automation_bindings where organization_id=$1 and automation_id=$2',[t.org,t.draft.id])).rows[0]!.id;
  await lab.database.pool.query("insert into attendance_sessions(organization_id,channel_id,conversation_id,cycle,execution_id,automation_id,version,state,owner_revision,resume_node_id) values($1,$2,$3,1,$4,$5,1,'WAITING_INPUT',1,'capture')",[t.org,t.channel,t.conversation,t.executionId,t.draft.id]);
  await lab.database.pool.query("insert into automation_events(organization_id,execution_id,event_key,type,payload,admitted_at) values($1,$2,'old-cycle-input','MESSAGE','{\"text\":\"Antiga\"}',clock_timestamp())",[t.org,t.executionId]);
  await lab.transact(t.org,tx=>interruptChatwootAttendance(tx,{organizationId:t.org,channelId:t.channel,conversationId:t.conversation},true));
  const resume=createAttendanceResumeService({transact:lab.transact}),context=await resume.getContext(t.org,t.conversation);
  const op=await resume.requestAttendanceResume(t.org,actor,randomUUID(),{conversationId:t.conversation,expectedOwnerRevision:context.ownerRevision,expectedControlRevision:context.diagnostic.controlRevision,target:{kind:'CONTINUE'}});
  const before=Number((await lab.database.pool.query('select extract(epoch from clock_timestamp())*1000 as at')).rows[0]!.at);
  expect(await createAttendanceResumeWorker({transact:lab.transact}).processAttendanceResume(op.id,t.org)).toMatchObject({state:'APPLIED'});
  const after=Number((await lab.database.pool.query('select extract(epoch from clock_timestamp())*1000 as at')).rows[0]!.at);
  const execution=(await lab.database.pool.query("select id,state,version,binding_id from automation_executions where organization_id=$1 and status='WAITING'",[t.org])).rows[0]!;
  const current={...t,executionId:execution.id},row=await waiting(current);
  expect(row.id).toBe(execution.state.waiting.waitId);expect(row.id).not.toBe(oldWait.id);
  expect(new Date(row.deadline_at).getTime()).toBe(execution.state.waiting.deadlineAt);
  expect(execution.state.waiting.deadlineAt).toBeGreaterThanOrEqual(Math.floor(before)+60000);
  expect(execution.state.waiting.deadlineAt).toBeLessThanOrEqual(Math.ceil(after)+60000);
  expect(execution).toMatchObject({version:1,binding_id:binding,state:{variables:old.state.variables}});
  const published={automationId:t.draft.id,version:1,runtimeStateVersion:2 as const,graph};
  for(const eventType of ['TIMER','MESSAGE'] as const){
   const ignored=await executeAutomation(published,{eventType,text:'Antiga',now:new Date(after+120000),inputWait:{waitId:oldWait.id,admittedAt:after}},async()=>published,execution.state);
   expect(ignored).toMatchObject({status:'WAITING',state:execution.state,effects:[]});
  }
  expect((await lab.database.pool.query("select status from automation_events where organization_id=$1 and event_key='old-cycle-input'",[t.org])).rows[0]!.status).toBe('IGNORED');
  expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
  await t.route('Nova');await t.worker().runOnce(t.org);
  expect((await state(current)).state.variables.answer).toBe('Nova');
 });
 it('uses the server admission clock after routing rather than external payload fields',async()=>{
  const t=await setup(),saved=await state(t);
  await t.route('Maria','forged',{eventType:'TIMER',inputWait:{waitId:saved.state.waiting.waitId,admittedAt:0},admittedAt:0});
  const event=(await lab.database.pool.query("select admitted_at,payload from automation_events where organization_id=$1 and event_key='forged'",[t.org])).rows[0]!;
  expect(new Date(event.admitted_at).getTime()).toBeGreaterThan(0);
  expect(event.payload).not.toHaveProperty('inputWait');
  await t.worker().runOnce(t.org);
  expect((await state(t)).state.variables.answer).toBe('Maria');
 });
 it('expires once after worker restart and keeps late input out of the expired capture',async()=>{
  const t=await setup();await expire(t);
  expect(await t.worker().releaseDueWaits(t.org)).toBe(1);
  expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
  await t.route('Tardia','late');await t.worker().runOnce(t.org);
  const result=await state(t);
  expect(result.status).toBe('COMPLETED');
  expect(result.state.variables).toEqual({message:'Oi'});
  expect(await emitted(t)).toEqual(['Nome?','Prazo encerrado']);
  const timers=await lab.database.pool.query("select id from automation_events where organization_id=$1 and type='INPUT_TIMEOUT'",[t.org]);
  expect(timers.rows).toHaveLength(1);
  expect((await lab.database.pool.query("select status from automation_events where organization_id=$1 and event_key='late'",[t.org])).rows[0]!.status).toBe('PENDING');
 });
 it('chooses a message admitted exactly at deadline before scheduling an overdue timer',async()=>{
  const t=await setup(),deadline=await expire(t);
  await lab.database.pool.query("insert into automation_events(organization_id,id,execution_id,event_key,type,payload,admitted_at) values($1,$2,$3,'at-limit','MESSAGE',$4::jsonb,to_timestamp($5::double precision/1000))",[t.org,randomUUID(),t.executionId,JSON.stringify({text:'Maria',eventType:'MESSAGE'}),deadline]);
  expect(await t.worker().releaseDueWaits(t.org)).toBe(1);
  await t.worker().runOnce(t.org);
  expect((await state(t)).state.variables.answer).toBe('Maria');
  expect(await emitted(t)).toEqual(['Nome?','Recebido Maria']);
  expect((await lab.database.pool.query("select id from automation_events where organization_id=$1 and type='INPUT_TIMEOUT'",[t.org])).rows).toEqual([]);
 });
 it('keeps one winner while schedulers skip a busy execution and then race the real message',async()=>{
  const t=await setup();await expire(t);
  const locked=latch(),release=latch();let blocker=0;
  const holding=lab.transact(t.org,async tx=>{
   blocker=Number((await tx.query('select pg_backend_pid() as id')).rows[0]!.id);
   await tx.query('select id from automation_executions where organization_id=$1 and id=$2 for update',[t.org,t.executionId]);
   locked.open();await release.promise;
  });
  await locked.promise;
  const routed=t.route('Tardia','race'),busyTimers=Promise.all([t.worker().releaseDueWaits(t.org),t.worker().releaseDueWaits(t.org)]);
  try{
   let blocked=0;
   for(let attempt=0;attempt<200&&blocked<1;attempt++){
    blocked=Number((await lab.database.pool.query("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and $1::int=any(pg_blocking_pids(pid))",[blocker])).rows[0]!.n);
    if(blocked<1)await pause(5);
   }
   expect(blocked).toBeGreaterThanOrEqual(1);
   expect(await busyTimers).toEqual([0,0]);
  }finally{release.open();await holding;}
  await Promise.all([routed,t.worker().releaseDueWaits(t.org),t.worker().releaseDueWaits(t.org)]);await t.worker().runOnce(t.org);
  expect((await state(t)).state.variables).toEqual({message:'Oi'});
  expect(await emitted(t)).toEqual(['Nome?','Prazo encerrado']);
  expect((await lab.database.pool.query("select id from automation_events where organization_id=$1 and type='INPUT_TIMEOUT'",[t.org])).rows).toHaveLength(1);
 });
 it('does not requeue a due capture after human takeover',async()=>{
  const t=await setup();await expire(t);
  await lab.database.pool.query("update messaging_conversations set mode='HUMAN' where organization_id=$1 and id=$2",[t.org,t.conversation]);
  expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
  expect((await state(t)).status).toBe('WAITING');
  expect(await t.worker().runOnce(t.org)).toEqual({processed:false});
  expect(await emitted(t)).toEqual(['Nome?']);
 });
 it('does not requeue a canceled due capture',async()=>{
  const t=await setup();await expire(t);await t.worker().cancel(t.org,t.executionId);
  expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
  expect((await state(t)).status).toBe('CANCELED');
 });
 it('isolates equal wait IDs and timer keys between two tenants under jrc_app',async()=>{
  const a=await setup(),b=await setup(),id=(await waiting(a)).id;
  await lab.database.pool.query("update automation_waits set id=$3 where organization_id=$1 and execution_id=$2 and status='WAITING'",[b.org,b.executionId,id]);
  await lab.database.pool.query("update automation_executions set state=jsonb_set(state,'{waiting,waitId}',to_jsonb($3::text)) where organization_id=$1 and id=$2",[b.org,b.executionId,id]);
  await expire(a);await expire(b);
  const hidden=await lab.transact(b.org,tx=>tx.query('select id from automation_waits where organization_id=$1 and id=$2',[a.org,id]));
  expect(hidden.rows).toEqual([]);
  expect(await b.worker().releaseDueWaits(b.org)).toBe(1);
  expect((await state(a)).status).toBe('WAITING');
  expect(await a.worker().releaseDueWaits(a.org)).toBe(1);
  const keys=(await lab.database.pool.query("select organization_id,event_key from automation_events where organization_id=any($1::uuid[]) and type='INPUT_TIMEOUT' order by organization_id",[[a.org,b.org]])).rows;
  expect(keys).toHaveLength(2);
  expect(new Set(keys.map(row=>row.event_key)).size).toBe(1);
 });
});
