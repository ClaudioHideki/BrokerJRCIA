import {BoxDirectorySnapshotSchema,DirectoryMenuSchema,type AutomationGraphV1,type AttendanceCatalog,type AttendanceScope,type HumanTarget} from '@jrc/contracts';
import type {RuntimeState} from './types.js';
import {assertRuntimeState} from './runtime-state.js';
import type {HandoffOperation,HandoffRepository,HandoffTransactions} from '../attendance/handoff-types.js';
import type {ChatwootClient} from '../integrations/chatwoot-client.js';
import type {AccountRow} from '../integrations/chatwoot-context.js';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {OutboxRow} from './repository.js';
import {readChatwootAttendanceGate} from '../attendance/control-service.js';
const unsafe=():never=>{throw Error('FLOW_BOX_RECOVERY_UNSAFE');};
type Context={graph:AutomationGraphV1;state:RuntimeState};
export function prepareDirectoryReoffer(context:Context,input:{catalog:AttendanceCatalog;members:Array<{id:number;name:string}>;target:HumanTarget;teamId:number;scope:AttendanceScope;credentialRevision:number;nodeId:string}){
 const old=context.state,selected=old.boxSelection;
 if(!old.boxDirectory||!selected||old.waiting||old.stack.length||old.nodeId!==null||selected.agentId!==input.target.agentId||input.target.teamId!==null)return unsafe();
 const directory=BoxDirectorySnapshotSchema.parse(old.boxDirectory),route=directory.routes.find(r=>r.routeKey===selected.routeKey);
 if(!route||route.mode!=='AGENT'||route.teamId!==input.teamId||!route.agents.some(a=>a.id===selected.agentId))return unsafe();
 for(const scope of [directory.scope,input.catalog.scope])if(Object.entries(input.scope).some(([k,v])=>scope[k as keyof AttendanceScope]!==v))return unsafe();
 if(directory.credentialRevision!==input.credentialRevision||input.catalog.credentialRevision!==input.credentialRevision||
  !['teams','agents','inboxMembership'].every(k=>input.catalog.capabilities[k as 'teams'|'agents'|'inboxMembership']==='SUPPORTED')||!input.catalog.teams.some(t=>t.id===input.teamId))return unsafe();
 const menu=context.graph.nodes.find(n=>n.id===selected.menuNodeId),handoff=context.graph.nodes.find(n=>n.id===input.nodeId);
 if(menu?.type!=='directory-menu'||handoff?.type!=='handoff'||handoff.data.handoffVersion!==3||handoff.data.routeKey!==selected.routeKey||
  !context.graph.edges.some(e=>e.source===menu.id&&e.port==='selected'&&e.target===handoff.id))return unsafe();
 const config=DirectoryMenuSchema.parse(menu.data);if(config.routeKey!==selected.routeKey||config.language!==selected.language)return unsafe();
 const candidates=route.agents.flatMap((offered,i)=>{const a=input.catalog.agents.find(a=>a.id===offered.id&&a.inboxMember&&input.members.some(m=>m.id===a.id));return a?[{id:a.id,name:a.name,optionValue:offered.optionValue??String(i+1)}]:[];});
 if(new Set(candidates.map(a=>a.name.trim().toLocaleLowerCase('pt-BR'))).size!==candidates.length)return unsafe();
 const state=JSON.parse(JSON.stringify(old)) as RuntimeState;delete state.boxSelection;delete state.waiting;
 state.boxDirectory=BoxDirectorySnapshotSchema.parse({...directory,routes:directory.routes.map(r=>r.routeKey===route.routeKey?{...r,agents:candidates,backValue:r.backValue??String(r.agents.length+1)}:r)});
 state.nodeId=menu.id;
 if(!candidates.length){const back=context.graph.edges.find(e=>e.source===menu.id&&e.port==='back'),destination=context.graph.nodes.find(n=>n.id===back?.target);
  if(destination?.type!=='menu')return unsafe();state.nodeId=destination.id;}
 assertRuntimeState(state);
 return {state,notice:selected.language==='en'?'The selected attendant is unavailable. Please choose another available option.':'O atendente escolhido está indisponível. Escolha novamente entre as opções disponíveis.'};
}
export interface DirectoryHandoffRecovery {prepare(item:OutboxRow,op:HandoffOperation,account:AccountRow,catalog:AttendanceCatalog):Promise<{commit(tx:TenantTransaction):Promise<void>}>}
/** Only the caller's own PREPARED pause may be reversed. No remote mutation or UNKNOWN recovery. */
export function createDirectoryHandoffRecovery(options:HandoffTransactions&{repository:HandoffRepository;client(account:AccountRow):ChatwootClient}):DirectoryHandoffRecovery{
 return {async prepare(item,op,account,catalog){
  const s=op.snapshot;if(!s||op.phase!=='PREPARED'||op.state!=='PENDING'||s.routeTeamId===undefined)return unsafe();
  const context=await options.transact(op.organizationId,async tx=>{
   await options.repository.guard(tx,op,true);
   const row=(await tx.query<Context>(`SELECT e.state,v.graph FROM automation_executions e JOIN automation_versions v
     ON v.organization_id=e.organization_id AND v.automation_id=e.automation_id AND v.version=e.version
     WHERE e.organization_id=$1 AND e.id=$2 AND e.status='HANDOFF'`,[op.organizationId,op.executionId])).rows[0];
   if(!row)return unsafe();return row;
  });
  if(context.state.automationId!==s.automationId||context.state.version!==s.version)return unsafe();
  const members=await options.client(account).teamAgents(s.scope.accountId,s.routeTeamId);
  await options.transact(op.organizationId,tx=>options.repository.guard(tx,op,true));
  const plan=prepareDirectoryReoffer(context,{catalog,members,target:s.target,teamId:s.routeTeamId,scope:s.scope,credentialRevision:s.credentialRevision,nodeId:item.nodeId});
  return {async commit(tx){
   await options.repository.guard(tx,op,true);
   const gate=await readChatwootAttendanceGate(tx,{organizationId:op.organizationId,channelId:op.channelId,conversationId:op.conversationId});
   if(gate.state!=='PAUSED'||gate.revision!==s.controlRevision||gate.cycle!==s.cycle)return unsafe();
   if((await tx.query(`SELECT 1 FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND conversation_id=$2 AND cycle=$3 AND state IN('DISPATCHED','UNKNOWN') LIMIT 1`,[op.organizationId,op.conversationId,s.cycle])).rowCount)return unsafe();
   const restored=await tx.query<{attempts:number}>(`UPDATE automation_executions SET status='QUEUED',state=$3,current_node_id=$4,
     input='{"eventType":"RESUME","text":""}'::jsonb,completed_at=NULL,error_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE organization_id=$1 AND id=$2 AND status='HANDOFF' AND state=$5::jsonb RETURNING attempts`,
    [op.organizationId,op.executionId,JSON.stringify(plan.state),plan.state.nodeId,JSON.stringify(context.state)]);
   const attempts=restored.rows[0]?.attempts;if(!restored.rowCount||!Number.isSafeInteger(attempts)||attempts!<0||attempts!*1000+999>2147483647)return unsafe();
   const control=await tx.query(`UPDATE chatwoot_attendance_controls SET state='READY',revision=revision+1,updated_at=now()
     WHERE organization_id=$1 AND conversation_id=$2 AND revision=$3 AND state='PAUSED'`,[op.organizationId,op.conversationId,s.controlRevision]);
   const session=await tx.query(`UPDATE attendance_sessions SET state='BOT_ACTIVE',resume_node_id=$4,revision=revision+1,updated_at=now()
     WHERE organization_id=$1 AND id=$2 AND revision=$3 AND state='HANDOFF_PENDING' AND execution_id=$5`,[op.organizationId,s.sessionId,s.sessionRevision,plan.state.nodeId,op.executionId]);
   const conversation=await tx.query(`UPDATE messaging_conversations SET mode='BOT',attendance_revision=attendance_revision+1,updated_at=now()
     WHERE organization_id=$1 AND id=$2 AND channel_id=$3 AND mode='HUMAN'`,[op.organizationId,op.conversationId,op.channelId]);
   if(control.rowCount!==1||session.rowCount!==1||conversation.rowCount!==1)return unsafe();
   // Last reserved ordinal of the completed turn; next worker claim owns the following 1000-slot band.
   await tx.query(`INSERT INTO automation_outbox(organization_id,execution_id,node_id,ordinal,kind,payload)
     VALUES($1,$2,$3,$4,'SEND_TEXT',$5)`,[op.organizationId,op.executionId,'directory-reoffer',attempts!*1000+999,JSON.stringify({text:plan.notice})]);
   const operation=await tx.query(`UPDATE attendance_handoff_operations SET state='ACTION_REQUIRED',last_error='FLOW_BOX_AGENT_UNAVAILABLE_REOFFERED',updated_at=now()
     WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND phase='PREPARED' AND state='PENDING'`,[op.organizationId,op.id,op.leaseToken]);
   if(operation.rowCount!==1)return unsafe();
   // The outer outbox dispatcher settles the original FAILED effect in this same transaction.
  }};
 }};
}
