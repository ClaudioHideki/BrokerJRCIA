import type { AutomationGraphV1, AutomationSubflowCatalogItem } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { RuntimeResult, RuntimeState } from './types.js';
import { automationMessageInput,promoteAttendanceInput } from '../attendance/event-router.js';
import { runtimeAuthorityAllows } from '../attendance/runtime-authority.js';
import { AttendanceError } from '../attendance/types.js';
import { unknownOutboxDiagnostic } from './outbox-diagnostics.js';
import type {GroupPhysicalPolicy} from '../whatsapp-groups/automation-authority.js';
import { z } from 'zod';

export interface DefinitionRow {id:string;organizationId:string;name:string;lifecycleStatus:'DRAFT'|'PUBLISHED'|'ARCHIVED';draftGraph:AutomationGraphV1;draftRevision:number;activeVersion:number|null;updatedAt:Date}
export interface DefinitionPageCursor {updatedAt:string;id:string}
export interface DefinitionPageRow extends DefinitionRow {cursorUpdatedAt:string}
export interface VersionRow {automationId:string;organizationId:string;version:number;graph:AutomationGraphV1;checksum:string;publishedAt:Date;runtimeStateVersion?:1|2}
export interface SubflowCatalogCursor {automationId:string;version:number}
export interface BindingRow {id:string;organizationId:string;automationId:string;version:number;channelId:string;humanDestinationId:string|null;status:'ACTIVE'|'PAUSED'|'DISABLED';revision:number;createdAt:Date;updatedAt:Date}
export interface ExecutionRow {id:string;organizationId:string;automationId:string;version:number;bindingId:string;channelId:string;conversationId:string|null;status:string;currentNodeId:string|null;correlationId:string;state:RuntimeState;input:Record<string,unknown>;errorCode:string|null;attempts:number;startedAt:Date;updatedAt:Date;completedAt:Date|null;leaseToken:string|null}
export type OutboxKind='SEND_TEXT'|'HANDOFF'|'RESUME_EVENT'|'IO_HTTP'|'IO_SQL'|'IO_CODE'|'IO_AI'|'IO_CONVERSATION'|'SEND_MEDIA';
export interface OutboxRow {id:string;organizationId:string;executionId:string;channelId:string;conversationId:string|null;nodeId:string;ordinal:number;kind:OutboxKind;payload:Record<string,unknown>;attempts:number;leaseToken:string}
export type HandoffTerminalResult={status:'SENT';remoteReference?:string}|{status:'FAILED';error:string};
export interface NodeExecutionRow {id:string;nodeId:string;ordinal:number;status:string;input:Record<string,unknown>;output:Record<string,unknown>;errorCode:string|null;startedAt:Date;completedAt:Date|null}
export interface OutboxInspectionRow {boundedAi?:boolean;aiUsage?:{status:string;month:string;model:string;reservedMicros:number;observedMicros:number|null;inputTokens:number|null;outputTokens:number|null}|null;id:string;nodeId:string;ordinal:number;kind:OutboxKind;handoffDestination?:'LOCAL'|'CENTRAL'|null;status:string;attempts:number;remoteReference:string|null;lastError:string|null;createdAt:Date;updatedAt:Date}
export interface ExecutionContextRow {conversationId:string|null;contactId:string|null}

// Only the head of an execution may leave the durable outbox. Inspect ALL kinds
// and ALL availability times: an IO worker must not jump over a text effect,
// and a backoff/UNKNOWN predecessor must keep blocking after its lease expires.
// Historical equal ordinals are ambiguous: never reconstruct their order from UUIDs.
const outboxHeadEligible=`not exists (
  select 1 from automation_outbox predecessor
  where predecessor.organization_id=o.organization_id and predecessor.execution_id=o.execution_id
    and predecessor.ordinal<o.ordinal and predecessor.status not in ('SENT','FAILED','CANCELED')
) and not exists (
  select 1 from automation_outbox peer
  where peer.organization_id=o.organization_id and peer.execution_id=o.execution_id
    and peer.ordinal=o.ordinal and peer.id<>o.id
)`;

// Local HANDOFF has no HTTP effect and commits its receipt with the state change.
// A crashed reservation without that receipt can be reclaimed after its lease;
// external UNKNOWN effects remain barriers and are never retried by this path.
const outboxClaimEligible=`(o.status='PENDING' AND o.available_at<=now() OR
  o.status='UNKNOWN' AND o.kind='HANDOFF' AND o.remote_reference IS NULL
  AND o.payload @> '{"handoffVersion":2,"destination":{"kind":"LOCAL"}}'::jsonb
  AND o.lease_expires_at<=now())`;

