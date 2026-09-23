import type { AutomationGraphV1 } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { RuntimeResult, RuntimeState } from './types.js';

export interface DefinitionRow {id:string;organizationId:string;name:string;lifecycleStatus:'DRAFT'|'PUBLISHED'|'ARCHIVED';draftGraph:AutomationGraphV1;draftRevision:number;activeVersion:number|null;updatedAt:Date}
export interface VersionRow {automationId:string;organizationId:string;version:number;graph:AutomationGraphV1;checksum:string;publishedAt:Date}
export interface BindingRow {id:string;organizationId:string;automationId:string;version:number;channelId:string;humanDestinationId:string|null;status:'ACTIVE'|'PAUSED'|'DISABLED';revision:number;createdAt:Date;updatedAt:Date}
export interface ExecutionRow {id:string;organizationId:string;automationId:string;version:number;bindingId:string;channelId:string;conversationId:string|null;status:string;currentNodeId:string|null;correlationId:string;state:RuntimeState;input:Record<string,unknown>;errorCode:string|null;attempts:number;startedAt:Date;updatedAt:Date;completedAt:Date|null;leaseToken:string|null}
export type OutboxKind='SEND_TEXT'|'HANDOFF'|'RESUME_EVENT'|'IO_HTTP'|'IO_SQL'|'IO_CODE'|'IO_AI';
export interface OutboxRow {id:string;organizationId:string;executionId:string;channelId:string;conversationId:string|null;nodeId:string;ordinal:number;kind:OutboxKind;payload:Record<string,unknown>;attempts:number;leaseToken:string}
export interface NodeExecutionRow {id:string;nodeId:string;ordinal:number;status:string;input:Record<string,unknown>;output:Record<string,unknown>;errorCode:string|null;startedAt:Date;completedAt:Date|null}
export interface OutboxInspectionRow {id:string;nodeId:string;ordinal:number;kind:OutboxKind;status:string;attempts:number;remoteReference:string|null;lastError:string|null;createdAt:Date;updatedAt:Date}
export interface ExecutionContextRow {conversationId:string|null;contactId:string|null}

const definitionColumns=`id,organization_id AS "organizationId",name,lifecycle_status AS "lifecycleStatus",draft_graph AS "draftGraph",draft_revision AS "draftRevision",active_version AS "activeVersion",updated_at AS "updatedAt"`;
const versionColumns=`automation_id AS "automationId",organization_id AS "organizationId",version,graph,checksum,published_at AS "publishedAt"`;
const bindingColumns=`id,organization_id AS "organizationId",automation_id AS "automationId",version,channel_id AS "channelId",human_destination_id AS "humanDestinationId",status,revision,created_at AS "createdAt",updated_at AS "updatedAt"`;
const executionColumns=`id,organization_id AS "organizationId",automation_id AS "automationId",version,binding_id AS "bindingId",channel_id AS "channelId",conversation_id AS "conversationId",status,current_node_id AS "currentNodeId",correlation_id AS "correlationId",state,input,error_code AS "errorCode",attempts,started_at AS "startedAt",updated_at AS "updatedAt",completed_at AS "completedAt",lease_token AS "leaseToken"`;
const claimedExecutionColumns=executionColumns.split(',').map(column=>`e.${column}`).join(',');

export interface AutomationRepository {
 listDefinitions(tx:TenantTransaction,org:string):Promise<DefinitionRow[]>;
 getDefinition(tx:TenantTransaction,org:string,id:string,lock?:boolean):Promise<DefinitionRow|null>;
 insertDefinition(tx:TenantTransaction,row:{org:string;id:string;name:string;graph:AutomationGraphV1}):Promise<DefinitionRow>;
 updateDefinition(tx:TenantTransaction,row:{org:string;id:string;name:string;graph:AutomationGraphV1;revision:number}):Promise<DefinitionRow|null>;
 insertVersion(tx:TenantTransaction,row:{org:string;id:string;version:number;graph:AutomationGraphV1;checksum:string}):Promise<VersionRow>;
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
 resumeExecution(tx:TenantTransaction,row:{org:string;id:string;eventId:string;eventKey:string;payload:Record<string,unknown>}):Promise<boolean>;
 releaseDueWaits(tx:TenantTransaction,org:string,limit:number):Promise<number>;
 claimOutbox(tx:TenantTransaction,org:string,leaseToken:string,leaseMs:number,kinds:OutboxKind[]):Promise<OutboxRow|null>;
 settleOutbox(tx:TenantTransaction,org:string,id:string,leaseToken:string,result:{status:'SENT'|'PENDING'|'FAILED';remoteReference?:string;error?:string;availableAt?:Date}):Promise<boolean>;
}

