import { createHash } from 'node:crypto';
import { AUTOMATION_ORIGIN, AutomationGraphV1Schema, type AttendanceScope, type ResumeAttendanceInput, type ResumeOperationView, type ResumeTarget } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { RuntimeState } from '../automations/types.js';
import { readChatwootAccount, type AccountRow } from '../integrations/chatwoot-context.js';
import { lockAttendanceChannel, resolveAttendanceScope } from './repository.js';
import { AttendanceError } from './types.js';
import { isResumeRootState, validateResumeTarget } from './resume-policy.js';

export interface ResumeSnapshot {
  channelId:string; conversationId:string; ownerRevision:number; localRevision:number; controlRevision:number;
  bindingId:string; bindingRevision:number; automationId:string; version:number; activeVersion:number;
  sessionId:string|null; sessionRevision:number|null; cycle:number; target:ResumeTarget;
  scope:AttendanceScope|null; origin:string|null; credentialRevision:number|null; remoteConversationId:number|null;
  previousState:RuntimeState|null; originalTeamId?:number|null; originalStatus?:string; originalRemoteUpdatedAt?:number;
}
export interface ResumeRow extends ResumeOperationView {
  organizationId:string; actorId:string; channelId:string; snapshot:ResumeSnapshot; requestHash:string;
  phase:'PREPARED'|'CLEAR_AGENT'|'CLEAR_TEAM'|'PENDING_STATUS'|'READBACK'|'CONFIRMED';
  leaseToken:string|null; leaseExpiresAt:Date|null;
}
export const resumeColumns = `id,organization_id AS "organizationId",actor_id AS "actorId",channel_id AS "channelId",conversation_id AS "conversationId",
 state,session_id AS "sessionId",last_error AS "errorCode",snapshot,request_hash AS "requestHash",phase,lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt"`;