const runtimeTenantActive=`exists(select 1 from organizations runtime_org join flow_features runtime_feature on runtime_feature.organization_id=runtime_org.id where runtime_org.id=$1 and runtime_org.status='ACTIVE' and runtime_feature.enabled)`;
const definitionColumns=`id,organization_id AS "organizationId",name,lifecycle_status AS "lifecycleStatus",draft_graph AS "draftGraph",draft_revision AS "draftRevision",active_version AS "activeVersion",updated_at AS "updatedAt"`;
const versionColumns=`automation_id AS "automationId",organization_id AS "organizationId",version,graph,checksum,published_at AS "publishedAt",runtime_state_version AS "runtimeStateVersion"`;
const bindingColumns=`id,organization_id AS "organizationId",automation_id AS "automationId",version,channel_id AS "channelId",human_destination_id AS "humanDestinationId",status,revision,created_at AS "createdAt",updated_at AS "updatedAt"`;
const executionColumns=`id,organization_id AS "organizationId",automation_id AS "automationId",version,binding_id AS "bindingId",channel_id AS "channelId",conversation_id AS "conversationId",status,current_node_id AS "currentNodeId",correlation_id AS "correlationId",state,input,error_code AS "errorCode",attempts,started_at AS "startedAt",updated_at AS "updatedAt",completed_at AS "completedAt",lease_token AS "leaseToken"`;
const claimedExecutionColumns=executionColumns.split(',').map(column=>`e.${column}`).join(',');

export interface AutomationRepository {
 listDefinitions(tx:TenantTransaction,org:string,options:{pageSize:number;cursor?:DefinitionPageCursor}):Promise<{rows:DefinitionPageRow[];hasMore:boolean}>;
 listSubflowVersions(tx:TenantTransaction,org:string,rootId:string,options:{pageSize:number;cursor?:SubflowCatalogCursor}):Promise<{rows:AutomationSubflowCatalogItem[];hasMore:boolean}>;
 getDefinition(tx:TenantTransaction,org:string,id:string,lock?:boolean):Promise<DefinitionRow|null>;
 insertDefinition(tx:TenantTransaction,row:{org:string;id:string;name:string;graph:AutomationGraphV1}):Promise<DefinitionRow>;
 updateDefinition(tx:TenantTransaction,row:{org:string;id:string;name:string;graph:AutomationGraphV1;revision:number}):Promise<DefinitionRow|null>;
 insertVersion(tx:TenantTransaction,row:{org:string;id:string;version:number;graph:AutomationGraphV1;checksum:string;runtimeStateVersion?:1|2}):Promise<VersionRow>;
 activateVersion(tx:TenantTransaction,org:string,id:string,version:number):Promise<DefinitionRow>;
 getVersion(tx:TenantTransaction,org:string,id:string,version:number):Promise<VersionRow|null>;
 listVersions(tx:TenantTransaction,org:string,id:string):Promise<VersionRow[]>;
 listBindings(tx:TenantTransaction,org:string,id:string):Promise<BindingRow[]>;
 insertBinding(tx:TenantTransaction,row:{org:string;id:string;automationId:string;version:number;channelId:string;humanDestinationId:string|null}):Promise<BindingRow>;
 setBindingStatus(tx:TenantTransaction,org:string,id:string,status:BindingRow['status'],revision:number):Promise<BindingRow|null>;
 insertEvent(tx:TenantTransaction,row:{org:string;id:string;eventKey:string;type:string;payload:Record<string,unknown>}):Promise<boolean>;
 routeEvent(tx:TenantTransaction,row:{org:string;eventId:string;executionId:string;correlationId:string;channelId:string;conversationId:string|null;eventKey:string;input:Record<string,unknown>}):Promise<{execution:ExecutionRow;resumed:boolean}|null>;
 claimExecution(tx:TenantTransaction,org:string,leaseToken:string,leaseMs:number):Promise<ExecutionRow|null>;
 saveExecutionResult(tx:TenantTransaction,execution:ExecutionRow,result:RuntimeResult):Promise<void>;
 failExecution(tx:TenantTransaction,org:string,id:string,leaseToken:string,code:string,unknown:boolean):Promise<void>;
 getExecution(tx:TenantTransaction,org:string,id:string):Promise<ExecutionRow|null>;
 listExecutions(tx:TenantTransaction,org:string,automationId?:string):Promise<ExecutionRow[]>;
 listNodeExecutions(tx:TenantTransaction,org:string,executionId:string):Promise<NodeExecutionRow[]>;
 listExecutionOutbox(tx:TenantTransaction,org:string,executionId:string):Promise<OutboxInspectionRow[]>;
 getExecutionContext(tx:TenantTransaction,org:string,executionId:string):Promise<ExecutionContextRow>;
 reconcileUnknownOutbox(tx:TenantTransaction,input:{org:string;executionId:string;outboxId:string;actorId:string;outcome:'CONFIRMED_SENT'|'CONFIRMED_NOT_SENT'|'UNRESOLVED';evidenceCode:string;providerReference?:string}):Promise<boolean>;
 cancelExecution(tx:TenantTransaction,org:string,id:string):Promise<boolean>;
 retryExecution(tx:TenantTransaction,org:string,id:string):Promise<boolean>;
 resumeExecution(tx:TenantTransaction,row:{org:string;id:string;eventId:string;eventKey:string;payload:Record<string,unknown>;effectReceiptId?:string}):Promise<boolean>;
 releaseDueWaits(tx:TenantTransaction,org:string,limit:number):Promise<number>;
 claimOutbox(tx:TenantTransaction,org:string,leaseToken:string,leaseMs:number,kinds:OutboxKind[],recipientKind?:'GROUP'):Promise<OutboxRow|null>;
 settleOutbox(tx:TenantTransaction,org:string,id:string,leaseToken:string,result:{status:'SENT'|'PENDING'|'FAILED';remoteReference?:string;error?:string;availableAt?:Date}):Promise<boolean>;
 hasCommittedHandoffResult(tx:TenantTransaction,item:OutboxRow,result:HandoffTerminalResult):Promise<boolean>;
 recordUnknownOutbox(tx:TenantTransaction,org:string,id:string,leaseToken:string,error:string):Promise<boolean>;
}

