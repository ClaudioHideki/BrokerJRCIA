import { randomUUID } from 'node:crypto';
import { AutomationLocalHandoffConfigV2Schema } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { OutboxRow } from '../automations/repository.js';
import type { OutboxDispatchResult } from '../automations/service.js';
import { assertStandaloneDestination } from './destination-adapter.js';
import { lockAttendanceChannel } from './repository.js';
import { runtimeAuthorityAllows } from './runtime-authority.js';
import { interruptChatwootAttendance } from './control-service.js';
import { AttendanceError } from './types.js';

/** No external effect: session, pause and receipt commit together. An existing
 * SENT receipt is proof of this local transaction, not a remote delivery claim. */
export function createLocalHandoffService(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}){
 return {dispatch:async(item:OutboxRow):Promise<OutboxDispatchResult>=>options.transact(item.organizationId,async tx=>{
  if(item.kind!=='HANDOFF'||!item.conversationId)return {kind:'FAILED',error:'HANDOFF_CONVERSATION_REQUIRED'};
  await lockAttendanceChannel(tx,item.organizationId,item.channelId);
  const execution=(await tx.query<{automationId:string;version:number;status:string;channelId:string;conversationId:string;bindingId:string}>(
   `SELECT automation_id AS "automationId",version,status,channel_id AS "channelId",conversation_id AS "conversationId",binding_id AS "bindingId"
    FROM automation_executions WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE`,[item.organizationId,item.executionId])).rows[0];
  if(!execution||execution.channelId!==item.channelId||execution.conversationId!==item.conversationId)throw new AttendanceError('HANDOFF_SCOPE_MISMATCH',409);
  const row=(await tx.query<{payload:unknown;status:string;receipt:string|null;validLease:boolean;createdAt:Date}>(
   `SELECT payload,status,remote_reference AS receipt,(lease_token=$4 AND lease_expires_at>now()) AS "validLease",created_at AS "createdAt"
    FROM automation_outbox WHERE organization_id=$1 AND id=$2 AND execution_id=$3 AND kind='HANDOFF' FOR UPDATE`,
   [item.organizationId,item.id,item.executionId,item.leaseToken])).rows[0];
  const receipt=`local-handoff:${item.id}`;
  if(row?.status==='SENT'&&row.receipt===receipt)return {kind:'SENT',remoteReference:receipt};
  if(!row||row.status!=='UNKNOWN'||!row.validLease)throw new AttendanceError('HANDOFF_LEASE_LOST',409);
  const fail=async(error:string):Promise<OutboxDispatchResult>=>{
   await interruptChatwootAttendance(tx,{organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId!},false);
   await tx.query("UPDATE automation_outbox SET status='FAILED',last_error=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2",[item.organizationId,item.id,error]);
   return {kind:'FAILED',error};
  };
  const config=AutomationLocalHandoffConfigV2Schema.safeParse(row.payload);
  if(!config.success)return fail('HANDOFF_DESTINATION_REQUIRED_REPUBLISH');
  if(config.data.destination.organizationId!==item.organizationId||config.data.destination.channelId!==item.channelId)return fail('HANDOFF_SCOPE_MISMATCH');
  try{await assertStandaloneDestination(tx,item.organizationId,item.channelId);}
  catch(error){if(error instanceof AttendanceError)return fail(error.code);throw error;}
  const binding=(await tx.query(`SELECT 1 FROM automation_bindings WHERE organization_id=$1 AND id=$2
    AND channel_id=$3 AND automation_id=$4 AND version=$5 AND status IN ('ACTIVE','PAUSED')`,
    [item.organizationId,execution.bindingId,item.channelId,execution.automationId,execution.version])).rowCount;
  if(!binding||execution.status!=='HANDOFF'||!await runtimeAuthorityAllows(tx,{...item,automationId:execution.automationId,version:execution.version},false))return fail('HANDOFF_AUTHORITY_CHANGED');
  const predecessors=(await tx.query<{status:string;messageState:string|null}>(`SELECT o.status,m.state AS "messageState"
   FROM automation_outbox o LEFT JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id::text=o.remote_reference
    AND m.channel_id=$3 AND m.conversation_id=$4 AND m.source='AUTOMATION' AND m.idempotency_key='automation:'||o.id::text
   WHERE o.organization_id=$1 AND o.execution_id=$2 AND o.kind='SEND_TEXT' AND o.ordinal<$5`,
   [item.organizationId,item.executionId,item.channelId,item.conversationId,item.ordinal])).rows;
  if(predecessors.some(p=>['FAILED','CANCELED'].includes(p.status)||p.messageState==='FAILED'))return fail('HANDOFF_PREVIOUS_MESSAGE_FAILED');
  if(predecessors.some(p=>p.status!=='SENT'||!['SENT','DELIVERED','READ'].includes(p.messageState??''))){
   if(Date.now()-new Date(row.createdAt).getTime()>=120000)return fail('HANDOFF_MESSAGE_DELIVERY_TIMEOUT');
   return {kind:'NOT_SENT',error:'HANDOFF_WAITING_MESSAGE_DELIVERY',retryAt:new Date(Date.now()+2000)};
  }
  const session=(await tx.query<{id:string;cycle:number;state:string;executionId:string|null}>(`SELECT id,cycle,state,execution_id AS "executionId"
    FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$2 AND state<>'RESOLVED' FOR UPDATE`,[item.organizationId,item.conversationId])).rows[0];
  if(session&&(!['BOT_ACTIVE','WAITING_INPUT'].includes(session.state)||session.executionId!==null&&session.executionId!==item.executionId))return fail('HANDOFF_SESSION_CHANGED');
  const cycle=session?.cycle??Number((await tx.query<{cycle:number}>('SELECT coalesce(max(cycle),0)+1 AS cycle FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$2',[item.organizationId,item.conversationId])).rows[0]!.cycle);
  const owner=(await tx.query<{revision:number}>('SELECT revision FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',[item.organizationId,item.channelId])).rows[0]!;
  await interruptChatwootAttendance(tx,{organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId},false);
  await tx.query(`INSERT INTO attendance_sessions(organization_id,id,channel_id,conversation_id,cycle,execution_id,automation_id,version,state,owner_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'WAITING_HUMAN',$9)
    ON CONFLICT(organization_id,conversation_id,cycle) DO UPDATE SET state='WAITING_HUMAN',execution_id=EXCLUDED.execution_id,
      automation_id=EXCLUDED.automation_id,version=EXCLUDED.version,owner_revision=EXCLUDED.owner_revision,revision=attendance_sessions.revision+1,updated_at=now()`,
    [item.organizationId,session?.id??randomUUID(),item.channelId,item.conversationId,cycle,item.executionId,execution.automationId,execution.version,owner.revision]);
  await tx.query("UPDATE automation_outbox SET status='SENT',remote_reference=$3,last_error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2",[item.organizationId,item.id,receipt]);
  return {kind:'SENT',remoteReference:receipt};
 })};
}
