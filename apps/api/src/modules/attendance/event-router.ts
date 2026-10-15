import type { TenantTransaction } from '../../db/tenant-transaction.js';
import {runtimeAuthorityAllows} from './runtime-authority.js';
import type {GroupPhysicalPolicy} from '../whatsapp-groups/automation-authority.js';

/** The commercial payload cannot supply the engine's private wait envelope. */
export function automationMessageInput(payload:Record<string,unknown>):Record<string,unknown>{
  const {inputWait:_,...data}=payload;
  return {...data,eventType:'MESSAGE'};
}

/**
 * The caller holds the execution lock. Input waits consume exactly one admitted
 * message; IO and delay waits can only be advanced by their own completion.
 */
export async function promoteAttendanceInput(tx: TenantTransaction, org: string, executionId: string, policy?:GroupPhysicalPolicy): Promise<boolean> {
  const waiting = (await tx.query<{id:string;nodeId:string;deadline:Date|null;expired:boolean;state:{waiting?:{kind?:string;nodeId?:string;waitId?:string;deadlineAt?:number}};channelId:string;conversationId:string|null;automationId:string;version:number}>(`
    select w.id,w.node_id as "nodeId",w.deadline_at as deadline,w.deadline_at<=clock_timestamp() as expired,e.state,
      e.channel_id as "channelId",e.conversation_id as "conversationId",e.automation_id as "automationId",e.version
    from automation_waits w join automation_executions e
      on e.organization_id=w.organization_id and e.id=w.execution_id
    where w.organization_id=$1 and w.execution_id=$2 and w.kind='EVENT' and w.status='WAITING' and e.status='WAITING'
    for update of w`, [org, executionId])).rows[0];
  if (!waiting) return false;
  const marked=waiting.state.waiting?.waitId!==undefined;
  if(marked){
    const state=waiting.state.waiting!;
    if(state.waitId!==waiting.id||state.kind!=='EVENT'||state.nodeId!==waiting.nodeId||state.deadlineAt!==waiting.deadline?.getTime()&&!(state.deadlineAt===undefined&&waiting.deadline===null))throw new Error('AUTOMATION_INPUT_WAIT_INVALID');
    if(!await runtimeAuthorityAllows(tx,{organizationId:org,channelId:waiting.channelId,conversationId:waiting.conversationId,automationId:waiting.automationId,version:waiting.version,executionId},true,policy))return false;
  }
  const event = (await tx.query<{ id:string; event_key:string; payload:Record<string,unknown>;admittedAt:Date|null }>(`
    select id,event_key,payload,admitted_at as "admittedAt" from automation_events where organization_id=$1 and execution_id=$2
      and status='PENDING' and type='MESSAGE' and (NOT $3::boolean OR (admitted_at IS NOT NULL AND ($4::timestamptz IS NULL OR admitted_at<=$4)))
      order by queue_sequence limit 1 for update`, [org, executionId,marked,waiting.deadline])).rows[0];
  if(!event){
    if(!marked||!waiting.expired)return false;
    const eventKey=`input-timeout:${waiting.id}`,input={eventType:'TIMER',text:'',inputWait:{waitId:waiting.id}};
    const inserted=await tx.query(`insert into automation_events(organization_id,execution_id,event_key,type,payload,status,consumed_at)
      values($1,$2,$3,'INPUT_TIMEOUT',$4::jsonb,'CONSUMED',clock_timestamp()) on conflict(organization_id,event_key) do nothing returning id`,[org,executionId,eventKey,JSON.stringify(input)]);
    if(!inserted.rowCount)throw new Error('AUTOMATION_INPUT_TIMEOUT_IDENTITY_CONFLICT');
    const resumed=await tx.query(`update automation_waits set status='RESUMED',resume_event_key=$3,resumed_at=clock_timestamp()
      where organization_id=$1 and id=$2 and status='WAITING' returning id`,[org,waiting.id,eventKey]);
    if(!resumed.rowCount)throw new Error('AUTOMATION_INPUT_SETTLEMENT_LOST');
    const queued=await tx.query(`update automation_executions set status='QUEUED',input=$3::jsonb,updated_at=clock_timestamp(),lease_token=null,lease_expires_at=null
      where organization_id=$1 and id=$2 and status='WAITING' returning id`,[org,executionId,JSON.stringify(input)]);
    if(!queued.rowCount)throw new Error('AUTOMATION_INPUT_SETTLEMENT_LOST');
    return true;
  }
  await tx.query(`update automation_waits set status='RESUMED',resume_event_key=$3,resumed_at=now()
    where organization_id=$1 and id=$2`, [org, waiting.id, event.event_key]);
  await tx.query(`update automation_executions set status='QUEUED',input=$3,updated_at=now(),lease_token=null,lease_expires_at=null
    where organization_id=$1 and id=$2`, [org, executionId, JSON.stringify({ ...automationMessageInput(event.payload),...(marked?{inputWait:{waitId:waiting.id,admittedAt:event.admittedAt!.getTime()}}:{}) })]);
  await tx.query(`update automation_events set status='CONSUMED',consumed_at=now()
    where organization_id=$1 and id=$2 and status='PENDING'`, [org, event.id]);
  return true;
}
