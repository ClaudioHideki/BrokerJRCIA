import { randomUUID } from 'node:crypto';
import { AUTOMATION_ORIGIN, FLOW_ORIGIN, type Ownership } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { BindingRow } from '../automations/repository.js';
import { AttendanceError } from './types.js';
import { lockAttendanceChannel, resolveAttendanceScope } from './repository.js';
import { assertHandoffBinding } from './handoff-binding.js';

export const bindingColumns=`id,organization_id AS "organizationId",automation_id AS "automationId",version,channel_id AS "channelId",human_destination_id AS "humanDestinationId",status,revision,created_at AS "createdAt",updated_at AS "updatedAt"`;
export async function lockOwnershipMutations(tx:TenantTransaction,org:string) {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('flow-inbox:'||$1,0))",[org]);
  // Plan changes lock the organization first; every owner caller follows that
  // order before touching a channel, definition, instance or migration ledger.
  await tx.query('select tenant_is_active($1)',[org]);
}
export async function readOwnerRevision(tx:TenantTransaction,org:string,channelId:string):Promise<number> {
  return (await tx.query<{revision:number}>('select revision from attendance_owners where organization_id=$1 and channel_id=$2',[org,channelId])).rows[0]?.revision??0;
}
interface RemoteRelease {
  operation_revision:number; operation_state:'IDLE'|'RESERVED'|'DISPATCHED'|'UNKNOWN'; status:string;
}
// Callers hold the ownership lock. Revocation is local and idempotent: it
// invalidates late settlement without claiming an uncertain remote write stopped.
export async function revokeRemoteFlowBinding(tx:TenantTransaction,org:string,id:string):Promise<RemoteRelease> {
  const current=(await tx.query<RemoteRelease>(`select operation_revision,operation_state,status from flow_chatwoot_bindings
    where organization_id=$1 and id=$2 for update`,[org,id])).rows[0];
  if(!current)throw new AttendanceError('FLOW_BINDING_NOT_FOUND',404);
  if(current.status==='DISABLED')return current;
  const released=(await tx.query<RemoteRelease>(`update flow_chatwoot_bindings set status='DISABLED',operation_revision=operation_revision+1,operation_token=null,
    operation_state=case when operation_state in ('DISPATCHED','UNKNOWN') then 'UNKNOWN' else 'IDLE' end,
    operation_expires_at=case when operation_state in ('DISPATCHED','UNKNOWN') then operation_expires_at else null end,updated_at=now()
    where organization_id=$1 and id=$2 returning operation_revision,operation_state,status`,[org,id])).rows[0]!;
  await tx.query("update flow_chatwoot_events set status='PAUSED' where organization_id=$1 and binding_id=$2 and status='PENDING'",[org,id]);
  await tx.query("update flow_chatwoot_outbox set status='CANCELED',last_error='BOT_CONFIGURATION_CHANGED' where organization_id=$1 and binding_id=$2 and status='PENDING'",[org,id]);
  return released;
}
export interface OwnerTransition {
  channelId:string; botPublicId:string|null; botOriginReference:string|null;
  // Omission is reserved for internal legacy commands. HTTP schemas require CAS.
  expectedOwnerRevision?:number|undefined; version?:number|undefined; humanDestinationId?:string|null|undefined;
  bindingId?:string; bindingRevision?:number; bindingStatus?:'ACTIVE'|'PAUSED'|'DISABLED';
  executor?:Ownership['executor']; remoteBindingId?:string|null;
}
export async function transitionChannelOwner(tx:TenantTransaction,org:string,input:OwnerTransition) {
  await lockOwnershipMutations(tx,org);
  if((input.botPublicId===null)!==(input.botOriginReference===null))throw new AttendanceError('INVALID_BOT_CONFIGURATION',422);
  const active=(await tx.query<{active:boolean}>('select tenant_is_active($1) AS active',[org])).rows[0]?.active;
  if(!active)throw new AttendanceError('ORGANIZATION_NOT_ACTIVE',403);
  await lockAttendanceChannel(tx,org,input.channelId);
  const channel=(await tx.query<{bot_public_id:string|null;bot_origin_reference:string|null;deleting_at:Date|null}>(
    'select bot_public_id,bot_origin_reference,deleting_at from messaging_channels where organization_id=$1 and id=$2',[org,input.channelId])).rows[0];
  if(!channel)throw new AttendanceError('CHANNEL_NOT_FOUND',404);
  const revision=await readOwnerRevision(tx,org,input.channelId);
  if(input.expectedOwnerRevision!==undefined&&input.expectedOwnerRevision!==revision)throw new AttendanceError('ATTENDANCE_OWNER_CHANGED',409);
  const current=(await tx.query<BindingRow>(`select ${bindingColumns} from automation_bindings where organization_id=$1 and channel_id=$2 and status in ('ACTIVE','PAUSED') for update`,[org,input.channelId])).rows[0];
  if(input.bindingId && (!current||current.id!==input.bindingId||current.revision!==input.bindingRevision))throw new AttendanceError('AUTOMATION_BINDING_CHANGED',409);
  if(input.bindingId&&channel.bot_public_id!==null&&(channel.bot_origin_reference!==AUTOMATION_ORIGIN||channel.bot_public_id!==current!.automationId))throw new AttendanceError('ATTENDANCE_OWNER_CHANGED',409);
  const native=input.botOriginReference===AUTOMATION_ORIGIN;
  const executor:Ownership['executor']=input.executor??(input.botPublicId===null?'NONE':native||input.botOriginReference===FLOW_ORIGIN?'BROKER':'EXTERNAL');
  if(channel.deleting_at&&executor!=='NONE')throw new AttendanceError('CHANNEL_DELETION_IN_PROGRESS',409);
  const owner=(await tx.query<{executor:string;remote_binding_id:string|null}>('select executor,remote_binding_id from attendance_owners where organization_id=$1 and channel_id=$2',[org,input.channelId])).rows[0];
  let version:number|null=null;
  if(native){
    const definition=(await tx.query<{active_version:number|null;lifecycle_status:string}>('select active_version,lifecycle_status from automation_definitions where organization_id=$1 and id=$2',[org,input.botPublicId])).rows[0];
    if(!definition)throw new AttendanceError('AUTOMATION_NOT_FOUND',404);
    if(definition.lifecycle_status==='ARCHIVED')throw new AttendanceError('AUTOMATION_ARCHIVED',409);
    version=input.version??definition.active_version;
    if(!version)throw new AttendanceError('AUTOMATION_NOT_PUBLISHED',409);
    if(!(await tx.query('select 1 from automation_versions where organization_id=$1 and automation_id=$2 and version=$3',[org,input.botPublicId,version])).rowCount)throw new AttendanceError('AUTOMATION_VERSION_NOT_FOUND',404);
  }
  const desiredStatus=input.bindingStatus??'ACTIVE';
  const samePointer=channel.bot_public_id===input.botPublicId&&channel.bot_origin_reference===input.botOriginReference;
  const sameBinding=native?(current?.automationId===input.botPublicId&&current.version===version&&current.humanDestinationId===(input.humanDestinationId??null)):!current;
  const sameOwner=(owner?.executor??'NONE')===executor&&(owner?.remote_binding_id??null)===(input.remoteBindingId??null);
  if(native&&desiredStatus==='ACTIVE'&&!(samePointer&&sameBinding&&sameOwner&&current?.status===desiredStatus))await assertHandoffBinding(tx,org,input.channelId,input.botPublicId!,version!);
  if(samePointer&&sameBinding&&sameOwner){
    if(current&&native&&current.status!==desiredStatus){
      // PAUSED only closes admission; already admitted executions retain their owner.
      if(desiredStatus==='ACTIVE')await resolveAttendanceScope(tx,org,input.channelId);
      const binding=(await tx.query<BindingRow>(`update automation_bindings set status=$3,revision=revision+1,updated_at=now() where organization_id=$1 and id=$2 returning ${bindingColumns}`,[org,current.id,desiredStatus])).rows[0]!;
      return {binding,ownerRevision:revision,changed:false};
    }
    return {binding:current??null,ownerRevision:revision,changed:false};
  }
  if(executor!=='NONE'){
    await resolveAttendanceScope(tx,org,input.channelId);
    const conflict=await tx.query(`select 1 from flow_chatwoot_bindings b join chatwoot_connections c on c.organization_id=b.organization_id and c.inbox_id=b.inbox_id
      where c.organization_id=$1 and c.channel_id=$2 and (b.status<>'DISABLED' OR b.operation_state<>'IDLE' OR b.bot_id is not null)
       and ($3::uuid is null OR b.id<>$3)`,[org,input.channelId,input.remoteBindingId??null]);
    if(conflict.rowCount)throw new AttendanceError('FLOW_INBOX_HAS_AUTOMATION',409);
  }
  await tx.query('select id from automation_executions where organization_id=$1 and channel_id=$2 order by id for no key update',[org,input.channelId]);
  const uncertain=await tx.query(`select 1 from automation_outbox o join automation_executions e on e.organization_id=o.organization_id and e.id=o.execution_id
    where e.organization_id=$1 and e.channel_id=$2 and o.status in ('UNKNOWN','SENDING') limit 1`,[org,input.channelId]);
  if(uncertain.rowCount&&executor!=='NONE')throw new AttendanceError('ATTENDANCE_WORK_RECONCILIATION_REQUIRED',409);
  const uncertainLegacy=await tx.query("select 1 from messaging_messages where organization_id=$1 and channel_id=$2 and source='AUTOMATION' and direction='OUTGOING' and state in ('SENDING','UNKNOWN') limit 1",[org,input.channelId]);
  if(uncertainLegacy.rowCount&&executor!=='NONE')throw new AttendanceError('ATTENDANCE_WORK_RECONCILIATION_REQUIRED',409);
  if(executor==='NONE'&&owner?.remote_binding_id)await revokeRemoteFlowBinding(tx,org,owner.remote_binding_id);
  await tx.query(`update automation_outbox o set status='CANCELED',last_error='BOT_CONFIGURATION_CHANGED',updated_at=now() from automation_executions e
    where e.organization_id=$1 and e.channel_id=$2 and o.organization_id=e.organization_id and o.execution_id=e.id and o.status='PENDING'`,[org,input.channelId]);
  await tx.query(`update automation_waits w set status='CANCELED' from automation_executions e where e.organization_id=$1 and e.channel_id=$2 and w.organization_id=e.organization_id and w.execution_id=e.id and w.status='WAITING'`,[org,input.channelId]);
  await tx.query(`update automation_executions set status='CANCELED',error_code='BOT_CONFIGURATION_CHANGED',lease_token=null,lease_expires_at=null,completed_at=now(),updated_at=now()
    where organization_id=$1 and channel_id=$2 and status in ('QUEUED','RUNNING','WAITING')`,[org,input.channelId]);
  // Dispatch validation takes channel SHARE before outbox rows. Once this
  // transition owns the channel, accepted outputs cannot become SENDING.
  await tx.query(`select o.message_id from messaging_outbox o join messaging_messages m on m.organization_id=o.organization_id and m.id=o.message_id
    where m.organization_id=$1 and m.channel_id=$2 and m.source='AUTOMATION' and m.direction='OUTGOING' and m.state='ACCEPTED' order by o.message_id for update of o`,[org,input.channelId]);
  await tx.query(`with canceled as (update messaging_messages set state='FAILED',canonical_error_code='BOT_CONFIGURATION_CHANGED',updated_at=now()
    where organization_id=$1 and channel_id=$2 and source='AUTOMATION' and direction='OUTGOING' and state='ACCEPTED' returning organization_id,id)
    delete from messaging_outbox o using canceled m where o.organization_id=m.organization_id and o.message_id=m.id`,[org,input.channelId]);
  // Job-first order matches bot completion. Modes are deliberately preserved.
  await tx.query(`select j.message_id from messaging_bot_jobs j join messaging_conversations c on c.organization_id=j.organization_id and c.id=j.conversation_id
    where j.organization_id=$1 and c.channel_id=$2 order by j.message_id for update of j`,[org,input.channelId]);
  await tx.query(`update messaging_bot_jobs j set status=case when j.status='RUNNING' then 'UNKNOWN'::messaging_bot_job_status else 'PAUSED'::messaging_bot_job_status end,
    lease_token=null,lease_expires_at=null,canonical_error_code='BOT_CONFIGURATION_CHANGED',updated_at=now() from messaging_conversations c
    where j.organization_id=$1 and c.organization_id=j.organization_id and c.id=j.conversation_id and c.channel_id=$2 and j.status in ('PENDING','RUNNING')`,[org,input.channelId]);
  await tx.query(`update messaging_conversations set bot_public_id=$3,bot_origin_reference=$4,typebot_session_id=null,updated_at=now() where organization_id=$1 and channel_id=$2`,[org,input.channelId,input.botPublicId,input.botOriginReference]);
  await tx.query(`update messaging_channels set bot_public_id=$3,bot_origin_reference=$4,updated_at=now() where organization_id=$1 and id=$2`,[org,input.channelId,input.botPublicId,input.botOriginReference]);
  await tx.query(`update automation_bindings set status='DISABLED',revision=revision+1,updated_at=now() where organization_id=$1 and channel_id=$2 and status in ('ACTIVE','PAUSED')`,[org,input.channelId]);
  let binding:BindingRow|null=null;
  if(native){
    if(current?.automationId===input.botPublicId&&current.version===version){
      binding=(await tx.query<BindingRow>(`update automation_bindings set status=$3,human_destination_id=$4 where organization_id=$1 and id=$2 returning ${bindingColumns}`,[org,current.id,desiredStatus,input.humanDestinationId??null])).rows[0]!;
    }else binding=(await tx.query<BindingRow>(`insert into automation_bindings(organization_id,id,automation_id,version,channel_id,human_destination_id,status) values($1,$2,$3,$4,$5,$6,$7) returning ${bindingColumns}`,[org,randomUUID(),input.botPublicId,version,input.channelId,input.humanDestinationId??null,desiredStatus])).rows[0]!;
  }
  const integration=(await tx.query<{id:string}>('select id from chatwoot_connections where organization_id=$1 and channel_id=$2',[org,input.channelId])).rows[0]?.id??null;
  await tx.query(`insert into attendance_owners(organization_id,channel_id,integration_id,revision,executor,automation_id,version,remote_binding_id) values($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict(organization_id,channel_id) do update set integration_id=$3,revision=$4,executor=$5,automation_id=$6,version=$7,remote_binding_id=$8,updated_at=now()`,[org,input.channelId,integration,revision+1,executor,native?input.botPublicId:null,version,input.remoteBindingId??null]);
  await tx.query('UPDATE central_transport_bindings SET owner_revision=$3,updated_at=now() WHERE organization_id=$1 AND channel_id=$2',[org,input.channelId,revision+1]);
  await tx.query(`update attendance_sessions set state='ADMIN_PAUSED',revision=revision+1,updated_at=now() where organization_id=$1 and channel_id=$2 and state in ('BOT_ACTIVE','WAITING_INPUT')`,[org,input.channelId]);
  return {binding,ownerRevision:revision+1,changed:true};
}
