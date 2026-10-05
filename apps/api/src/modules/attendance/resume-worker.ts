import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ResumeOperationView } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { readChatwootAccount,type AccountRow } from '../integrations/chatwoot-context.js';
import type { ChatwootClient } from '../integrations/chatwoot-client.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { captureResume, readResumeRow, requireResumeActor, resumeView, type ResumeRow, type ResumeSnapshot } from './resume-repository.js';
import type { ResumeServiceOptions } from './resume-service.js';
import { lockAttendanceChannel,resolveAttendanceScope } from './repository.js';
import { AttendanceError } from './types.js';

type Options=ResumeServiceOptions & {client?(account:AccountRow):ChatwootClient};
const safeError=(error:unknown,fallback:string)=>error instanceof AttendanceError?error.code:fallback;
function sameSnapshot(a:ResumeSnapshot,b:ResumeSnapshot) {
  const stable=(s:ResumeSnapshot)=>({channelId:s.channelId,conversationId:s.conversationId,ownerRevision:s.ownerRevision,localRevision:s.localRevision,
    controlRevision:s.controlRevision,bindingId:s.bindingId,bindingRevision:s.bindingRevision,automationId:s.automationId,version:s.version,activeVersion:s.activeVersion,
    sessionId:s.sessionId,sessionRevision:s.sessionRevision,cycle:s.cycle,scope:s.scope,origin:s.origin,credentialRevision:s.credentialRevision,remoteConversationId:s.remoteConversationId});
  // PostgreSQL jsonb reorders object keys; ordering is not an authority revision.
  return isDeepStrictEqual(stable(a),stable(b));
}
export function createAttendanceResumeWorker(options:Options) {
  async function guarded(tx:TenantTransaction,op:ResumeRow,lease:string) {
    await requireActiveOrganization(tx,op.organizationId);await lockAttendanceChannel(tx,op.organizationId,op.channelId);
    const current=await readResumeRow(tx,op.organizationId,op.id,true);
    if(!current||current.state!=='PENDING'||current.leaseToken!==lease||!current.leaseExpiresAt||current.leaseExpiresAt.getTime()<=Date.now())
      throw new AttendanceError('ATTENDANCE_RESUME_LEASE_LOST',409);
    await requireResumeActor(tx,op.organizationId,current.actorId);
    const s=current.snapshot;
    const context=await captureResume(tx,op.organizationId,{conversationId:op.conversationId,expectedControlRevision:s.controlRevision,expectedOwnerRevision:s.ownerRevision,target:s.target});
    const mode=(await tx.query<{mode:string}>('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[op.organizationId,op.conversationId])).rows[0]?.mode;
    if(mode!=='HUMAN'||!sameSnapshot(s,context.snapshot))throw new AttendanceError('ATTENDANCE_RESUME_CONTEXT_CHANGED',409);
    return {op:current,account:context.account};
  }
  async function finish(op:ResumeRow,state:'UNKNOWN'|'ACTION_REQUIRED'|'CANCELED',error:string,lease:string) {
    return options.transact(op.organizationId,async tx=>{
      await tx.query(`UPDATE attendance_resume_operations SET state=$4,last_error=$5,lease_token=null,lease_expires_at=null,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND state='PENDING'`,[op.organizationId,op.id,lease,state,error]);
      const current=await readResumeRow(tx,op.organizationId,op.id);return resumeView(current!);
    });
  }
  async function phase(op:ResumeRow,lease:string,next:ResumeRow['phase']) {
    await options.transact(op.organizationId,async tx=>{
      await guarded(tx,op,lease);
      await tx.query('UPDATE attendance_resume_operations SET phase=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3',[op.organizationId,op.id,lease,next]);
    });
  }
  async function confirm(op:ResumeRow,lease:string,watermark:number|null):Promise<ResumeOperationView> {
    return options.transact(op.organizationId,async tx=>{
      const {op:current}=await guarded(tx,op,lease),s=current.snapshot,org=op.organizationId;
      // Lock execution tree before updating sessions/conversation. Preserve audit and unknown effects.
      await tx.query('SELECT id FROM automation_executions WHERE organization_id=$1 AND conversation_id=$2 ORDER BY id FOR NO KEY UPDATE',[org,op.conversationId]);
      await tx.query(`UPDATE automation_events SET status='IGNORED',consumed_at=now() WHERE organization_id=$1 AND status='PENDING'
        AND execution_id IN (SELECT id FROM automation_executions WHERE organization_id=$1 AND conversation_id=$2)`,[org,op.conversationId]);
      await tx.query("UPDATE automation_executions SET status='CANCELED',completed_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND status IN ('HANDOFF','FAILED')",[org,op.conversationId]);
      const maximum=(await tx.query<{cycle:number}>('SELECT coalesce(max(cycle),0)::int AS cycle FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$2',[org,op.conversationId])).rows[0]!.cycle;
      const cycle=Math.max(maximum,s.cycle)+1,execution=randomUUID(),session=randomUUID();
      const state=s.target.kind==='NEW_SESSION'?{}:s.target.kind==='MENU'
        ?{...s.previousState!,nodeId:s.target.nodeId,waiting:undefined,stack:[]}:s.previousState!;
      const waiting=s.target.kind==='CONTINUE';
      await tx.query(`INSERT INTO automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status,input,state,current_node_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{"text":"","eventType":"RESUME"}'::jsonb,$11,$12)`,
        [org,execution,s.automationId,s.version,s.bindingId,s.channelId,s.conversationId,`attendance-resume:${op.id}`,randomUUID(),waiting?'WAITING':'QUEUED',JSON.stringify(state),s.target.kind==='MENU'?s.target.nodeId:waiting?s.previousState!.nodeId:null]);
      if(waiting)await tx.query(`INSERT INTO automation_waits(organization_id,execution_id,node_id,kind,state) VALUES($1,$2,$3,'EVENT',$4)`,[org,execution,s.previousState!.waiting!.nodeId,JSON.stringify(state)]);
      await tx.query("UPDATE attendance_sessions SET state='RESOLVED',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND state<>'RESOLVED'",[org,s.conversationId]);
      await tx.query(`INSERT INTO attendance_sessions(organization_id,id,channel_id,conversation_id,integration_id,destination_revision,account_id,inbox_id,cycle,execution_id,automation_id,version,state,owner_revision,remote_conversation_id,resume_node_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[org,session,s.channelId,s.conversationId,s.scope?.integrationId??null,s.scope?.destinationRevision??null,s.scope?.accountId??null,s.scope?.inboxId??null,
          cycle,execution,s.automationId,s.version,waiting?'WAITING_INPUT':'BOT_ACTIVE',s.ownerRevision,s.remoteConversationId,waiting?s.previousState!.waiting!.nodeId:s.target.kind==='MENU'?s.target.nodeId:null]);
      if(s.scope)await tx.query("UPDATE chatwoot_attendance_controls SET state='READY',cycle=$3,revision=revision+1,observed_remote_updated_at=$4,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2",[org,s.conversationId,cycle,watermark]);
      await tx.query("UPDATE messaging_conversations SET mode='BOT',attendance_revision=attendance_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2",[org,s.conversationId]);
      await tx.query("UPDATE attendance_resume_operations SET state='APPLIED',phase='CONFIRMED',session_id=$4,last_error=null,lease_token=null,lease_expires_at=null,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3",[org,op.id,lease,session]);
      return resumeView((await readResumeRow(tx,org,op.id))!);
    });
  }
  async function processAttendanceResume(id:string,org:string):Promise<ResumeOperationView> {
    const lease=randomUUID();
    const claimed=await options.transact(org,async tx=>{
      const initial=await readResumeRow(tx,org,id);if(!initial)throw new AttendanceError('ATTENDANCE_RESUME_NOT_FOUND',404);
      await lockAttendanceChannel(tx,org,initial.channelId);const op=(await readResumeRow(tx,org,id,true))!;
      if(op.state==='UNKNOWN'||op.state==='PENDING'&&op.phase!=='PREPARED'&&(!op.leaseExpiresAt||op.leaseExpiresAt.getTime()<=Date.now())){
        // Stock remote APIs cannot prove authorship after timeout/crash. Never replay their writes.
        return {op,claimed:false,reconcile:true};
      }
      if(op.state!=='PENDING'||op.leaseExpiresAt&&op.leaseExpiresAt.getTime()>Date.now())return {op,claimed:false};
      await tx.query("UPDATE attendance_resume_operations SET lease_token=$3,lease_expires_at=now()+interval '120 seconds' WHERE organization_id=$1 AND id=$2",[org,id,lease]);
      return {op:(await readResumeRow(tx,org,id))!,claimed:true};
    });
    const op=claimed.op;
    if('reconcile' in claimed){
      // A canonical read proves current state, not authorship or completion of an earlier in-flight command.
      let observed=false,ready=false;
      try{
        const account=await options.transact(org,async tx=>{
          await requireActiveOrganization(tx,org);
          const scope=await resolveAttendanceScope(tx,org,op.channelId),current=await readChatwootAccount(tx,org);
          if(!isDeepStrictEqual(scope,op.snapshot.scope)||current?.base_url!==op.snapshot.origin||current.credential_version!==op.snapshot.credentialRevision)return undefined;
          return current;
        });
        if(account&&options.client&&op.snapshot.scope){const s=op.snapshot.scope;
          const canonical=await options.client(account).attendanceConversation(s.accountId,op.snapshot.remoteConversationId!);
          observed=canonical.id===op.snapshot.remoteConversationId&&canonical.account_id===s.accountId&&canonical.inbox_id===s.inboxId;
          ready=observed&&canonical.status==='pending'&&canonical.meta.assignee===null&&canonical.meta.team===null;
        }
      }catch{/* Preserve the fence when the authoritative read is unavailable. */}
      return options.transact(org,async tx=>{
        await tx.query("UPDATE attendance_resume_operations SET state='ACTION_REQUIRED',last_error='ATTENDANCE_RESUME_REMOTE_PROOF_REQUIRED',lease_token=null,lease_expires_at=null,snapshot=snapshot||$3::jsonb,updated_at=now() WHERE organization_id=$1 AND id=$2 AND state IN ('PENDING','UNKNOWN')",
          [org,id,JSON.stringify({reconciliation:{observed,ready,checkedAt:new Date().toISOString()}})]);
        return resumeView((await readResumeRow(tx,org,id))!);
      });
    }
    if(!claimed.claimed)return resumeView(op);
    let dispatched=false;
    let watermark:number|null=null;
    try{
      const {account}=await options.transact(org,tx=>guarded(tx,op,lease));
      const s=op.snapshot;
      if(s.scope){
        if(!account||!options.client)throw new AttendanceError('ATTENDANCE_RESUME_REMOTE_UNAVAILABLE',409);
        const client=options.client(account),scope=s.scope,remote=s.remoteConversationId!;
        const inbox=await client.attendanceInbox(scope.accountId,scope.inboxId),bot=await client.inboxFlowBot(scope.accountId,scope.inboxId);
        if(inbox.id!==scope.inboxId||inbox.channel_type!=='Channel::Api')throw new AttendanceError('ATTENDANCE_SCOPE_CHANGED',409);
        if(inbox.greeting_enabled!==false)throw new AttendanceError('ATTENDANCE_DISABLE_INBOX_GREETING',409);
        if(inbox.enable_auto_assignment!==false)throw new AttendanceError('ATTENDANCE_DISABLE_INBOX_AUTO_ASSIGNMENT',409);
        if(bot!==null)throw new AttendanceError('ATTENDANCE_REMOVE_COMPETING_AGENT_BOT',409);
        const before=await client.attendanceConversation(scope.accountId,remote);
        if(before.inbox_id!==scope.inboxId||before.updated_at===undefined)throw new AttendanceError('ATTENDANCE_RESUME_REMOTE_CONTROL_UNVERIFIED',409);
        if(before.meta.assignee_type==='AgentBot'||before.meta.assignee!==null&&before.meta.assignee.type!=='user'&&before.meta.assignee_type!=='User')throw new AttendanceError('ATTENDANCE_REMOVE_COMPETING_AGENT_BOT',409);
        await options.transact(org,async tx=>{await guarded(tx,op,lease);await tx.query("UPDATE attendance_resume_operations SET snapshot=snapshot||$3::jsonb WHERE organization_id=$1 AND id=$2",[org,id,JSON.stringify({originalTeamId:before.meta.team?.id??null,originalStatus:before.status,originalRemoteUpdatedAt:before.updated_at})]);});
        await phase(op,lease,'CLEAR_AGENT');dispatched=true;await client.clearAttendanceAssignment(scope.accountId,remote,'AGENT');
        await phase(op,lease,'CLEAR_TEAM');await client.clearAttendanceAssignment(scope.accountId,remote,'TEAM');
        await phase(op,lease,'PENDING_STATUS');await client.pendingAttendanceConversation(scope.accountId,remote);
        await phase(op,lease,'READBACK');
        const after=await client.attendanceConversation(scope.accountId,remote);
        if(after.inbox_id!==scope.inboxId||after.status!=='pending'||after.meta.assignee!==null||after.meta.team!==null||after.updated_at===undefined||after.updated_at<before.updated_at)
          throw new AttendanceError('ATTENDANCE_RESUME_REMOTE_NOT_READY',409);
        watermark=after.updated_at;
      }
      return await confirm(op,lease,watermark);
    }catch(error){
      const code=safeError(error,dispatched?'ATTENDANCE_RESUME_REMOTE_RESULT_UNKNOWN':'ATTENDANCE_RESUME_REMOTE_UNAVAILABLE');
      return finish(op,error instanceof AttendanceError?(dispatched?'CANCELED':'ACTION_REQUIRED'):dispatched?'UNKNOWN':'ACTION_REQUIRED',code,lease);
    }
  }
  return {processAttendanceResume,async runOnce(org:string){
    const ids=await options.transact(org,async tx=>(await tx.query<{id:string}>("SELECT id FROM attendance_resume_operations WHERE organization_id=$1 AND state IN ('PENDING','UNKNOWN') ORDER BY created_at,id LIMIT 5",[org])).rows);
    for(const item of ids)await processAttendanceResume(item.id,org);return {processed:ids.length};
  }};
}