export function createPostgresAutomationRepository(policy?:GroupPhysicalPolicy):AutomationRepository{
  const authority=(tx:TenantTransaction,input:Parameters<typeof runtimeAuthorityAllows>[1],remote=true)=>runtimeAuthorityAllows(tx,input,remote,policy);
  return {
  async listSubflowVersions(tx,org,rootId,options){
    const rows=(await tx.query<AutomationSubflowCatalogItem>(`select v.automation_id as "automationId",d.name,v.version,v.checksum,v.runtime_state_version as "runtimeStateVersion"
      from automation_versions v join automation_definitions d on d.organization_id=v.organization_id and d.id=v.automation_id
      where v.organization_id=$1 and v.automation_id<>$2 and d.lifecycle_status<>'ARCHIVED' and v.runtime_state_version=2
      and ($3::uuid is null or v.automation_id>$3::uuid or (v.automation_id=$3::uuid and v.version<$4))
      order by v.automation_id asc,v.version desc limit $5`,[org,rootId,options.cursor?.automationId??null,options.cursor?.version??null,options.pageSize+1])).rows;
    return {rows:rows.slice(0,options.pageSize),hasMore:rows.length>options.pageSize};
  },
  async listDefinitions(tx,org,options){
    const rows=(await tx.query<DefinitionPageRow>(`select ${definitionColumns},to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorUpdatedAt"
      from automation_definitions where organization_id=$1
      and ($2::timestamptz is null or (updated_at,id)<($2::timestamptz,$3::uuid))
      order by updated_at desc,id desc limit $4`,
      [org,options.cursor?.updatedAt??null,options.cursor?.id??null,options.pageSize+1])).rows;
    return {rows:rows.slice(0,options.pageSize),hasMore:rows.length>options.pageSize};
  },
  async getDefinition(tx,org,id,lock=false){return (await tx.query<DefinitionRow>(`select ${definitionColumns} from automation_definitions where organization_id=$1 and id=$2 ${lock?'for update':''}`,[org,id])).rows[0]??null;},
  async insertDefinition(tx,row){return (await tx.query<DefinitionRow>(`insert into automation_definitions(organization_id,id,name,draft_graph) values($1,$2,$3,$4) returning ${definitionColumns}`,[row.org,row.id,row.name,JSON.stringify(row.graph)])).rows[0]!;},
  async updateDefinition(tx,row){return (await tx.query<DefinitionRow>(`update automation_definitions set name=$3,draft_graph=$4,draft_revision=draft_revision+1,updated_at=now() where organization_id=$1 and id=$2 and draft_revision=$5 and lifecycle_status<>'ARCHIVED' returning ${definitionColumns}`,[row.org,row.id,row.name,JSON.stringify(row.graph),row.revision])).rows[0]??null;},
  async insertVersion(tx,row){return (await tx.query<VersionRow>(`insert into automation_versions(organization_id,automation_id,version,graph,checksum,runtime_state_version) values($1,$2,$3,$4,$5,$6) returning ${versionColumns}`,[row.org,row.id,row.version,JSON.stringify(row.graph),row.checksum,row.runtimeStateVersion??1])).rows[0]!;},
  async activateVersion(tx,org,id,version){return (await tx.query<DefinitionRow>(`update automation_definitions set active_version=$3,lifecycle_status='PUBLISHED',updated_at=now() where organization_id=$1 and id=$2 returning ${definitionColumns}`,[org,id,version])).rows[0]!;},
  async getVersion(tx,org,id,version){return (await tx.query<VersionRow>(`select ${versionColumns} from automation_versions where organization_id=$1 and automation_id=$2 and version=$3`,[org,id,version])).rows[0]??null;},
  async listVersions(tx,org,id){return (await tx.query<VersionRow>(`select ${versionColumns} from automation_versions where organization_id=$1 and automation_id=$2 order by version desc`,[org,id])).rows;},
  async listBindings(tx,org,id){return (await tx.query<BindingRow>(`select ${bindingColumns} from automation_bindings where organization_id=$1 and automation_id=$2 order by created_at desc`,[org,id])).rows;},
  async insertBinding(tx,row){return (await tx.query<BindingRow>(`insert into automation_bindings(organization_id,id,automation_id,version,channel_id,human_destination_id) select $1,$2,$3,$4,c.id,$6 from messaging_channels c where c.organization_id=$1 and c.id=$5 returning ${bindingColumns}`,[row.org,row.id,row.automationId,row.version,row.channelId,row.humanDestinationId])).rows[0]!;},
  async setBindingStatus(tx,org,id,status,revision){return (await tx.query<BindingRow>(`update automation_bindings set status=$3,revision=revision+1,updated_at=now() where organization_id=$1 and id=$2 and revision=$4 returning ${bindingColumns}`,[org,id,status,revision])).rows[0]??null;},
  async insertEvent(tx,row){return Boolean((await tx.query(`insert into automation_events(organization_id,id,event_key,type,payload) values($1,$2,$3,$4,$5) on conflict(organization_id,event_key) do nothing returning id`,[row.org,row.id,row.eventKey,row.type,JSON.stringify(row.type==='MESSAGE'?automationMessageInput(row.payload):row.payload)])).rowCount);},
  async routeEvent(tx,row){
    await lockAttendanceChannelRead(tx,row.org,row.channelId);
    const binding=(await tx.query<BindingRow>(`select ${bindingColumns} from automation_bindings where organization_id=$1 and channel_id=$2 and status in ('ACTIVE','PAUSED') and ${runtimeTenantActive} for update`,[row.org,row.channelId])).rows[0];if(!binding)return null;
    if(!await authority(tx,{organizationId:row.org,channelId:row.channelId,conversationId:row.conversationId,automationId:binding.automationId,version:binding.version},false))return null;
    const active=row.conversationId?(await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions
      where organization_id=$1 and binding_id=$2 and conversation_id=$3 and status in ('QUEUED','RUNNING','WAITING','HANDOFF','UNKNOWN','FAILED')
      order by started_at,id limit 2 for no key update`,[row.org,binding.id,row.conversationId])).rows:[];
    // Historical duplicate sessions need explicit reconciliation; never choose an arbitrary survivor.
    if(active.length>1)throw new Error('AUTOMATION_SESSION_RECONCILIATION_REQUIRED');
    const current=active[0];
    if(current){
      await tx.query(`update automation_events set execution_id=$3,payload=$4,admitted_at=clock_timestamp() where organization_id=$1 and id=$2 and status='PENDING'`,
        [row.org,row.eventId,current.id,JSON.stringify(automationMessageInput(row.input))]);
      const resumed=await promoteAttendanceInput(tx,row.org,current.id,policy);
      return {execution:(await this.getExecution(tx,row.org,current.id))!,resumed};
    }
    if(binding.status!=='ACTIVE')return null;
    const created=(await tx.query<ExecutionRow>(`insert into automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,input,state) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}') returning ${executionColumns}`,[row.org,row.executionId,binding.automationId,binding.version,binding.id,row.channelId,row.conversationId,row.eventKey,row.correlationId,JSON.stringify(automationMessageInput(row.input))])).rows[0]!;
    await tx.query(`update automation_events set execution_id=$3,status='CONSUMED',consumed_at=now(),admitted_at=clock_timestamp() where organization_id=$1 and id=$2`,[row.org,row.eventId,created.id]);return {execution:created,resumed:false};
  },
  async claimExecution(tx,org,leaseToken,leaseMs){
    const candidates=(await tx.query<{id:string;channelId:string}>(`select id,channel_id AS "channelId" from automation_executions
      where organization_id=$1 and ${runtimeTenantActive} and (status='QUEUED' or (status='RUNNING' and lease_expires_at<now()))
      order by updated_at,id limit 50`,[org])).rows;
    for(const channel of [...new Set(candidates.map(row=>row.channelId))].sort())await lockAttendanceChannelRead(tx,org,channel);
    const locked=(await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions where organization_id=$1 and id=any($2::uuid[])
      and (status='QUEUED' or (status='RUNNING' and lease_expires_at<now())) order by id for no key update skip locked`,[org,candidates.map(row=>row.id)])).rows;
    for(const candidate of candidates){
      const execution=locked.find(row=>row.id===candidate.id);if(!execution||!await authority(tx,{...execution,executionId:execution.id}))continue;
      return (await tx.query<ExecutionRow>(`update automation_executions set status='RUNNING',attempts=attempts+1,lease_token=$3,
        lease_expires_at=now()+($4::int*interval '1 millisecond'),updated_at=now() where organization_id=$1 and id=$2 returning ${executionColumns}`,
        [org,execution.id,leaseToken,leaseMs])).rows[0]??null;
    }
    return null;
  },
  async saveExecutionResult(tx,execution,result){
    if(execution.attempts===1 && (await tx.query("SELECT 1 FROM messaging_conversations WHERE organization_id=$1 AND id=$2 AND recipient_kind='GROUP'",[execution.organizationId,execution.conversationId])).rowCount)
      result={...result,effects:[{nodeId:'group-session-policy',ordinal:0,kind:'SEND_TEXT',payload:{text:'Este atendimento segue somente as respostas de quem iniciou. Outros participantes não avançam o menu.'}},...result.effects]};
    const turnOffset=execution.attempts*1000;
    // The engine emits at most 500 effects per turn. Keep the reserved 1000-slot
    // band disjoint from the following turn; reject rather than overflow SQL int.
    if(!Number.isSafeInteger(turnOffset)||turnOffset<0||result.effects.length>1000
      ||turnOffset+Math.max(0,result.effects.length-1)>2147483647)throw new Error('AUTOMATION_EFFECT_ORDINAL_RANGE');
    for(const [ordinal,node] of result.trace.entries())await tx.query(`insert into automation_node_executions(organization_id,execution_id,node_id,ordinal,status,input,output,completed_at) values($1,$2,$3,$4,'COMPLETED',$5,$6,now()) on conflict(organization_id,execution_id,ordinal) do nothing`,[execution.organizationId,execution.id,node.nodeId,turnOffset+ordinal,JSON.stringify(node.input),JSON.stringify(node.output)]);
    for(const node of result.trace.filter(item=>item.type==='subflow-result'&&typeof item.output.automationId==='string'))await tx.query(
      `insert into automation_child_executions(organization_id,parent_execution_id,node_id,automation_id,version,correlation_id,status,input,output) values($1,$2,$3,$4,$5,$6,'COMPLETED',$7,$8)`,
      [execution.organizationId,execution.id,node.nodeId,node.output.automationId,Number(node.output.version),node.output.correlationId,JSON.stringify(node.input),JSON.stringify(node.output.variables??{})]);
    // The array is the execution order. Older producers used ordinal=0 for every
    // node; never trust that value to be globally unique within a turn.
    for(const [effectOrdinal,effect] of result.effects.entries()){
      const conversationEffect=effect.kind==='IO_CONVERSATION'||effect.kind==='SEND_MEDIA';
      const effectId=conversationEffect?z.uuid().parse(effect.payload.waitId):null;
      if(conversationEffect&&(result.wait?.waitId!==effectId||result.wait.kind!=='IO'||result.state.waiting?.waitId!==effectId))
        throw new Error('AUTOMATION_EFFECT_WAIT_INVALID');
      await tx.query(`insert into automation_outbox(id,organization_id,execution_id,node_id,ordinal,kind,payload) values(coalesce($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7) on conflict(organization_id,execution_id,node_id,ordinal) do nothing`,[effectId,execution.organizationId,execution.id,effect.nodeId,turnOffset+effectOrdinal,effect.kind,JSON.stringify(effect.payload)]);
    }
    if(result.wait)await tx.query(`insert into automation_waits(id,organization_id,execution_id,node_id,kind,wake_at,deadline_at,state) values(coalesce($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8)`,[result.wait.waitId??null,execution.organizationId,execution.id,result.wait.nodeId,result.wait.kind,result.wait.wakeAt??null,result.wait.deadlineAt??null,JSON.stringify(result.state)]);
    await tx.query(`update automation_executions set status=$4,current_node_id=$5,state=$6,updated_at=now(),completed_at=case when $4 in ('COMPLETED','HANDOFF') then now() else null end,lease_token=null,lease_expires_at=null,error_code=null where organization_id=$1 and id=$2 and lease_token=$3`,[execution.organizationId,execution.id,execution.leaseToken,result.status,result.state.nodeId,JSON.stringify(result.state)]);
    if(result.wait?.kind==='EVENT')await promoteAttendanceInput(tx,execution.organizationId,execution.id,policy);
  },
  async failExecution(tx,org,id,leaseToken,code,unknown){await tx.query(`update automation_executions set status=$4,error_code=$5,updated_at=now(),completed_at=case when $4='FAILED' then now() else null end,lease_token=null,lease_expires_at=null where organization_id=$1 and id=$2 and lease_token=$3`,[org,id,leaseToken,unknown?'UNKNOWN':'FAILED',code]);},
  async getExecution(tx,org,id){return (await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions where organization_id=$1 and id=$2`,[org,id])).rows[0]??null;},
  async listExecutions(tx,org,automationId){return (await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions where organization_id=$1 and ($2::uuid is null or automation_id=$2) order by started_at desc limit 200`,[org,automationId??null])).rows;},
  async listNodeExecutions(tx,org,executionId){return (await tx.query<NodeExecutionRow>(`select id,node_id AS "nodeId",ordinal,status,input,output,error_code AS "errorCode",started_at AS "startedAt",completed_at AS "completedAt" from automation_node_executions where organization_id=$1 and execution_id=$2 order by ordinal`,[org,executionId])).rows;},
  async listExecutionOutbox(tx,org,executionId){return (await tx.query<OutboxInspectionRow>(`select o.id,o.node_id as "nodeId",o.ordinal,o.kind,
    CASE WHEN o.kind='HANDOFF' THEN CASE WHEN o.payload @> '{"handoffVersion":2,"destination":{"kind":"LOCAL"}}'::jsonb THEN 'LOCAL' ELSE 'CENTRAL' END ELSE NULL END AS "handoffDestination",
    (o.kind='IO_AI' and o.payload ? 'aiConfigVersion') as "boundedAi",
    CASE WHEN r.outbox_id IS NULL THEN NULL ELSE jsonb_build_object('status',r.status,'month',r.month::text,'model',r.model,'reservedMicros',r.reserved_micros,'observedMicros',r.observed_micros,'inputTokens',r.input_tokens,'outputTokens',r.output_tokens) END as "aiUsage",
    o.status,o.attempts,o.remote_reference as "remoteReference",o.last_error as "lastError",o.created_at as "createdAt",o.updated_at as "updatedAt" from automation_outbox o left join automation_ai_reservations r on r.organization_id=o.organization_id and r.outbox_id=o.id where o.organization_id=$1 and o.execution_id=$2 order by o.ordinal`,[org,executionId])).rows;},
  async getExecutionContext(tx,org,executionId){return (await tx.query<ExecutionContextRow>(`select e.conversation_id as "conversationId",c.contact_id as "contactId" from automation_executions e left join messaging_conversations c on c.organization_id=e.organization_id and c.id=e.conversation_id where e.organization_id=$1 and e.id=$2`,[org,executionId])).rows[0]??{conversationId:null,contactId:null};},
  async reconcileUnknownOutbox(tx,input){const row=(await tx.query<{status:string;kind:string;boundedAi:boolean}>(`select status,kind,(kind='IO_AI' and payload ? 'aiConfigVersion') as "boundedAi" from automation_outbox where organization_id=$1 and execution_id=$2 and id=$3 for update`,[input.org,input.executionId,input.outboxId])).rows[0];if(!row||row.status!=='UNKNOWN')return false;
    // Native handoff requires canonical remote evidence. An operator label or
    // provider reference is not authority to mark success or replay its POSTs.
    if(row.boundedAi&&input.outcome!=='UNRESOLVED')throw new AttendanceError('AUTOMATION_AI_USAGE_RECONCILIATION_REQUIRED',409);
    if(row.kind==='HANDOFF')throw new AttendanceError('ATTENDANCE_HANDOFF_REMOTE_RECONCILIATION_REQUIRED',409);
    if(['IO_CONVERSATION','SEND_MEDIA'].includes(row.kind)&&input.outcome!=='UNRESOLVED')throw new AttendanceError('AUTOMATION_EFFECT_RECEIPT_REQUIRED',409);
    await tx.query(`insert into automation_reconciliations(organization_id,execution_id,outbox_id,actor_id,outcome,evidence_code,provider_reference) values($1,$2,$3,$4,$5,$6,$7)`,[input.org,input.executionId,input.outboxId,input.actorId,input.outcome,input.evidenceCode,input.providerReference??null]);
    if(input.outcome==='CONFIRMED_SENT')await tx.query(`update automation_outbox set status='SENT',remote_reference=coalesce($4,remote_reference),lease_token=null,lease_expires_at=null,updated_at=now() where organization_id=$1 and execution_id=$2 and id=$3`,[input.org,input.executionId,input.outboxId,input.providerReference??null]);
    if(input.outcome==='CONFIRMED_NOT_SENT')await tx.query(`update automation_outbox set status='PENDING',available_at=now(),lease_token=null,lease_expires_at=null,last_error='MANUAL_RETRY_AFTER_RECONCILIATION',updated_at=now() where organization_id=$1 and execution_id=$2 and id=$3`,[input.org,input.executionId,input.outboxId]);
    return true;},
  async cancelExecution(tx,org,id){
    const execution=(await tx.query<{status:string}>("select status from automation_executions where organization_id=$1 and id=$2 for update",[org,id])).rows[0];
    if(!execution||!['QUEUED','WAITING','FAILED'].includes(execution.status))return false;
    const effects=await tx.query<{status:string}>("select status from automation_outbox where organization_id=$1 and execution_id=$2 order by id for update",[org,id]);
    if(effects.rows.some(row=>['UNKNOWN','SENDING'].includes(row.status)))return false;
    await tx.query("update automation_outbox set status='CANCELED',last_error='EXECUTION_CANCELED',updated_at=now() where organization_id=$1 and execution_id=$2 and status='PENDING'",[org,id]);
    await tx.query("update automation_executions set status='CANCELED',completed_at=now(),updated_at=now(),lease_token=null,lease_expires_at=null where organization_id=$1 and id=$2",[org,id]);
    await tx.query("update automation_waits set status='CANCELED' where organization_id=$1 and execution_id=$2 and status='WAITING'",[org,id]);return true;
  },
  async retryExecution(tx,org,id){const execution=await this.getExecution(tx,org,id);if(!execution)return false;const definition=await this.getDefinition(tx,org,execution.automationId,true);if(!definition||definition.lifecycleStatus==='ARCHIVED')return false;return Boolean((await tx.query(`update automation_executions set status='QUEUED',error_code=null,completed_at=null,updated_at=now() where organization_id=$1 and id=$2 and status='FAILED' and exists(select 1 from automation_definitions d where d.organization_id=$1 and d.id=automation_executions.automation_id and d.lifecycle_status<>'ARCHIVED')`,[org,id])).rowCount);},
  async resumeExecution(tx,row){const execution=await this.getExecution(tx,row.org,row.id);if(execution){const definition=await this.getDefinition(tx,row.org,execution.automationId,true);if(definition?.lifecycleStatus==='ARCHIVED')return false;}if(!execution)return false;const locked=(await tx.query<{status:string;state:RuntimeState}>('select status,state from automation_executions where organization_id=$1 and id=$2 for update',[row.org,row.id])).rows[0];if(!locked||!['WAITING','HANDOFF'].includes(locked.status))return false;
    // A capture is settled only by an admitted MESSAGE or its own deadline.
    if(locked.state?.waiting?.kind==='EVENT'&&locked.state.waiting.waitId!==undefined)return false;
    if(locked.state?.waiting?.kind==='IO'&&locked.state.waiting.waitId!==undefined){
      const waitId=locked.state.waiting.waitId;
      if(row.effectReceiptId!==waitId||row.payload.waitId!==waitId||row.eventKey!==`io:${waitId}`)return false;
      const receipt=(await tx.query<{state:string}>(`select state from automation_conversation_effects
        where organization_id=$1 and outbox_id=$2 and execution_id=$3 and protocol_version=2`,[row.org,waitId,row.id])).rows[0];
      if(!receipt||(row.payload.outcome==='success'?receipt.state!=='CONFIRMED':!['error','timeout'].includes(String(row.payload.outcome))||receipt.state!=='REJECTED'))return false;
    }
    const inserted=await this.insertEvent(tx,{org:row.org,id:row.eventId,eventKey:row.eventKey,type:'EXPLICIT_RESUME',payload:row.payload});if(!inserted)return true;await tx.query(`update automation_executions set status='QUEUED',input=$3,updated_at=now(),completed_at=null where organization_id=$1 and id=$2`,[row.org,row.id,JSON.stringify({...row.payload,eventType:'RESUME'})]);await tx.query(`update automation_waits set status='RESUMED',resume_event_key=$3,resumed_at=now() where organization_id=$1 and execution_id=$2 and status='WAITING'`,[row.org,row.id,row.eventKey]);await tx.query(`update automation_events set execution_id=$3,status='CONSUMED',consumed_at=now() where organization_id=$1 and id=$2`,[row.org,row.eventId,row.id]);return true;},
  async releaseDueWaits(tx,org,limit){
    // Lock executions before waits, matching cancel/resume. A canceled execution cannot be requeued.
    const candidates=(await tx.query<{id:string;channelId:string}>(`select e.id,e.channel_id as "channelId" from automation_executions e where e.organization_id=$1 and ${runtimeTenantActive} and e.status='WAITING'
      and exists(select 1 from automation_waits w where w.organization_id=e.organization_id and w.execution_id=e.id and w.status='WAITING'
        and ((w.kind='DELAY' and w.wake_at<=now()) or (w.kind='EVENT' and w.deadline_at<=clock_timestamp()))) order by e.updated_at,e.id limit $2`,[org,limit])).rows;
    for(const channel of [...new Set(candidates.map(row=>row.channelId))].sort())await lockAttendanceChannelRead(tx,org,channel);
    const due=await tx.query<{id:string}>(`select e.id from automation_executions e where e.organization_id=$1 and e.id=any($2::uuid[]) and e.status='WAITING'
      order by e.updated_at,e.id for update of e skip locked`,[org,candidates.map(row=>row.id)]);
    let released=0;
    for(const row of due.rows){if(await promoteAttendanceInput(tx,org,row.id,policy)){released++;continue;}
      const wait=await tx.query(`update automation_waits set status='RESUMED',resumed_at=now() where organization_id=$1 and execution_id=$2 and kind='DELAY' and status='WAITING' and wake_at<=now()`,[org,row.id]);
      if(wait.rowCount){await tx.query(`update automation_executions set status='QUEUED',input='{"eventType":"TIMER"}'::jsonb,updated_at=now() where organization_id=$1 and id=$2 and status='WAITING'`,[org,row.id]);released++;}}
    return released;
  },
  async claimOutbox(tx,org,leaseToken,leaseMs,kinds,recipientKind){
    const candidates=(await tx.query<{id:string;executionId:string;channelId:string;kind:OutboxKind;recoverLocal:boolean}>(`select o.id,o.execution_id AS "executionId",e.channel_id AS "channelId",o.kind,o.status='UNKNOWN' AS "recoverLocal"
      from automation_outbox o join automation_executions e on e.organization_id=o.organization_id and e.id=o.execution_id
      where o.organization_id=$1 and ${runtimeTenantActive} and ${outboxClaimEligible} and o.kind=any($2::text[])
      and e.status NOT IN ('CANCELED','FAILED','UNKNOWN') and ${outboxHeadEligible}
      and (($3::text IS NULL AND NOT EXISTS(SELECT 1 FROM messaging_conversations m WHERE m.organization_id=e.organization_id AND m.id=e.conversation_id AND m.recipient_kind='GROUP'))
        OR EXISTS(SELECT 1 FROM messaging_conversations m WHERE m.organization_id=e.organization_id AND m.id=e.conversation_id AND m.recipient_kind=$3))
      order by o.created_at,o.execution_id,o.ordinal,o.id limit 50`,[org,kinds,recipientKind??null])).rows;
    for(const channel of [...new Set(candidates.map(row=>row.channelId))].sort())await lockAttendanceChannelRead(tx,org,channel);
    const locked=(await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions where organization_id=$1 and id=any($2::uuid[])
      and status NOT IN ('CANCELED','FAILED','UNKNOWN') order by id for no key update skip locked`,[org,candidates.map(row=>row.executionId)])).rows;
    for(const candidate of candidates){
      const execution=locked.find(row=>row.id===candidate.executionId);if(!execution)continue;
      const permitted=await authority(tx,{...execution,executionId:execution.id},candidate.kind!=='HANDOFF');
      if(!permitted&&!candidate.recoverLocal)continue;
      // Recheck after the execution lock, in a fresh READ COMMITTED statement.
      // The candidate list can be stale. The reservation becomes UNKNOWN before
      // commit, so subsequent workers still see the barrier during external IO.
      const available=(await tx.query(`select o.id from automation_outbox o where o.organization_id=$1 and o.id=$2
        and ${outboxClaimEligible} and o.kind=any($3::text[]) and ${outboxHeadEligible}
        for update of o skip locked`,[org,candidate.id,kinds])).rowCount;
      if(!available)continue;
      if(!permitted){
        // No local transaction committed and current authority no longer allows
        // it. Close this barrier without changing the new owner or human state.
        await tx.query(`UPDATE automation_outbox SET status='FAILED',last_error='HANDOFF_AUTHORITY_CHANGED',
          lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2
          AND status='UNKNOWN' AND ${outboxClaimEligible.replaceAll('o.','automation_outbox.')}`,[org,candidate.id]);
        continue;
      }
      return (await tx.query<OutboxRow>(`update automation_outbox set status='UNKNOWN',attempts=attempts+1,lease_token=$3,
        lease_expires_at=now()+($4::int*interval '1 millisecond'),updated_at=now() where organization_id=$1 and id=$2
        returning id,organization_id AS "organizationId",execution_id AS "executionId",$5::uuid AS "channelId",$6::uuid AS "conversationId",
          node_id AS "nodeId",ordinal,kind,payload,attempts,lease_token AS "leaseToken"`,
        [org,candidate.id,leaseToken,leaseMs,execution.channelId,execution.conversationId])).rows[0]??null;
    }
    return null;
  },
  async settleOutbox(tx,org,id,leaseToken,result){return Boolean((await tx.query(`update automation_outbox set status=$4,remote_reference=coalesce($5,remote_reference),last_error=$6,available_at=coalesce($7,available_at),lease_token=null,lease_expires_at=null,updated_at=now() where organization_id=$1 and id=$2 and lease_token=$3 and status='UNKNOWN'`,[org,id,leaseToken,result.status,result.remoteReference??null,result.error??null,result.availableAt??null])).rowCount);},
  async hasCommittedHandoffResult(tx,item,result){
    if(item.kind!=='HANDOFF'||!item.conversationId||(result.status==='SENT'?!result.remoteReference:!result.error))return false;
    // Acknowledgment only: never mutate/requeue a terminal row or run IO here.
    // Local FAILED records prove a terminal failure, not which lease authored it.
    // External handoffs additionally require their durable operation and lease.
    return Boolean((await tx.query(`SELECT 1 FROM automation_outbox o
      JOIN automation_executions e ON e.organization_id=o.organization_id AND e.id=o.execution_id
      WHERE o.organization_id=$1 AND o.id=$2 AND o.execution_id=$3 AND e.channel_id=$4
        AND e.conversation_id=$5 AND o.node_id=$6 AND o.ordinal=$7 AND o.payload=$8::jsonb
        AND o.kind='HANDOFF' AND o.status=$9 AND o.lease_token IS NULL AND o.lease_expires_at IS NULL
        AND (
          (o.payload @> '{"handoffVersion":2}'::jsonb
            AND NOT EXISTS(SELECT 1 FROM attendance_handoff_operations h
              WHERE h.organization_id=o.organization_id AND h.outbox_id=o.id)
            AND (($9='SENT' AND o.payload @> '{"destination":{"kind":"LOCAL"}}'::jsonb
                AND o.payload #>> '{destination,organizationId}'=o.organization_id::text
                AND o.payload #>> '{destination,channelId}'=e.channel_id::text
                AND o.last_error IS NULL AND o.remote_reference='local-handoff:'||o.id::text AND o.remote_reference=$10)
              OR ($9='FAILED' AND o.remote_reference IS NULL AND o.last_error=$11)))
          OR
          (NOT (o.payload @> '{"handoffVersion":2}'::jsonb)
            AND EXISTS(SELECT 1 FROM attendance_handoff_operations h
              WHERE h.organization_id=o.organization_id AND h.outbox_id=o.id AND h.execution_id=o.execution_id
                AND h.channel_id=e.channel_id AND h.conversation_id=e.conversation_id AND h.lease_token=$12
                AND (($9='SENT' AND h.state='APPLIED' AND h.phase='CONFIRMED' AND h.last_error IS NULL
                  AND o.last_error IS NULL AND o.remote_reference='chatwoot-handoff:'||h.id::text AND o.remote_reference=$10)
                  OR ($9='FAILED' AND h.state='ACTION_REQUIRED' AND h.phase IN ('PREPARED','OPEN_DISPATCHED')
                    AND h.last_error=$11 AND o.last_error=$11 AND o.remote_reference IS NULL))))
        )`,[item.organizationId,item.id,item.executionId,item.channelId,item.conversationId,item.nodeId,item.ordinal,JSON.stringify(item.payload),
          result.status,result.status==='SENT'?result.remoteReference:null,result.status==='FAILED'?result.error:null,item.leaseToken])).rowCount);
  },
  async recordUnknownOutbox(tx,org,id,leaseToken,error){return Boolean((await tx.query(`update automation_outbox set last_error=$4,updated_at=now() where organization_id=$1 and id=$2 and lease_token=$3 and status='UNKNOWN'`,[org,id,leaseToken,unknownOutboxDiagnostic(error)])).rowCount);},
};}
import { lockAttendanceChannelRead } from '../attendance/repository.js';
