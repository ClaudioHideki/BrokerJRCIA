import { randomUUID } from 'node:crypto';
import { AUTOMATION_ORIGIN, AutomationHandoffConfigV1Schema } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { OutboxRow } from '../automations/repository.js';
import { readChatwootAccount } from '../integrations/chatwoot-context.js';
import { interruptChatwootAttendance, readChatwootAttendanceGate } from './control-service.js';
import { lockAttendanceChannel, resolveAttendanceScope } from './repository.js';
import { NativeHandoffError, type HandoffOperation, type HandoffRepository, type HandoffSnapshot } from './handoff-types.js';

const columns=`id,organization_id AS "organizationId",outbox_id AS "outboxId",execution_id AS "executionId",channel_id AS "channelId",
 conversation_id AS "conversationId",lease_token AS "leaseToken",snapshot,phase,state,last_error AS error`;
interface Context {
  executionId:string; channelId:string; conversationId:string; automationId:string; version:number; executionStatus:string;
  bindingId:string; bindingRevision:number; bindingStatus:string; bindingAutomation:string; bindingVersion:number;
  ownerRevision:number; ownerExecutor:string; ownerAutomation:string|null; ownerVersion:number|null; remoteBinding:string|null;
  botPublicId:string|null; botOrigin:string|null; deleting:boolean; tenantStatus:string; featureEnabled:boolean;
  mode:string; controlRevision:number|null; controlState:string|null; cycle:number|null; remoteId:string|null;
  controlIntegration:string|null;controlDestination:number|null;controlAccount:string|null;controlInbox:string|null;
  mappedRemoteId:string|null; sessionId:string|null; sessionRevision:number|null; sessionState:string|null;
  sessionExecution:string|null; sessionCycle:number|null;
}
async function context(tx:TenantTransaction,org:string,executionId:string):Promise<Context|undefined> {
  return (await tx.query<Context>(`SELECT e.id AS "executionId",e.channel_id AS "channelId",e.conversation_id AS "conversationId",
    e.automation_id AS "automationId",e.version,e.status AS "executionStatus",e.binding_id AS "bindingId",
    b.revision AS "bindingRevision",b.status AS "bindingStatus",b.automation_id AS "bindingAutomation",b.version AS "bindingVersion",
    own.revision AS "ownerRevision",own.executor AS "ownerExecutor",own.automation_id AS "ownerAutomation",own.version AS "ownerVersion",own.remote_binding_id AS "remoteBinding",
    ch.bot_public_id AS "botPublicId",ch.bot_origin_reference AS "botOrigin",(ch.deleting_at IS NOT NULL) AS deleting,
    tenant.status AS "tenantStatus",feature.enabled AS "featureEnabled",m.mode,c.revision AS "controlRevision",c.state AS "controlState",
    c.cycle,c.remote_conversation_id AS "remoteId",cm.remote_conversation_id AS "mappedRemoteId",
    c.integration_id AS "controlIntegration",c.destination_revision AS "controlDestination",c.account_id AS "controlAccount",c.inbox_id AS "controlInbox",
    s.id AS "sessionId",s.revision AS "sessionRevision",s.state AS "sessionState",s.execution_id AS "sessionExecution",s.cycle AS "sessionCycle"
    FROM automation_executions e JOIN automation_bindings b ON b.organization_id=e.organization_id AND b.id=e.binding_id
    JOIN messaging_channels ch ON ch.organization_id=e.organization_id AND ch.id=e.channel_id
    JOIN organizations tenant ON tenant.id=e.organization_id
    LEFT JOIN flow_features feature ON feature.organization_id=e.organization_id
    LEFT JOIN attendance_owners own ON own.organization_id=e.organization_id AND own.channel_id=e.channel_id
    JOIN messaging_conversations m ON m.organization_id=e.organization_id AND m.id=e.conversation_id AND m.channel_id=e.channel_id
    LEFT JOIN chatwoot_attendance_controls c ON c.organization_id=e.organization_id AND c.conversation_id=e.conversation_id
    LEFT JOIN chatwoot_conversations cm ON cm.organization_id=e.organization_id AND cm.conversation_id=e.conversation_id AND cm.integration_id=c.integration_id
    LEFT JOIN attendance_sessions s ON s.organization_id=e.organization_id AND s.conversation_id=e.conversation_id AND s.state<>'RESOLVED'
    WHERE e.organization_id=$1 AND e.id=$2 FOR NO KEY UPDATE OF e`,[org,executionId])).rows[0];
}
function authority(c:Context) {
  return !c.deleting&&c.tenantStatus==='ACTIVE'&&c.featureEnabled&&c.executionStatus==='HANDOFF'&&
    ['ACTIVE','PAUSED'].includes(c.bindingStatus)&&c.bindingAutomation===c.automationId&&c.bindingVersion===c.version&&
    c.ownerExecutor==='BROKER'&&c.ownerAutomation===c.automationId&&c.ownerVersion===c.version&&c.remoteBinding===null&&
    c.botPublicId===c.automationId&&c.botOrigin===AUTOMATION_ORIGIN;
}
async function pause(tx:TenantTransaction,c:Context,org:string) {
  await interruptChatwootAttendance(tx,{organizationId:org,channelId:c.channelId,conversationId:c.conversationId},false);
}
async function insertFailure(tx:TenantTransaction,item:OutboxRow,c:Context,error:string):Promise<HandoffOperation> {
  await pause(tx,c,item.organizationId);
  const operation=(await tx.query<HandoffOperation>(`INSERT INTO attendance_handoff_operations(organization_id,outbox_id,execution_id,channel_id,conversation_id,lease_token,state,last_error)
    VALUES($1,$2,$3,$4,$5,$6,'ACTION_REQUIRED',$7) RETURNING ${columns}`,
    [item.organizationId,item.id,c.executionId,c.channelId,c.conversationId,item.leaseToken,error])).rows[0]!;
  await tx.query(`UPDATE automation_outbox SET status='FAILED',last_error=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN'`,[item.organizationId,item.id,error]);
  return operation;
}
async function observationAllowsSettlement(tx:TenantTransaction,op:HandoffOperation) {
  const s=op.snapshot!;
  // Matching control events are expected consequences, not proof of authorship.
  // Never forgive a human message, another target/status, unresolved observation,
  // or an unrelated local/manual revision because a later assignment matched.
  const rows=(await tx.query<{event:{kind:string;interruptsBot:boolean;status?:string;teamId?:number|null;assignee?:{kind:string;id?:number}};disposition:string}>(`
    SELECT o.event,o.disposition FROM chatwoot_attendance_observations o JOIN attendance_handoff_operations h
      ON h.organization_id=o.organization_id AND h.id=$2
    WHERE o.organization_id=$1 AND o.integration_id=$3 AND o.destination_revision=$4 AND o.account_id=$5 AND o.inbox_id=$6
      AND o.remote_conversation_id=$7 AND o.created_at>=h.created_at
    ORDER BY o.created_at,o.id`,[op.organizationId,op.id,s.scope.integrationId,s.scope.destinationRevision,s.scope.accountId,s.scope.inboxId,s.remoteConversationId])).rows;
  let expected=0;
  for(const row of rows){
    const e=row.event;
    if(['WAITING_MAP','ECHO_PENDING','RECONCILE'].includes(row.disposition))return false;
    if(!e.interruptsBot)continue;
    if(e.kind!=='CONVERSATION_CONTROL'||e.status!=='open')return false;
    if(s.target.teamId!==null?(e.teamId!==s.target.teamId||e.assignee?.kind!=='NONE'):
      (e.teamId!==null||e.assignee?.kind!=='HUMAN'||e.assignee.id!==s.target.agentId)){
      // The opening callback is recognized only by the admission hook. It is
      // IGNORED, leaves control unchanged, and cannot forgive a revision here.
      if(e.teamId===null&&e.assignee?.kind==='NONE'&&row.disposition==='IGNORED')continue;
      return false;
    }
    if(row.disposition==='APPLIED')expected++;
  }
  return expected;
}