export function createPostgresAutomationRepository():AutomationRepository{return {
  async listDefinitions(tx,org){return (await tx.query<DefinitionRow>(`select ${definitionColumns} from automation_definitions where organization_id=$1 order by updated_at desc limit 200`,[org])).rows;},
  async getDefinition(tx,org,id,lock=false){return (await tx.query<DefinitionRow>(`select ${definitionColumns} from automation_definitions where organization_id=$1 and id=$2 ${lock?'for update':''}`,[org,id])).rows[0]??null;},
  async insertDefinition(tx,row){return (await tx.query<DefinitionRow>(`insert into automation_definitions(organization_id,id,name,draft_graph) values($1,$2,$3,$4) returning ${definitionColumns}`,[row.org,row.id,row.name,JSON.stringify(row.graph)])).rows[0]!;},
  async updateDefinition(tx,row){return (await tx.query<DefinitionRow>(`update automation_definitions set name=$3,draft_graph=$4,draft_revision=draft_revision+1,updated_at=now() where organization_id=$1 and id=$2 and draft_revision=$5 and lifecycle_status<>'ARCHIVED' returning ${definitionColumns}`,[row.org,row.id,row.name,JSON.stringify(row.graph),row.revision])).rows[0]??null;},
  async insertVersion(tx,row){return (await tx.query<VersionRow>(`insert into automation_versions(organization_id,automation_id,version,graph,checksum) values($1,$2,$3,$4,$5) returning ${versionColumns}`,[row.org,row.id,row.version,JSON.stringify(row.graph),row.checksum])).rows[0]!;},
  async activateVersion(tx,org,id,version){return (await tx.query<DefinitionRow>(`update automation_definitions set active_version=$3,lifecycle_status='PUBLISHED',updated_at=now() where organization_id=$1 and id=$2 returning ${definitionColumns}`,[org,id,version])).rows[0]!;},
  async getVersion(tx,org,id,version){return (await tx.query<VersionRow>(`select ${versionColumns} from automation_versions where organization_id=$1 and automation_id=$2 and version=$3`,[org,id,version])).rows[0]??null;},
  async listVersions(tx,org,id){return (await tx.query<VersionRow>(`select ${versionColumns} from automation_versions where organization_id=$1 and automation_id=$2 order by version desc`,[org,id])).rows;},
  async listBindings(tx,org,id){return (await tx.query<BindingRow>(`select ${bindingColumns} from automation_bindings where organization_id=$1 and automation_id=$2 order by created_at desc`,[org,id])).rows;},
  async insertBinding(tx,row){return (await tx.query<BindingRow>(`insert into automation_bindings(organization_id,id,automation_id,version,channel_id,human_destination_id) select $1,$2,$3,$4,c.id,$6 from messaging_channels c where c.organization_id=$1 and c.id=$5 returning ${bindingColumns}`,[row.org,row.id,row.automationId,row.version,row.channelId,row.humanDestinationId])).rows[0]!;},
  async setBindingStatus(tx,org,id,status,revision){return (await tx.query<BindingRow>(`update automation_bindings set status=$3,revision=revision+1,updated_at=now() where organization_id=$1 and id=$2 and revision=$4 returning ${bindingColumns}`,[org,id,status,revision])).rows[0]??null;},
  async insertEvent(tx,row){return Boolean((await tx.query(`insert into automation_events(organization_id,id,event_key,type,payload) values($1,$2,$3,$4,$5) on conflict(organization_id,event_key) do nothing returning id`,[row.org,row.id,row.eventKey,row.type,JSON.stringify(row.payload)])).rowCount);},
  async routeEvent(tx,row){
    const binding=(await tx.query<BindingRow>(`select ${bindingColumns} from automation_bindings where organization_id=$1 and channel_id=$2 and status='ACTIVE' for update`,[row.org,row.channelId])).rows[0];if(!binding)return null;
    const waiting=row.conversationId?(await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions where organization_id=$1 and binding_id=$2 and conversation_id=$3 and status='WAITING' order by updated_at desc limit 1 for update`,[row.org,binding.id,row.conversationId])).rows[0]:undefined;
    if(waiting){await tx.query(`update automation_executions set status='QUEUED',input=$3,updated_at=now(),lease_token=null,lease_expires_at=null where organization_id=$1 and id=$2`,[row.org,waiting.id,JSON.stringify(row.input)]);await tx.query(`update automation_waits set status='RESUMED',resume_event_key=$3,resumed_at=now() where organization_id=$1 and execution_id=$2 and status='WAITING'`,[row.org,waiting.id,row.eventKey]);await tx.query(`update automation_events set execution_id=$3,status='CONSUMED',consumed_at=now() where organization_id=$1 and id=$2`,[row.org,row.eventId,waiting.id]);return {execution:{...waiting,status:'QUEUED',input:row.input},resumed:true};}
    const created=(await tx.query<ExecutionRow>(`insert into automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,input,state) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}') returning ${executionColumns}`,[row.org,row.executionId,binding.automationId,binding.version,binding.id,row.channelId,row.conversationId,row.eventKey,row.correlationId,JSON.stringify(row.input)])).rows[0]!;
    await tx.query(`update automation_events set execution_id=$3,status='CONSUMED',consumed_at=now() where organization_id=$1 and id=$2`,[row.org,row.eventId,created.id]);return {execution:created,resumed:false};
  },
  async claimExecution(tx,org,leaseToken,leaseMs){return (await tx.query<ExecutionRow>(`with candidate as (select id from automation_executions where organization_id=$1 and (status='QUEUED' or (status='RUNNING' and lease_expires_at<now())) order by updated_at for update skip locked limit 1) update automation_executions e set status='RUNNING',attempts=attempts+1,lease_token=$2,lease_expires_at=now()+($3::int*interval '1 millisecond'),updated_at=now() from candidate c where e.organization_id=$1 and e.id=c.id returning ${claimedExecutionColumns}`,[org,leaseToken,leaseMs])).rows[0]??null;},
  async saveExecutionResult(tx,execution,result){
    const turnOffset=execution.attempts*1000;
    for(const [ordinal,node] of result.trace.entries())await tx.query(`insert into automation_node_executions(organization_id,execution_id,node_id,ordinal,status,input,output,completed_at) values($1,$2,$3,$4,'COMPLETED',$5,$6,now()) on conflict(organization_id,execution_id,ordinal) do nothing`,[execution.organizationId,execution.id,node.nodeId,turnOffset+ordinal,JSON.stringify(node.input),JSON.stringify(node.output)]);
    for(const node of result.trace.filter(item=>item.type==='subflow-result'&&typeof item.output.automationId==='string'))await tx.query(
      `insert into automation_child_executions(organization_id,parent_execution_id,node_id,automation_id,version,correlation_id,status,input,output) values($1,$2,$3,$4,$5,$6,'COMPLETED',$7,$8)`,
      [execution.organizationId,execution.id,node.nodeId,node.output.automationId,Number(node.output.version),node.output.correlationId,JSON.stringify(node.input),JSON.stringify(node.output.variables??{})]);
    for(const effect of result.effects)await tx.query(`insert into automation_outbox(organization_id,execution_id,node_id,ordinal,kind,payload) values($1,$2,$3,$4,$5,$6) on conflict(organization_id,execution_id,node_id,ordinal) do nothing`,[execution.organizationId,execution.id,effect.nodeId,turnOffset+effect.ordinal,effect.kind,JSON.stringify(effect.payload)]);
    if(result.wait)await tx.query(`insert into automation_waits(organization_id,execution_id,node_id,kind,wake_at,state) values($1,$2,$3,$4,$5,$6)`,[execution.organizationId,execution.id,result.wait.nodeId,result.wait.kind,result.wait.wakeAt??null,JSON.stringify(result.state)]);
    await tx.query(`update automation_executions set status=$4,current_node_id=$5,state=$6,updated_at=now(),completed_at=case when $4 in ('COMPLETED','HANDOFF') then now() else null end,lease_token=null,lease_expires_at=null,error_code=null where organization_id=$1 and id=$2 and lease_token=$3`,[execution.organizationId,execution.id,execution.leaseToken,result.status,result.state.nodeId,JSON.stringify(result.state)]);
  },
  async failExecution(tx,org,id,leaseToken,code,unknown){await tx.query(`update automation_executions set status=$4,error_code=$5,updated_at=now(),completed_at=case when $4='FAILED' then now() else null end,lease_token=null,lease_expires_at=null where organization_id=$1 and id=$2 and lease_token=$3`,[org,id,leaseToken,unknown?'UNKNOWN':'FAILED',code]);},
  async getExecution(tx,org,id){return (await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions where organization_id=$1 and id=$2`,[org,id])).rows[0]??null;},
  async listExecutions(tx,org,automationId){return (await tx.query<ExecutionRow>(`select ${executionColumns} from automation_executions where organization_id=$1 and ($2::uuid is null or automation_id=$2) order by started_at desc limit 200`,[org,automationId??null])).rows;},
  async listNodeExecutions(tx,org,executionId){return (await tx.query<NodeExecutionRow>(`select id,node_id AS "nodeId",ordinal,status,input,output,error_code AS "errorCode",started_at AS "startedAt",completed_at AS "completedAt" from automation_node_executions where organization_id=$1 and execution_id=$2 order by ordinal`,[org,executionId])).rows;},
  async listExecutionOutbox(tx,org,executionId){return (await tx.query<OutboxInspectionRow>(`select id,node_id as "nodeId",ordinal,kind,status,attempts,remote_reference as "remoteReference",last_error as "lastError",created_at as "createdAt",updated_at as "updatedAt" from automation_outbox where organization_id=$1 and execution_id=$2 order by ordinal`,[org,executionId])).rows;},
  async getExecutionContext(tx,org,executionId){return (await tx.query<ExecutionContextRow>(`select e.conversation_id as "conversationId",c.contact_id as "contactId" from automation_executions e left join messaging_conversations c on c.organization_id=e.organization_id and c.id=e.conversation_id where e.organization_id=$1 and e.id=$2`,[org,executionId])).rows[0]??{conversationId:null,contactId:null};},
  async reconcileUnknownOutbox(tx,input){const row=(await tx.query<{status:string}>(`select status from automation_outbox where organization_id=$1 and execution_id=$2 and id=$3 for update`,[input.org,input.executionId,input.outboxId])).rows[0];if(!row||row.status!=='UNKNOWN')return false;
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
  async resumeExecution(tx,row){const execution=await this.getExecution(tx,row.org,row.id);if(execution){const definition=await this.getDefinition(tx,row.org,execution.automationId,true);if(definition?.lifecycleStatus==='ARCHIVED')return false;}if(!execution)return false;const locked=(await tx.query<{status:string}>('select status from automation_executions where organization_id=$1 and id=$2 for update',[row.org,row.id])).rows[0];if(!locked||!['WAITING','HANDOFF'].includes(locked.status))return false;const inserted=await this.insertEvent(tx,{org:row.org,id:row.eventId,eventKey:row.eventKey,type:'EXPLICIT_RESUME',payload:row.payload});if(!inserted)return true;await tx.query(`update automation_executions set status='QUEUED',input=$3,updated_at=now(),completed_at=null where organization_id=$1 and id=$2`,[row.org,row.id,JSON.stringify({...row.payload,eventType:'RESUME'})]);await tx.query(`update automation_waits set status='RESUMED',resume_event_key=$3,resumed_at=now() where organization_id=$1 and execution_id=$2 and status='WAITING'`,[row.org,row.id,row.eventKey]);await tx.query(`update automation_events set execution_id=$3,status='CONSUMED',consumed_at=now() where organization_id=$1 and id=$2`,[row.org,row.eventId,row.id]);return true;},
  async releaseDueWaits(tx,org,limit){
    // Lock executions before waits, matching cancel/resume. A canceled execution cannot be requeued.
    const due=await tx.query<{id:string}>(`select e.id from automation_executions e where e.organization_id=$1 and e.status='WAITING'
      and exists(select 1 from automation_waits w where w.organization_id=e.organization_id and w.execution_id=e.id and w.kind='DELAY' and w.status='WAITING' and w.wake_at<=now())
      order by e.updated_at for update of e skip locked limit $2`,[org,limit]);
    let released=0;
    for(const row of due.rows){const wait=await tx.query(`update automation_waits set status='RESUMED',resumed_at=now() where organization_id=$1 and execution_id=$2 and kind='DELAY' and status='WAITING' and wake_at<=now()`,[org,row.id]);
      if(wait.rowCount){await tx.query(`update automation_executions set status='QUEUED',input='{"eventType":"TIMER"}'::jsonb,updated_at=now() where organization_id=$1 and id=$2 and status='WAITING'`,[org,row.id]);released++;}}
    return released;
  },
  async claimOutbox(tx,org,leaseToken,leaseMs,kinds){return (await tx.query<OutboxRow>(`with candidate as (select id from automation_outbox where organization_id=$1 and status='PENDING' and available_at<=now() and kind=any($4::text[]) order by created_at for update skip locked limit 1), claimed as (update automation_outbox o set status='UNKNOWN',attempts=attempts+1,lease_token=$2,lease_expires_at=now()+($3::int*interval '1 millisecond'),updated_at=now() from candidate c where o.organization_id=$1 and o.id=c.id returning o.*) select c.id,c.organization_id AS "organizationId",c.execution_id AS "executionId",e.channel_id AS "channelId",e.conversation_id AS "conversationId",c.node_id AS "nodeId",c.ordinal,c.kind,c.payload,c.attempts,c.lease_token AS "leaseToken" from claimed c join automation_executions e on e.organization_id=c.organization_id and e.id=c.execution_id`,[org,leaseToken,leaseMs,kinds])).rows[0]??null;},
  async settleOutbox(tx,org,id,leaseToken,result){return Boolean((await tx.query(`update automation_outbox set status=$4,remote_reference=coalesce($5,remote_reference),last_error=$6,available_at=coalesce($7,available_at),lease_token=null,lease_expires_at=null,updated_at=now() where organization_id=$1 and id=$2 and lease_token=$3 and status='UNKNOWN'`,[org,id,leaseToken,result.status,result.remoteReference??null,result.error??null,result.availableAt??null])).rowCount);},
};}
