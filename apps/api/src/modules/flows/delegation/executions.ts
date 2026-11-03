import type {FlowExecutionDetail} from '@jrc/contracts';
import type {TenantTransaction} from '../../../db/tenant-transaction.js';
import {AutomationError} from '../../automations/errors.js';
import {safeExecutionCode} from '../../automations/execution-inspection.js';
/** Metadata only. Scope is resolved server-side before this query, never from an editor request. */
export async function readDelegatedExecution(tx:TenantTransaction,org:string,root:string,id:string,channels:string[]){
 const row=(await tx.query<FlowExecutionDetail['data']>(`select 1 as "schemaVersion",e.id,e.organization_id as "organizationId",e.automation_id as "automationId",e.version,
 e.binding_id as "bindingId",e.channel_id as "channelId",e.status,e.current_node_id as "currentNodeId",e.correlation_id as "correlationId",
 e.conversation_id as "conversationRef",e.error_code as "errorCode",e.started_at as "startedAt",e.updated_at as "updatedAt",e.completed_at as "completedAt",
 greatest(0,extract(epoch from(coalesce(e.completed_at,now())-e.started_at))*1000)::float8 as "durationMs"
 from automation_executions e where e.organization_id=$1 and e.automation_id=$2 and e.id=$3 and e.channel_id=any($4::uuid[])`,[org,root,id,channels])).rows[0];
 if(!row)throw new AutomationError('AUTOMATION_EXECUTION_NOT_FOUND',404);
 const nodes=(await tx.query<FlowExecutionDetail['nodes'][number]>(`select id,node_id as "nodeId",status,(ordinal/1000)+1 as attempt,
 case when completed_at is null then null else greatest(0,extract(epoch from(completed_at-started_at))*1000)::float8 end as "durationMs",error_code as "errorCode"
 from automation_node_executions where organization_id=$1 and execution_id=$2 order by ordinal limit 201`,[org,id])).rows;
 const effects=(await tx.query<FlowExecutionDetail['effects'][number]>(`select id,node_id as "nodeId",kind,status,attempts from automation_outbox
 where organization_id=$1 and execution_id=$2 order by ordinal limit 201`,[org,id])).rows;
 const iso=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
 return {data:{...row,errorCode:safeExecutionCode(row.errorCode),startedAt:iso(row.startedAt),updatedAt:iso(row.updatedAt),completedAt:row.completedAt?iso(row.completedAt):null},
 nodes:nodes.slice(0,200).map(node=>({...node,errorCode:safeExecutionCode(node.errorCode)})),effects:effects.slice(0,200),truncated:nodes.length>200||effects.length>200};
}