export function createPostgresHandoffRepository():HandoffRepository {
  return {
    async prepare(tx,item) {
      if(item.kind!=='HANDOFF'||!item.conversationId)return {result:{kind:'FAILED',error:'HANDOFF_CONVERSATION_REQUIRED'}};
      await lockAttendanceChannel(tx,item.organizationId,item.channelId);
      const c=await context(tx,item.organizationId,item.executionId);
      if(!c||c.channelId!==item.channelId||c.conversationId!==item.conversationId)throw new NativeHandoffError('HANDOFF_SCOPE_MISMATCH');
      const prior=(await tx.query<HandoffOperation>(`SELECT ${columns} FROM attendance_handoff_operations WHERE organization_id=$1 AND outbox_id=$2 FOR UPDATE`,[item.organizationId,item.id])).rows[0];
      if(prior){
        if(prior.executionId!==item.executionId||prior.channelId!==item.channelId||prior.conversationId!==item.conversationId)throw new NativeHandoffError('HANDOFF_SCOPE_MISMATCH');
        return {operation:prior,fresh:false};
      }
      const row=(await tx.query<{payload:unknown;createdAt:Date;status:string}>(`SELECT payload,created_at AS "createdAt",status FROM automation_outbox
        WHERE organization_id=$1 AND id=$2 AND execution_id=$3 AND kind='HANDOFF' AND status='UNKNOWN' AND lease_token=$4 AND lease_expires_at>now() FOR UPDATE`,
        [item.organizationId,item.id,item.executionId,item.leaseToken])).rows[0];
      if(!row)throw new NativeHandoffError('HANDOFF_LEASE_LOST');
      const bad=async(error:string)=>({operation:await insertFailure(tx,item,c,error),fresh:true});
      const config=AutomationHandoffConfigV1Schema.safeParse(row.payload);
      if(!config.success)return bad('HANDOFF_DESTINATION_REQUIRED_REPUBLISH');
      if(!authority(c)||c.mode!=='BOT')return bad('HANDOFF_AUTHORITY_CHANGED');
      let scope;
      try{scope=await resolveAttendanceScope(tx,item.organizationId,item.channelId);}catch{return bad('HANDOFF_DESTINATION_NOT_READY');}
      const account=await readChatwootAccount(tx,item.organizationId);
      if(!scope||!account?.destination||account.status!=='READY'||account.destination.approvalStatus!=='APPROVED')return bad('HANDOFF_DESTINATION_NOT_READY');
      const d=config.data.destination;
      if(scope.integrationId!==d.integrationId||scope.destinationRevision!==d.destinationRevision||scope.accountId!==d.accountId||scope.inboxId!==d.inboxId||account.credential_version!==d.credentialRevision)
        return bad('HANDOFF_CONTEXT_CHANGED');
      const gate=await readChatwootAttendanceGate(tx,{organizationId:item.organizationId,channelId:c.channelId,conversationId:c.conversationId});
      const predecessors=(await tx.query<{status:string;messageState:string|null}>(`SELECT o.status,m.state AS "messageState" FROM automation_outbox o
        LEFT JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id::text=o.remote_reference
          AND m.channel_id=$3 AND m.conversation_id=$4 AND m.source='AUTOMATION' AND m.idempotency_key='automation:'||o.id::text
        WHERE o.organization_id=$1 AND o.execution_id=$2 AND o.kind='SEND_TEXT' AND o.ordinal<$5`,
        [item.organizationId,item.executionId,c.channelId,c.conversationId,item.ordinal])).rows;
      const uncertain=predecessors.some(p=>p.messageState==='UNKNOWN'||p.messageState==='SENDING');
      const failed=predecessors.some(p=>['FAILED','CANCELED'].includes(p.status)||p.messageState==='FAILED');
      const pending=predecessors.some(p=>p.status!=='SENT'||!['SENT','DELIVERED','READ'].includes(p.messageState??''));
      if(failed)return bad('HANDOFF_PREVIOUS_MESSAGE_FAILED');
      const ready=gate.allowed&&c.controlState==='READY'&&c.remoteId!==null&&c.remoteId===c.mappedRemoteId;
      if(!ready||pending) {
        if(['HUMAN','PAUSED','RECONCILE'].includes(gate.state))return bad('HANDOFF_REMOTE_CONTROL_CHANGED');
        if(Date.now()-new Date(row.createdAt).getTime()<120000)return {result:{kind:'NOT_SENT',error:uncertain?'HANDOFF_PREVIOUS_MESSAGE_UNCERTAIN':pending?'HANDOFF_WAITING_MESSAGE_DELIVERY':'HANDOFF_WAITING_CONVERSATION_MAP',retryAt:new Date(Date.now()+2000)}};
        return bad(uncertain?'HANDOFF_PREVIOUS_MESSAGE_UNCERTAIN':pending?'HANDOFF_MESSAGE_DELIVERY_TIMEOUT':'HANDOFF_CONVERSATION_MAP_TIMEOUT');
      }
      if(c.sessionId&&(c.sessionCycle!==c.cycle||c.sessionExecution!==null&&c.sessionExecution!==c.executionId||!['BOT_ACTIVE','WAITING_INPUT','HANDOFF_PENDING'].includes(c.sessionState??'')))
        return bad('HANDOFF_SESSION_CHANGED');
      await pause(tx,c,item.organizationId);
      const session=(await tx.query<{id:string;revision:number}>(`INSERT INTO attendance_sessions(organization_id,id,channel_id,conversation_id,integration_id,destination_revision,
        account_id,inbox_id,cycle,execution_id,automation_id,version,state,owner_revision,remote_conversation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'HANDOFF_PENDING',$13,$14)
        ON CONFLICT(organization_id,conversation_id,cycle) DO UPDATE SET state='HANDOFF_PENDING',execution_id=EXCLUDED.execution_id,
          automation_id=EXCLUDED.automation_id,version=EXCLUDED.version,owner_revision=EXCLUDED.owner_revision,
          integration_id=EXCLUDED.integration_id,destination_revision=EXCLUDED.destination_revision,account_id=EXCLUDED.account_id,inbox_id=EXCLUDED.inbox_id,
          remote_conversation_id=EXCLUDED.remote_conversation_id,revision=attendance_sessions.revision+1,updated_at=now()
        RETURNING id,revision`,[item.organizationId,c.sessionId??randomUUID(),c.channelId,c.conversationId,scope.integrationId,scope.destinationRevision,scope.accountId,scope.inboxId,
        c.cycle,c.executionId,c.automationId,c.version,c.ownerRevision,Number(c.remoteId)])).rows[0]!;
      const control=(await tx.query<{revision:number}>(`UPDATE chatwoot_attendance_controls SET state='PAUSED',revision=revision+1,updated_at=now()
        WHERE organization_id=$1 AND conversation_id=$2 RETURNING revision`,[item.organizationId,c.conversationId])).rows[0]!;
      const snapshot:HandoffSnapshot={scope,origin:account.base_url,credentialRevision:account.credential_version,bindingId:c.bindingId,bindingRevision:c.bindingRevision,
        automationId:c.automationId,version:c.version,ownerRevision:c.ownerRevision,controlRevision:control.revision,sessionId:session.id,sessionRevision:session.revision,
        cycle:c.cycle!,remoteConversationId:Number(c.remoteId),target:config.data.target};
      const operation=(await tx.query<HandoffOperation>(`INSERT INTO attendance_handoff_operations(organization_id,outbox_id,execution_id,channel_id,conversation_id,integration_id,lease_token,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,[item.organizationId,item.id,c.executionId,c.channelId,c.conversationId,scope.integrationId,item.leaseToken,JSON.stringify(snapshot)])).rows[0]!;
      return {operation,fresh:true};
    },
    async guard(tx,op,requireLease,settlement=false) {
      if(!op.snapshot||op.snapshot.scope.organizationId!==op.organizationId||op.snapshot.scope.channelId!==op.channelId)throw new NativeHandoffError('HANDOFF_SCOPE_MISMATCH');
      const s=op.snapshot;
      await lockAttendanceChannel(tx,op.organizationId,op.channelId);
      const c=await context(tx,op.organizationId,op.executionId);
      const live=(await tx.query<{phase:string;state:string}>(`SELECT h.phase,h.state FROM attendance_handoff_operations h JOIN automation_outbox o
        ON o.organization_id=h.organization_id AND o.id=h.outbox_id AND o.execution_id=h.execution_id
        WHERE h.organization_id=$1 AND h.id=$2 AND h.lease_token=$3 AND o.status='UNKNOWN'
          AND (NOT $4 OR (o.lease_token=$3 AND o.lease_expires_at>now())) FOR UPDATE OF h,o`,[op.organizationId,op.id,op.leaseToken,requireLease])).rows[0];
      if(!live||live.state==='ACTION_REQUIRED'||live.state==='APPLIED'||live.phase!==op.phase)throw new NativeHandoffError('HANDOFF_LEASE_LOST');
      if(!c||!authority(c)||c.channelId!==op.channelId||c.conversationId!==op.conversationId||c.bindingId!==s.bindingId||c.bindingRevision!==s.bindingRevision||
        c.automationId!==s.automationId||c.version!==s.version||c.ownerRevision!==s.ownerRevision||c.mode!=='HUMAN'||
        c.controlIntegration!==s.scope.integrationId||c.controlDestination!==s.scope.destinationRevision||Number(c.controlAccount)!==s.scope.accountId||Number(c.controlInbox)!==s.scope.inboxId||
        c.cycle!==s.cycle||Number(c.remoteId)!==s.remoteConversationId||c.remoteId!==c.mappedRemoteId||c.sessionId!==s.sessionId||c.sessionCycle!==s.cycle)
        throw new NativeHandoffError('HANDOFF_AUTHORITY_CHANGED');
      const scope=await resolveAttendanceScope(tx,op.organizationId,op.channelId),account=await readChatwootAccount(tx,op.organizationId);
      if(!scope||Object.entries(s.scope).some(([key,value])=>scope[key as keyof typeof scope]!==value)||
        !account||account.base_url!==s.origin||account.credential_version!==s.credentialRevision||account.status!=='READY'||account.destination?.approvalStatus!=='APPROVED')
        throw new NativeHandoffError('HANDOFF_CONTEXT_CHANGED');
      if(c.controlRevision!==s.controlRevision||c.controlState!=='PAUSED'||c.sessionRevision!==s.sessionRevision||c.sessionState!=='HANDOFF_PENDING') {
        const expected=settlement&&op.phase!=='PREPARED'?await observationAllowsSettlement(tx,op):false;
        if(!expected||c.controlRevision!==s.controlRevision+expected||c.sessionRevision!==s.sessionRevision+(s.target.agentId!==null?1:0)||
          !['HUMAN','PAUSED'].includes(c.controlState??'')||!['HANDOFF_PENDING','HUMAN_ACTIVE'].includes(c.sessionState??''))
          throw new NativeHandoffError('HANDOFF_HUMAN_CONTROL_CHANGED');
      }
      // Pending attribution is not permission to dispatch, even if its callback
      // has not yet acquired the channel lock to change the control revision.
      if((await tx.query(`SELECT 1 FROM chatwoot_attendance_observations WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3
        AND account_id=$4 AND inbox_id=$5 AND remote_conversation_id=$6 AND disposition IN ('ECHO_PENDING','RECONCILE','WAITING_MAP') LIMIT 1`,
        [op.organizationId,s.scope.integrationId,s.scope.destinationRevision,s.scope.accountId,s.scope.inboxId,s.remoteConversationId])).rowCount)
        throw new NativeHandoffError('HANDOFF_OBSERVATION_PENDING');
      return account;
    },
    async stage(tx,op,phase) {
      const allowed=(op.phase==='PREPARED'&&phase==='OPEN_DISPATCHED')||(op.phase==='OPEN_DISPATCHED'&&phase==='OPENED')||(op.phase==='OPENED'&&phase==='ASSIGNMENT_DISPATCHED');
      if(!allowed)throw new NativeHandoffError('HANDOFF_PHASE_CHANGED');
      const row=(await tx.query<HandoffOperation>(`UPDATE attendance_handoff_operations SET phase=$4,state=$5,updated_at=now(),next_check_at=now()+interval '30 seconds'
        WHERE organization_id=$1 AND id=$2 AND phase=$3 AND state IN ('PENDING','UNKNOWN') RETURNING ${columns}`,
        [op.organizationId,op.id,op.phase,phase,phase==='OPENED'?'PENDING':'UNKNOWN'])).rows[0];
      if(!row)throw new NativeHandoffError('HANDOFF_PHASE_CHANGED');return row;
    },
    async fail(tx,op,error,uncertain) {
      await tx.query(`UPDATE attendance_handoff_operations SET state=$3,last_error=$4,updated_at=now(),next_check_at=now()+interval '30 seconds'
        WHERE organization_id=$1 AND id=$2 AND state<>'APPLIED'`,[op.organizationId,op.id,uncertain?'UNKNOWN':'ACTION_REQUIRED',error]);
      await tx.query(`UPDATE automation_outbox SET last_error=$3,status=CASE WHEN $4 THEN status ELSE 'FAILED' END,
        lease_token=CASE WHEN $4 THEN lease_token ELSE NULL END,lease_expires_at=CASE WHEN $4 THEN lease_expires_at ELSE NULL END,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN'`,[op.organizationId,op.outboxId,error,uncertain]);
    },
    async confirm(tx,op,evidence='DISPATCH_READBACK') {
      await this.guard(tx,op,false,true);
      await tx.query(`UPDATE attendance_handoff_operations SET state='APPLIED',phase='CONFIRMED',confirmed_by=$3,last_error=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2`,[op.organizationId,op.id,evidence]);
      await tx.query(`UPDATE automation_outbox SET status='SENT',remote_reference=$3,last_error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN'`,[op.organizationId,op.outboxId,`chatwoot-handoff:${op.id}`]);
      // HUMAN_ACTIVE established by a real callback is never downgraded; neither
      // a successful handoff nor reconciliation ever returns a conversation to BOT.
      await tx.query(`UPDATE attendance_sessions SET state='WAITING_HUMAN',revision=revision+1,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND state='HANDOFF_PENDING'`,[op.organizationId,op.snapshot!.sessionId]);
    },
    async next(tx,org) {
      // A crash can happen after outbox reservation but before ledger admission.
      // Without a ledger no HTTP was authorized; fail closed locally rather than
      // replaying the claimed effect or leaving it permanently undiscoverable.
      const orphan=(await tx.query<OutboxRow>(`SELECT o.id,o.organization_id AS "organizationId",o.execution_id AS "executionId",
        e.channel_id AS "channelId",e.conversation_id AS "conversationId",o.node_id AS "nodeId",o.ordinal,o.kind,o.payload,o.attempts,o.lease_token AS "leaseToken"
        FROM automation_outbox o JOIN automation_executions e ON e.organization_id=o.organization_id AND e.id=o.execution_id
        WHERE o.organization_id=$1 AND o.kind='HANDOFF' AND o.status='UNKNOWN'
          AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=now())
          AND NOT EXISTS(SELECT 1 FROM attendance_handoff_operations h WHERE h.organization_id=o.organization_id AND h.outbox_id=o.id)
        ORDER BY o.created_at,o.id LIMIT 1`,[org])).rows[0];
      if(orphan){
        await lockAttendanceChannel(tx,org,orphan.channelId);
        const c=await context(tx,org,orphan.executionId);
        const reserved=(await tx.query(`SELECT id FROM automation_outbox WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN'
          AND (lease_expires_at IS NULL OR lease_expires_at<=now()) FOR UPDATE SKIP LOCKED`,[org,orphan.id])).rowCount;
        const exists=(await tx.query('SELECT 1 FROM attendance_handoff_operations WHERE organization_id=$1 AND outbox_id=$2',[org,orphan.id])).rowCount;
        if(reserved&&!exists){
          if(c&&orphan.conversationId)return insertFailure(tx,{...orphan,leaseToken:orphan.leaseToken??randomUUID()},c,'HANDOFF_INTERRUPTED_BEFORE_ADMISSION');
          await tx.query(`UPDATE automation_outbox SET status='FAILED',last_error='HANDOFF_CONVERSATION_REQUIRED',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN'`,[org,orphan.id]);
        }
      }
      return (await tx.query<HandoffOperation>(`SELECT ${columns.split(',').map(part=>`h.${part.trim()}`).join(',')}
        FROM attendance_handoff_operations h WHERE h.organization_id=$1 AND h.state IN ('PENDING','UNKNOWN') AND h.next_check_at<=now()
        AND EXISTS(SELECT 1 FROM automation_outbox o WHERE o.organization_id=h.organization_id AND o.id=h.outbox_id
          AND o.status='UNKNOWN' AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=now())) ORDER BY h.next_check_at,h.id LIMIT 1`,[org])).rows[0]??null;
    },
  };
}