export const resumeView = (r:ResumeRow):ResumeOperationView => ({id:r.id,state:r.state,conversationId:r.conversationId,sessionId:r.sessionId,errorCode:r.errorCode});
export function resumeHash(input:ResumeAttendanceInput) {
  return createHash('sha256').update(JSON.stringify({conversationId:input.conversationId,expectedControlRevision:input.expectedControlRevision,
    expectedOwnerRevision:input.expectedOwnerRevision,target:input.target.kind==='MENU'?{kind:'MENU',nodeId:input.target.nodeId}:{kind:input.target.kind}})).digest('hex');
}
export async function readResumeRow(tx:TenantTransaction,org:string,id:string,lock=false) {
  return (await tx.query<ResumeRow>(`SELECT ${resumeColumns} FROM attendance_resume_operations WHERE organization_id=$1 AND id=$2 ${lock?'FOR UPDATE':''}`,[org,id])).rows[0];
}
export async function requireResumeActor(tx:TenantTransaction,org:string,actor:string) {
  if(!(await tx.query<{allowed:boolean}>('SELECT attendance_resume_actor_allowed($1) AS allowed',[actor])).rows[0]?.allowed)
    throw new AttendanceError('ATTENDANCE_RESUME_FORBIDDEN',403);
}
export async function captureResume(tx:TenantTransaction,org:string,input:ResumeAttendanceInput):Promise<{snapshot:ResumeSnapshot;account:AccountRow|undefined}> {
  const conversation=(await tx.query<{channel_id:string}>('SELECT channel_id FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[org,input.conversationId])).rows[0];
  if(!conversation)throw new AttendanceError('CONVERSATION_NOT_FOUND',404);
  await lockAttendanceChannel(tx,org,conversation.channel_id);
  const c=(await tx.query<{
    channelId:string;localRevision:number;mode:string;deleting:boolean;botId:string;botOrigin:string;feature:boolean;
    ownerRevision:number;executor:string;ownerAutomation:string;ownerVersion:number;remoteBinding:string|null;
    bindingId:string;bindingRevision:number;bindingStatus:string;automationId:string;version:number;activeVersion:number;lifecycle:string;
    graph:unknown;runtimeVersion:number;controlDestination:number|null;controlAccount:string|null;controlInbox:string|null;controlRevision:number|null;controlIntegration:string|null;remoteId:string|null;controlCycle:number|null;
    sessionId:string|null;sessionRevision:number|null;sessionCycle:number|null;sessionExecution:string|null;sessionAutomation:string|null;sessionVersion:number|null;
  }>(`SELECT m.channel_id AS "channelId",m.attendance_revision AS "localRevision",m.mode,(ch.deleting_at IS NOT NULL) AS deleting,
    ch.bot_public_id AS "botId",ch.bot_origin_reference AS "botOrigin",f.enabled AS feature,
    o.revision AS "ownerRevision",o.executor,o.automation_id AS "ownerAutomation",o.version AS "ownerVersion",o.remote_binding_id AS "remoteBinding",
    b.id AS "bindingId",b.revision AS "bindingRevision",b.status AS "bindingStatus",b.automation_id AS "automationId",b.version,
    d.active_version AS "activeVersion",d.lifecycle_status AS lifecycle,v.graph,v.runtime_state_version AS "runtimeVersion",
    cc.destination_revision AS "controlDestination",cc.account_id AS "controlAccount",cc.inbox_id AS "controlInbox",cc.revision AS "controlRevision",cc.integration_id AS "controlIntegration",cc.remote_conversation_id AS "remoteId",cc.cycle AS "controlCycle",
    s.id AS "sessionId",s.revision AS "sessionRevision",s.cycle AS "sessionCycle",s.execution_id AS "sessionExecution",s.automation_id AS "sessionAutomation",s.version AS "sessionVersion"
    FROM messaging_conversations m JOIN messaging_channels ch ON ch.organization_id=m.organization_id AND ch.id=m.channel_id
    LEFT JOIN flow_features f ON f.organization_id=m.organization_id
    LEFT JOIN attendance_owners o ON o.organization_id=m.organization_id AND o.channel_id=m.channel_id
    LEFT JOIN automation_bindings b ON b.organization_id=m.organization_id AND b.channel_id=m.channel_id AND b.status IN ('ACTIVE','PAUSED')
    LEFT JOIN automation_definitions d ON d.organization_id=b.organization_id AND d.id=b.automation_id
    LEFT JOIN automation_versions v ON v.organization_id=b.organization_id AND v.automation_id=b.automation_id AND v.version=b.version
    LEFT JOIN chatwoot_attendance_controls cc ON cc.organization_id=m.organization_id AND cc.conversation_id=m.id
    LEFT JOIN attendance_sessions s ON s.organization_id=m.organization_id AND s.conversation_id=m.id AND s.state<>'RESOLVED'
    WHERE m.organization_id=$1 AND m.id=$2 FOR NO KEY UPDATE OF m`,[org,input.conversationId])).rows[0]!;
  if(c.ownerRevision!==input.expectedOwnerRevision)throw new AttendanceError('ATTENDANCE_OWNER_CHANGED',409);
  if((c.controlRevision??c.localRevision)!==input.expectedControlRevision)throw new AttendanceError('ATTENDANCE_REMOTE_CONTROL_CHANGED',409);
  if(c.deleting||!c.feature||c.executor!=='BROKER'||c.remoteBinding!==null||c.botOrigin!==AUTOMATION_ORIGIN||c.botId!==c.automationId||
    c.ownerAutomation!==c.automationId||c.ownerVersion!==c.version||c.bindingStatus!=='ACTIVE')throw new AttendanceError('ATTENDANCE_RESUME_OWNER_UNAVAILABLE',409);
  const graph=AutomationGraphV1Schema.safeParse(c.graph);
  const published=graph.success&&c.lifecycle==='PUBLISHED';
  const state=c.sessionExecution?(await tx.query<{state:RuntimeState}>('SELECT state FROM automation_executions WHERE organization_id=$1 AND id=$2',[org,c.sessionExecution])).rows[0]?.state:null;
  const validRoot=isResumeRootState(state,c.automationId,c.version,graph.success?graph.data:null,c.runtimeVersion);
  const compatible=Boolean(validRoot&&state.automationId===c.automationId&&state.version===c.version&&state.stack?.length===0&&state.waiting?.kind==='EVENT'&&
    graph.success&&graph.data.nodes.some(n=>n.id===state.waiting!.nodeId&&['input','menu'].includes(n.type))&&c.sessionAutomation===c.automationId&&c.sessionVersion===c.version);
  validateResumeTarget({target:input.target,hasActiveSession:c.sessionId!==null&&validRoot&&c.sessionAutomation===c.automationId&&c.sessionVersion===c.version,hasCompatibleCursor:compatible,hasPublishedAutomation:published,
    hasMenuNode:graph.success&&input.target.kind==='MENU'&&graph.data.nodes.some(n=>n.id===(input.target as {nodeId:string}).nodeId&&n.type==='menu')});
  const hasConnection=Boolean((await tx.query('SELECT 1 FROM chatwoot_connections WHERE organization_id=$1 AND channel_id=$2',[org,c.channelId])).rowCount);
  const scope=await resolveAttendanceScope(tx,org,c.channelId),account=scope?await readChatwootAccount(tx,org):undefined;
  if(hasConnection&&(!scope||!account||c.controlIntegration!==scope.integrationId||c.controlDestination!==scope.destinationRevision||Number(c.controlAccount)!==scope.accountId||Number(c.controlInbox)!==scope.inboxId||c.remoteId===null))throw new AttendanceError('ATTENDANCE_DESTINATION_NOT_READY',409);
  if(scope&&!(await tx.query('SELECT 1 FROM chatwoot_conversations WHERE organization_id=$1 AND conversation_id=$2 AND integration_id=$3 AND remote_conversation_id=$4',[org,input.conversationId,scope.integrationId,c.remoteId])).rowCount)
    throw new AttendanceError('ATTENDANCE_DESTINATION_NOT_READY',409);
  if((await tx.query(`SELECT 1 FROM automation_outbox x JOIN automation_executions e ON e.organization_id=x.organization_id AND e.id=x.execution_id
      WHERE e.organization_id=$1 AND e.conversation_id=$2 AND x.status IN ('UNKNOWN','SENDING')
    UNION ALL SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('UNKNOWN','SENDING')
    UNION ALL SELECT 1 FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('DISPATCHED','UNKNOWN')
    UNION ALL SELECT 1 FROM chatwoot_attendance_observations WHERE organization_id=$1 AND conversation_id=$2 AND disposition IN ('ECHO_PENDING','RECONCILE')`,[org,input.conversationId])).rowCount)
    throw new AttendanceError('ATTENDANCE_WORK_RECONCILIATION_REQUIRED',409);
  return {snapshot:{channelId:c.channelId,conversationId:input.conversationId,ownerRevision:c.ownerRevision,localRevision:c.localRevision,
    controlRevision:c.controlRevision??c.localRevision,bindingId:c.bindingId,bindingRevision:c.bindingRevision,automationId:c.automationId,version:c.version,activeVersion:c.activeVersion,
    sessionId:c.sessionId,sessionRevision:c.sessionRevision,cycle:c.sessionCycle??c.controlCycle??0,target:input.target,
    scope,origin:account?.base_url??null,credentialRevision:account?.credential_version??null,remoteConversationId:c.remoteId===null?null:Number(c.remoteId),
    previousState:input.target.kind==='NEW_SESSION'?null:state??null},account};
}
