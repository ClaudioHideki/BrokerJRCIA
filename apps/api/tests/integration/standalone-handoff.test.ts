import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { attendanceDatabase,seedAttendanceTenant } from './helpers/attendance.js';
import { assertStandaloneDestination } from '../../src/modules/attendance/destination-adapter.js';
import { createLocalAttendanceCatalog } from '../../src/modules/attendance/local-catalog.js';
import { createLocalHandoffService } from '../../src/modules/attendance/local-handoff.js';
import { createHandoffReadiness } from '../../src/modules/attendance/handoff-readiness.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createAutomationEffectDispatcher } from '../../src/commands/automation-worker.js';
import { createEventRouter,createExecutionService,createOutboxDispatcher } from '../../src/modules/automations/service.js';
import { createAttendanceResumeService } from '../../src/modules/attendance/resume-service.js';
import { createAttendanceResumeWorker } from '../../src/modules/attendance/resume-worker.js';
import { createMessagingService } from '../../src/modules/messaging/service.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { createPostgresHandoffRepository } from '../../src/modules/attendance/handoff-repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { createChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import type { OutboxRow } from '../../src/modules/automations/repository.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
async function fixture(remote=false){
 const t=await seedAttendanceTenant(db.database,remote),binding=randomUUID(),execution=randomUUID(),id=randomUUID(),leaseToken=randomUUID();
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[t.org]);
 await db.database.pool.query("UPDATE messaging_channels SET bot_public_id=$2,bot_origin_reference='jrc-automation-v2' WHERE id=$1",[t.channel,t.automation]);
 await db.database.pool.query('INSERT INTO automation_bindings(organization_id,id,automation_id,version,channel_id) VALUES($1,$2,$3,1,$4)',[t.org,binding,t.automation,t.channel]);
 await db.database.pool.query("INSERT INTO attendance_owners(organization_id,channel_id,executor,revision,automation_id,version) VALUES($1,$2,'BROKER',1,$3,1)",[t.org,t.channel,t.automation]);
 await db.database.pool.query("INSERT INTO automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status) VALUES($1,$2,$3,1,$4,$5,$6,'synthetic',$7,'HANDOFF')",[t.org,execution,t.automation,binding,t.channel,t.conversation,randomUUID()]);
 const payload={handoffVersion:2,destination:{kind:'LOCAL',organizationId:t.org,channelId:t.channel},target:{kind:'QUEUE'}};
 await db.database.pool.query("INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,payload,status,attempts,lease_token,lease_expires_at) VALUES($1,$2,$3,'handoff',1,'HANDOFF',$4,'UNKNOWN',1,$5,now()+interval '3 minutes')",[t.org,id,execution,JSON.stringify(payload),leaseToken]);
 const item:OutboxRow={id,organizationId:t.org,executionId:execution,channelId:t.channel,conversationId:t.conversation,nodeId:'handoff',ordinal:1,kind:'HANDOFF',payload,attempts:1,leaseToken};
 return {...t,item,execution,binding};
}
it('lists a local queue scoped to its channel and never exposes remote identities',async()=>{
 const t=await fixture(),other=await fixture();
 const list=await createLocalAttendanceCatalog({transact:db.transact}).listChannels(t.org);
 expect(list).toEqual([{scope:{kind:'LOCAL',organizationId:t.org,channelId:t.channel},name:expect.any(String)}]);
 expect(JSON.stringify(list)).not.toMatch(/accountId|inboxId|integrationId/);
 await expect(db.transact(t.org,tx=>assertStandaloneDestination(tx,t.org,other.channel))).rejects.toThrow('CHANNEL_NOT_FOUND');
});
it.each(['READY','FAILED','DISABLED'])('never falls back to local attendance for a %s central',async status=>{
 const t=await fixture(true);await db.database.pool.query('UPDATE chatwoot_connections SET status=$2 WHERE organization_id=$1',[t.org,status]);
 await expect(db.transact(t.org,tx=>assertStandaloneDestination(tx,t.org,t.channel))).rejects.toThrow('ATTENDANCE_CENTRAL_CONFIGURED');
 expect(await createLocalAttendanceCatalog({transact:db.transact}).listChannels(t.org)).toEqual([]);
 expect(await createLocalHandoffService({transact:db.transact}).dispatch(t.item)).toMatchObject({kind:'FAILED',error:'ATTENDANCE_CENTRAL_CONFIGURED'});
});
it('commits the queue, bot pause, session and idempotent receipt atomically',async()=>{
 const t=await fixture(),service=createLocalHandoffService({transact:db.transact});
 expect(await service.dispatch(t.item)).toEqual({kind:'SENT',remoteReference:`local-handoff:${t.item.id}`});
 expect(await service.dispatch(t.item)).toEqual({kind:'SENT',remoteReference:`local-handoff:${t.item.id}`});
 const session=(await db.database.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[t.org])).rows;
 expect(session).toHaveLength(1);expect(session[0]).toMatchObject({state:'WAITING_HUMAN',cycle:1,integration_id:null,account_id:null,inbox_id:null,remote_conversation_id:null});
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
 expect((await db.database.pool.query('SELECT status,remote_reference FROM automation_outbox WHERE id=$1',[t.item.id])).rows[0]).toMatchObject({status:'SENT',remote_reference:`local-handoff:${t.item.id}`});
});
it('recovers an expired local reservation after a worker dies before the atomic commit without any central runtime',async()=>{
 const t=await fixture();
 await db.database.pool.query("UPDATE automation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[t.item.id]);
 const dispatcher=createOutboxDispatcher({transact:db.transact,enabled:true},createAutomationEffectDispatcher({transact:db.transact,messaging:createPostgresMessagingRepository()}));
 expect(await dispatcher.runOnce(t.org)).toMatchObject({processed:true,status:'SENT'});
 expect(await dispatcher.runOnce(t.org)).toEqual({processed:false});
 expect((await db.database.pool.query('SELECT state,cycle FROM attendance_sessions WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'WAITING_HUMAN',cycle:1}]);
 expect((await db.database.pool.query('SELECT attempts,status,remote_reference FROM automation_outbox WHERE id=$1',[t.item.id])).rows[0]).toMatchObject({attempts:2,status:'SENT',remote_reference:`local-handoff:${t.item.id}`});
});
it('does not recover an unexpired local reservation or an unknown external effect',async()=>{
 const t=await fixture(),dispatcher=createOutboxDispatcher({transact:db.transact,enabled:true},createAutomationEffectDispatcher({transact:db.transact,messaging:createPostgresMessagingRepository()}));
 expect(await dispatcher.runOnce(t.org)).toEqual({processed:false});
 await db.database.pool.query("UPDATE automation_outbox SET payload=$2,lease_expires_at=now()-interval '1 second' WHERE id=$1",[t.item.id,JSON.stringify({handoffVersion:1,destination:{integrationId:randomUUID()}})]);
 expect(await dispatcher.runOnce(t.org)).toEqual({processed:false});
 expect((await db.database.pool.query('SELECT status,attempts FROM automation_outbox WHERE id=$1',[t.item.id])).rows[0]).toEqual({status:'UNKNOWN',attempts:1});
});
it('closes an expired local reservation after human takeover instead of leaving an UNKNOWN barrier',async()=>{
 const t=await fixture();
 await db.database.pool.query("UPDATE automation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[t.item.id]);
 await db.database.pool.query("UPDATE messaging_conversations SET mode='HUMAN' WHERE id=$1",[t.conversation]);
 const dispatcher=createOutboxDispatcher({transact:db.transact,enabled:true},createAutomationEffectDispatcher({transact:db.transact,messaging:createPostgresMessagingRepository()}));
 await dispatcher.runOnce(t.org);
 expect((await db.database.pool.query('SELECT status,last_error FROM automation_outbox WHERE id=$1',[t.item.id])).rows[0]).toEqual({status:'FAILED',last_error:'HANDOFF_AUTHORITY_CHANGED'});
 expect((await db.database.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].mode).toBe('HUMAN');
});
it('keeps expired local reservations out of the remote orphan reconciler',async()=>{
 const t=await fixture();
 await db.database.pool.query("UPDATE automation_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[t.item.id]);
 expect(await db.transact(t.org,tx=>createPostgresHandoffRepository().next(tx,t.org))).toBeNull();
 expect((await db.database.pool.query('SELECT status FROM automation_outbox WHERE id=$1',[t.item.id])).rows[0].status).toBe('UNKNOWN');
 expect((await db.database.pool.query('SELECT * FROM attendance_handoff_operations WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
});
it('exposes local destination in inspection before a receipt exists without exposing its payload',async()=>{
 const t=await fixture(),inspection=createExecutionService({transact:db.transact});
 const detail=await inspection.get(t.org,t.execution);
 expect(detail.outbox[0]).toMatchObject({handoffDestination:'LOCAL',remoteReference:null,status:'UNKNOWN'});
 expect(detail.outbox[0]).not.toHaveProperty('payload');
});
it('rejects forged payload scope and a human takeover after reservation',async()=>{
 const t=await fixture();await db.database.pool.query('UPDATE automation_outbox SET payload=$2 WHERE id=$1',[t.item.id,JSON.stringify({...t.item.payload,destination:{kind:'LOCAL',organizationId:randomUUID(),channelId:t.channel}})]);
 expect(await createLocalHandoffService({transact:db.transact}).dispatch(t.item)).toMatchObject({kind:'FAILED',error:'HANDOFF_SCOPE_MISMATCH'});
 const h=await fixture();await db.database.pool.query("UPDATE messaging_conversations SET mode='HUMAN' WHERE id=$1",[h.conversation]);
 expect(await createLocalHandoffService({transact:db.transact}).dispatch(h.item)).toMatchObject({kind:'FAILED',error:'HANDOFF_AUTHORITY_CHANGED'});
 expect((await db.database.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[h.org])).rows).toEqual([]);
});
it('rechecks the local destination between preparation and publication',async()=>{
 const t=await fixture(),graph={nodes:[{id:'h',type:'handoff',label:'Fila',position:{x:0,y:0},data:t.item.payload}],edges:[]};
 const prepared=await createHandoffReadiness({transact:db.transact}).prepare(t.org,graph,t.channel);
 await db.transact(t.org,tx=>prepared.assertCurrent(tx));
 await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,$2,7,'READY')",[t.org,`https://${t.org}.example.test`]);
 await db.database.pool.query("INSERT INTO chatwoot_connections(organization_id,channel_id,name,status) VALUES($1,$2,'Synthetic','PENDING')",[t.org,t.channel]);
 await expect(db.transact(t.org,tx=>prepared.assertCurrent(tx))).rejects.toThrow('ATTENDANCE_CENTRAL_CONFIGURED');
});
it('serializes central connection admission with an in-progress local destination check',async()=>{
 const t=await fixture(),origin=`https://${t.org}.example.test`,key=Buffer.alloc(32,6).toString('base64');
 await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,7,$3,'READY')",
  [t.org,origin,createIntegrationSecrets(key).encrypt(`${t.org}:chatwoot-account`,'synthetic-admission-token')]);
 const service=createChatwootService({baseUrl:origin,publicOrigin:'https://broker.example.test',encryptionKey:key,transact:db.transact,
  resolveIntegration:async()=>undefined,fetch:async()=>new Response('',{status:401})});
 let release:()=>void=()=>{},ready:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;});
 const local=db.transact(t.org,async tx=>{await assertStandaloneDestination(tx,t.org,t.channel);ready();await gate;});
 await locked;
 const connection=service.connect(t.org,{channelId:t.channel,name:'Synthetic admission'}).catch(error=>error);
 try{
  await expect.poll(async()=>({
   committed:(await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_connections WHERE organization_id=$1',[t.org])).rows[0].n,
   blocked:(await db.database.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%messaging_channels%for no key update%' ")).rows[0].n,
  }),{timeout:3000}).toEqual({committed:0,blocked:1});
 }finally{release();await local;await connection;}
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_connections WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
});
it('serializes publication and archive of a bound local flow without a channel/definition deadlock',async()=>{
 const t=await fixture();
 await db.database.pool.query('DELETE FROM automation_outbox WHERE organization_id=$1',[t.org]);
 await db.database.pool.query('DELETE FROM automation_executions WHERE organization_id=$1',[t.org]);
 const graph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'h',type:'handoff',label:'Fila',position:{x:100,y:0},data:t.item.payload}],edges:[{id:'s',source:'start',target:'h',port:'next'}]};
 await db.database.pool.query("UPDATE automation_definitions SET draft_graph=$2,active_version=1,lifecycle_status='PUBLISHED' WHERE organization_id=$1",[t.org,JSON.stringify(graph)]);
 let release:()=>void=()=>{},ready:()=>void=()=>{},publicationPid=0,archivePid=0;
 const gate=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;});
 const publisher=createAutomationService({handoffReadiness:createHandoffReadiness({transact:db.transact}),transact:(org,work)=>db.transact(org,async tx=>{
  const observed={query:async(sql:string,args?:unknown[])=>{
   const result=await tx.query(sql,args);
   if(sql.includes('from automation_definitions')&&sql.includes('for update')){
    publicationPid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;ready();await gate;
   }return result;
  }} as TenantTransaction;return work(observed);
 })});
 const publication=publisher.publish(t.org,t.automation,1).then(value=>({value}),error=>({error}));
 await locked;
 const archiveService=createAutomationService({transact:(org,work)=>db.transact(org,async tx=>{
  archivePid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;return work(tx);
 })});
 const archive=archiveService.setArchived(t.org,t.automation,true).then(value=>({value}),error=>({error}));
 try{await expect.poll(async()=>archivePid!==0&&Boolean((await db.database.pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND $2=any(pg_blocking_pids(pid))',[archivePid,publicationPid])).rowCount),{timeout:5000}).toBe(true);}
 finally{release();}
 const results=await Promise.all([publication,archive]);
 expect(results.map(result=>'error' in result?result.error:null)).toEqual([null,null]);
});
it('rejects an execution whose binding belongs to another channel of the same tenant',async()=>{
 const t=await fixture(),otherChannel=randomUUID(),otherBinding=randomUUID();
 await db.database.pool.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference)
  SELECT $2::uuid,organization_id,provider_account_id,$2::text,'synthetic','vault://test' FROM messaging_channels WHERE id=$1`,[t.channel,otherChannel]);
 await db.database.pool.query('INSERT INTO automation_bindings(organization_id,id,automation_id,version,channel_id) VALUES($1,$2,$3,1,$4)',[t.org,otherBinding,t.automation,otherChannel]);
 await db.database.pool.query('UPDATE automation_executions SET binding_id=$2 WHERE id=$1',[t.execution,otherBinding]);
 expect(await createLocalHandoffService({transact:db.transact}).dispatch(t.item)).toMatchObject({kind:'FAILED',error:'HANDOFF_AUTHORITY_CHANGED'});
 expect((await db.database.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
});
it('runs menu, capture, local queue, operator reply and coordinated menu resume with a synthetic transport receipt',async()=>{
 const t=await fixture(),node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
 const graph={nodes:[node('start','start'),node('menu','menu',{text:'Escolha',variable:'choice',options:[{value:'1',label:'Atendimento'},{value:'2',label:'Encerrar'}]}),node('name','input',{text:'Qual seu nome?',variable:'nome'}),node('handoff','handoff',t.item.payload),node('end','end')],
  edges:[{id:'start',source:'start',target:'menu',port:'next'},{id:'human',source:'menu',target:'name',port:'option-1'},{id:'capture',source:'name',target:'handoff',port:'next'},{id:'end',source:'menu',target:'end',port:'option-2'}]};
 await db.database.pool.query('DELETE FROM automation_outbox WHERE organization_id=$1',[t.org]);
 await db.database.pool.query('DELETE FROM automation_executions WHERE organization_id=$1',[t.org]);
 await db.database.pool.query('UPDATE automation_versions SET graph=$2,runtime_state_version=2 WHERE organization_id=$1',[t.org,JSON.stringify(graph)]);
 await db.database.pool.query("UPDATE automation_definitions SET lifecycle_status='PUBLISHED',active_version=1,draft_graph=$2 WHERE organization_id=$1",[t.org,JSON.stringify(graph)]);
 const router=createEventRouter({transact:db.transact,enabled:true}),worker=()=>createExecutionService({transact:db.transact,enabled:true});
 const messaging=createPostgresMessagingRepository(),dispatcher=()=>createOutboxDispatcher({transact:db.transact,enabled:true},createAutomationEffectDispatcher({transact:db.transact,messaging}));
 const input={channelId:t.channel,conversationId:t.conversation,eventKey:'synthetic-local-start',text:'Oi'};
 expect((await router.route(t.org,input)).execution?.id).toBeTruthy();
 expect(await worker().runOnce(t.org)).toMatchObject({status:'WAITING'});
 expect(await dispatcher().runOnce(t.org)).toMatchObject({status:'SENT'});
 expect((await db.database.pool.query("SELECT content,state FROM messaging_messages WHERE organization_id=$1",[t.org])).rows[0]).toMatchObject({content:{type:'TEXT',text:'Escolha\n1 - Atendimento\n2 - Encerrar'},state:'ACCEPTED'});
 expect(await router.route(t.org,{...input,eventKey:'synthetic-local-choice',text:'1'})).toMatchObject({resumed:true});
 expect(await worker().runOnce(t.org)).toMatchObject({status:'WAITING'});
 expect(await dispatcher().runOnce(t.org)).toMatchObject({status:'SENT'});
 expect(await router.route(t.org,{...input,eventKey:'synthetic-local-name',text:'Pessoa sintética'})).toMatchObject({resumed:true});
 expect(await worker().runOnce(t.org)).toMatchObject({status:'HANDOFF'});
 expect(await dispatcher().runOnce(t.org)).toMatchObject({status:'NOT_SENT'});
 expect((await db.database.pool.query('SELECT * FROM attendance_sessions WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 // ACCEPTED is the enqueue receipt only. This explicit lab receipt represents provider delivery.
 await db.database.pool.query("UPDATE messaging_messages SET state='SENT' WHERE organization_id=$1 AND source='AUTOMATION'",[t.org]);
 await db.database.pool.query('DELETE FROM messaging_outbox WHERE organization_id=$1',[t.org]);
 await db.database.pool.query("UPDATE automation_outbox SET available_at=now() WHERE organization_id=$1 AND kind='HANDOFF'",[t.org]);
 expect(await dispatcher().runOnce(t.org)).toMatchObject({status:'SENT'});
 expect(await router.route(t.org,{...input,eventKey:'synthetic-local-paused',text:'Mais uma mensagem'})).toMatchObject({execution:null});
 const service=createMessagingService({repository:messaging,runInOrganizationTransaction:db.transact,
  resolveMetaClient:async()=>{throw new Error('No external provider in this lab');},resolveTypebotClient:async()=>{throw new Error('No external provider in this lab');}});
 expect(await service.sendText(t.org,t.channel,{conversationId:t.conversation,text:'Olá, atendimento humano'},'synthetic-operator-reply')).toMatchObject({state:'ACCEPTED'});
 expect((await db.database.pool.query("SELECT source,content FROM messaging_messages WHERE organization_id=$1 AND source='OPERATOR'",[t.org])).rows[0]).toMatchObject({source:'OPERATOR',content:{type:'TEXT',text:'Olá, atendimento humano'}});
 expect((await db.database.pool.query('SELECT state FROM attendance_sessions WHERE organization_id=$1',[t.org])).rows[0].state).toBe('HUMAN_ACTIVE');
 const resumeService=createAttendanceResumeService({transact:db.transact}),context=await resumeService.getContext(t.org,t.conversation);
 const actor=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0].user_id;
 const operation=await resumeService.requestAttendanceResume(t.org,actor,randomUUID(),{conversationId:t.conversation,expectedOwnerRevision:context.ownerRevision,expectedControlRevision:context.diagnostic.controlRevision,target:{kind:'MENU',nodeId:'menu'}});
 expect(await createAttendanceResumeWorker({transact:db.transact}).processAttendanceResume(operation.id,t.org)).toMatchObject({state:'APPLIED'});
 expect(await worker().runOnce(t.org)).toMatchObject({status:'WAITING'});
 expect(await router.route(t.org,{...input,eventKey:'synthetic-local-new-cycle',text:'2'})).toMatchObject({resumed:true});
 expect(await worker().runOnce(t.org)).toMatchObject({status:'COMPLETED'});
 expect((await db.database.pool.query("SELECT state FROM automation_executions WHERE organization_id=$1 AND status='COMPLETED'",[t.org])).rows[0].state.variables.nome).toBe('Pessoa sintética');
 expect((await db.database.pool.query('SELECT cycle,state,integration_id FROM attendance_sessions WHERE organization_id=$1 ORDER BY cycle',[t.org])).rows).toEqual([{cycle:1,state:'RESOLVED',integration_id:null},{cycle:2,state:'BOT_ACTIVE',integration_id:null}]);
});
