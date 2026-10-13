import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AUTOMATION_NODE_CATALOG_V1,AutomationGraphV1Schema,type AutomationGraphV1} from '@jrc/contracts';
import {SimulationInputSchema} from '../../automations/simulation.js';
import {convertAutomationArtifact} from '../../automation-integrations/importer.js';
import {createChatwootAttendanceService} from '../../integrations/chatwoot-attendance-service.js';
import {createLocalAttendanceCatalog} from '../../attendance/local-catalog.js';
import {createLocalAttendanceDirectory} from '../../attendance/local-directory.js';
import type {OrganizationTransaction,TenantTransaction} from '../../../db/tenant-transaction.js';
import {AutomationError,createAutomationService,requireAutomationDraftAccess,type AutomationServiceOptions} from '../../automations/service.js';
import {createPostgresAutomationRepository,type DefinitionPageRow} from '../../automations/repository.js';
import {lockOwnershipMutations,readOwnerRevision} from '../../attendance/transition.js';
import {lockAttendanceChannel} from '../../attendance/repository.js';
import {readChatwootAccount,type AccountRow} from '../../integrations/chatwoot-context.js';
import type {ChatwootClient} from '../../integrations/chatwoot-client.js';
import type {ChatwootHealth} from '../../integrations/chatwoot-health.js';
import {claimIdempotency,completeIdempotencyRecord,hashIdempotencyRequest} from '../../instances/idempotency.js';
import {FlowDraftCreateSchema,FlowDraftSaveSchema,FlowPublishSchema,FlowBindSchema,FlowSessionCreateSchema,FlowIntrospectionDecisionSchema} from '@jrc/contracts';
import {createDelegatedCutovers,type CutoverRequest} from './cutover.js';
import {createChannelFacade} from '../../channels/facade.js';
import {remoteDeadline} from './remote.js';
import {NativeContextQuerySchema,NativeContextResponseSchema} from './native-context.js';

export type FlowScope='flow:read'|'flow:edit'|'flow:publish'|'flow:bind';
export interface BrokerPrincipal {organizationId:string;actorId:string;authVersion:number}
export interface FlowAccess {organizationId:string;token:string}
export interface FlowDelegationOptions {
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
 automation?:Omit<AutomationServiceOptions,'transact'|'repository'>;
 client?(account:AccountRow):ChatwootClient;
 identity?:ChatwootHealth;
 chatwootStatus?:(org:string)=>Promise<import('@jrc/contracts').ChatwootStatus>;
 remoteTimeoutMs?:number;
 knownNativeOrigins?:ReadonlySet<string>;
 nativeAdapter?:{introspect(request:NativeRequest,context:{organizationId:string;origin:string},signal:AbortSignal):Promise<unknown>;fenceAndDrain(request:Record<string,unknown>,signal:AbortSignal):Promise<unknown>;observeFence(request:Record<string,unknown>,signal:AbortSignal):Promise<unknown>};
}
export class FlowDelegationError extends Error {
 constructor(readonly code:string,readonly statusCode=403){super(code);}
}
function fail(code='FLOW_ACCESS_DENIED',status=403):never{throw new FlowDelegationError(code,status);}
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
const scopes=z.array(z.enum(['flow:read','flow:edit','flow:publish','flow:bind'])).min(1).max(4).refine(v=>new Set(v).size===v.length);
const integrationIds=z.array(z.uuid()).min(1).max(100).refine(v=>new Set(v).size===v.length);
const brokerSessionInput=z.strictObject({integrationIds,scopes});
export interface Mapping {integration_id:string;channel_id:string;inbox_id:string;account_id:string;destination_revision:number;scopes:FlowScope[];transport:string;provider:string|null}
interface SessionRow {id:string;actor_kind:'BROKER'|'JRC_NATIVE';user_id:string|null;auth_version:number|null;
 credential_id:string|null;credential_revision:number|null;external_actor_id:string|null;nonce:string;
 account_id:string;destination_origin:string;destination_revision:number;account_credential_version:number}
export interface Authority {session:SessionRow;role:string;account:AccountRow;grants:Mapping[]}
export interface FlowOriginCapability {kind:'STOCK'|'JRC_NATIVE';revision:number;host_source_sha:string|null;host_image_digest:string|null;fence_protocol_version:number|null}
export async function readFlowOriginCapability(tx:TenantTransaction,a:AccountRow,knownNativeOrigins?:ReadonlySet<string>):Promise<FlowOriginCapability>{
 const row=(await tx.query<FlowOriginCapability&{revoked_at:Date|null}>('SELECT * FROM lock_current_flow_origin_capability($1)',[a.base_url])).rows[0];
 if(knownNativeOrigins?.has(a.base_url)&&(!row||row.kind!=='JRC_NATIVE'||row.revoked_at))fail('FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED',409);
 if(!row)fail('FLOW_ORIGIN_CAPABILITY_REQUIRED',409);if(row.revoked_at)fail('FLOW_ORIGIN_CAPABILITY_REVOKED',409);return row;
}
export interface NativeRequest {nonce:string;externalActorId:string;accountId:number;destinationRevision:number;inboxIds:number[]}
interface NativeDecision {request:NativeRequest;value:z.infer<typeof FlowIntrospectionDecisionSchema>;checkedAt:number}
interface Request {action:FlowScope;id?:string;scopeRevision?:number;createIntegrations?:string[];bind?:CutoverRequest;mutation?:'FLOW_DRAFT_CREATED'|'FLOW_DRAFT_SAVED'|'FLOW_PUBLISHED'|'FLOW_BOUND'}

/** A scoped facade over the canonical service. Each canonical transaction runs
 * current authority before and after its work; no remote IO holds these locks. */
export function createFlowDelegationService(options:FlowDelegationOptions){
 const remoteTimeoutMs=z.number().int().min(1).max(10000).parse(options.remoteTimeoutMs??10000);
 const repository=createPostgresAutomationRepository();
 async function brokerMember(tx:TenantTransaction,principal:BrokerPrincipal,write:boolean){
  z.uuid().parse(principal.organizationId);z.uuid().parse(principal.actorId);z.number().int().nonnegative().parse(principal.authVersion);
  await lockOwnershipMutations(tx,principal.organizationId);
  await requireAutomationDraftAccess(tx,principal.organizationId);
  const member=(await tx.query<{role:string}>('SELECT role FROM lock_local_attendance_member($1)',[principal.actorId])).rows[0];
  const auth=(await tx.query<{valid:boolean}>('SELECT current_tenant_authentication_valid($1,$2) AS valid',[principal.actorId,principal.authVersion])).rows[0];
  if(!member||!auth?.valid||write&&!['OWNER','ADMIN'].includes(member.role))fail();
  return member.role;
 }
 async function account(tx:TenantTransaction,org:string){
  await tx.query('SELECT a.organization_id FROM chatwoot_accounts a JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url WHERE a.organization_id=$1 FOR SHARE OF a,d',[org]);
  const value=await readChatwootAccount(tx,org);
  if(!value||value.status!=='READY'||!value.account_id||!value.encrypted_token||value.destination?.approvalStatus!=='APPROVED')fail('FLOW_CONTEXT_CHANGED',409);
  return value;
 }
 async function mapping(tx:TenantTransaction,org:string,ids:string[],a:AccountRow){
  const connections=(await tx.query<{id:string;channel_id:string}>('SELECT id,channel_id FROM chatwoot_connections WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY channel_id',[org,ids])).rows;
  if(connections.length!==ids.length)fail();
  for(const c of connections)await lockAttendanceChannel(tx,org,c.channel_id);
  const rows=(await tx.query<Mapping>(`SELECT c.id AS integration_id,c.channel_id,c.inbox_id,a.account_id,d.revision AS destination_revision,m.transport,m.provider
   FROM chatwoot_connections c JOIN messaging_channels m ON m.organization_id=c.organization_id AND m.id=c.channel_id
   LEFT JOIN instances i ON i.organization_id=m.organization_id AND i.id=m.instance_id
   JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
   JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
   WHERE c.organization_id=$1 AND c.id=ANY($2::uuid[]) AND c.status='READY' AND m.deleting_at IS NULL
   AND (m.instance_id IS NULL OR i.archived_at IS NULL) FOR SHARE OF c`,[org,ids])).rows;
  if(rows.length!==ids.length||rows.some(r=>Number(r.account_id)!==Number(a.account_id)||r.destination_revision!==a.destination!.revision))fail('FLOW_CONTEXT_CHANGED',409);
  return rows;
 }
 const sameMapping=(a:Mapping,b:Mapping)=>a.integration_id===b.integration_id&&a.channel_id===b.channel_id&&
  Number(a.inbox_id)===Number(b.inbox_id)&&Number(a.account_id)===Number(b.account_id)&&a.destination_revision===b.destination_revision;
 async function nativeDecision(access:FlowAccess):Promise<NativeDecision|undefined>{
  z.uuid().parse(access.organizationId);z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(access.token);
  const snapshot=await options.transact(access.organizationId,async tx=>{
   const s=(await tx.query<SessionRow>('SELECT * FROM flow_delegation_sessions WHERE organization_id=$1 AND token_hash=$2',[access.organizationId,digest(access.token)])).rows[0];
   if(!s||s.actor_kind!=='JRC_NATIVE')return undefined;
   const grants=(await tx.query<Mapping>('SELECT * FROM flow_delegation_session_grants WHERE organization_id=$1 AND session_id=$2 ORDER BY inbox_id',[access.organizationId,s.id])).rows;
   return {request:{nonce:s.nonce,externalActorId:s.external_actor_id!,accountId:Number(s.account_id),destinationRevision:s.destination_revision,inboxIds:grants.map(g=>Number(g.inbox_id))},context:{organizationId:access.organizationId,origin:s.destination_origin}};
  });
  return snapshot?introspect(snapshot.request,snapshot.context):undefined;
 }
 async function introspect(request:NativeRequest,context:{organizationId:string;origin:string}):Promise<NativeDecision>{
  if(!options.nativeAdapter)fail('FLOW_HOST_ADAPTER_REQUIRED',409);
  const checkedAt=Date.now();let result:unknown;
  try{result=await remoteDeadline(remoteTimeoutMs,'FLOW_HOST_AUTHORITY_UNAVAILABLE',signal=>options.nativeAdapter!.introspect(request,context,signal));}catch{fail('FLOW_HOST_AUTHORITY_UNAVAILABLE',503);}
  const value=FlowIntrospectionDecisionSchema.safeParse(result);
  if(!value.success||value.data.nonce!==request.nonce||value.data.externalActorId!==request.externalActorId||value.data.accountId!==request.accountId||value.data.destinationRevision!==request.destinationRevision||JSON.stringify([...value.data.inboxIds].sort((a,b)=>a-b))!==JSON.stringify([...request.inboxIds].sort((a,b)=>a-b)))fail();
  return {request,value:value.data,checkedAt};
 }
 async function credential(tx:TenantTransaction,access:FlowAccess){
  await lockOwnershipMutations(tx,access.organizationId);
  const c=(await tx.query<{id:string;revision:number;scopes:FlowScope[];expires_at:Date;destination_origin:string;account_id:string;destination_revision:number;created_by:string;issuer_auth_version:number}>(`SELECT * FROM flow_delegation_credentials WHERE organization_id=$1 AND token_hash=$2 FOR SHARE`,[access.organizationId,digest(access.token)])).rows[0];
  if(!c)fail();
  await brokerMember(tx,{organizationId:access.organizationId,actorId:c.created_by,authVersion:c.issuer_auth_version},true);
  if(!await delegationLive(tx,access.organizationId,'flow_delegation_credentials',c.id))fail();
  return c;
 }
 async function delegationLive(tx:TenantTransaction,org:string,table:'flow_delegation_credentials'|'flow_delegation_sessions',id:string){
  return (await tx.query<{live:boolean}>(`SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS live FROM ${table} WHERE organization_id=$1 AND id=$2`,[org,id])).rows[0]?.live===true;
 }
 async function currentMemberGrants(tx:TenantTransaction,org:string,user:string,rows:Mapping[],required:FlowScope[]){
  const grants=(await tx.query<{integration_id:string;scopes:FlowScope[]}>('SELECT integration_id,scopes FROM flow_member_grants WHERE organization_id=$1 AND user_id=$2 ORDER BY integration_id FOR SHARE',[org,user])).rows;
  if(rows.some(row=>!grants.some(grant=>grant.integration_id===row.integration_id&&required.every(scope=>grant.scopes.includes(scope)))))fail();
 }
 async function authority(tx:TenantTransaction,access:FlowAccess,action:FlowScope,decision?:NativeDecision):Promise<Authority>{
  z.uuid().parse(access.organizationId);z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(access.token);
  await lockOwnershipMutations(tx,access.organizationId);
  const s=(await tx.query<SessionRow>(`SELECT *
   FROM flow_delegation_sessions WHERE organization_id=$1 AND token_hash=$2 FOR SHARE`,[access.organizationId,digest(access.token)])).rows[0];
  if(!s)fail();let role:string;
  if(s.actor_kind==='BROKER'){
   if(!s.user_id||s.auth_version===null)fail();
   role=await brokerMember(tx,{organizationId:access.organizationId,actorId:s.user_id,authVersion:s.auth_version},action!=='flow:read');
  }else{
   await requireAutomationDraftAccess(tx,access.organizationId);
   const c=(await tx.query<{revision:number;scopes:FlowScope[];created_by:string;issuer_auth_version:number}>(`SELECT * FROM flow_delegation_credentials WHERE organization_id=$1 AND id=$2 FOR SHARE`,[access.organizationId,s.credential_id])).rows[0];
   if(!c||c.revision!==s.credential_revision||!c.scopes.includes(action))fail();
   await brokerMember(tx,{organizationId:access.organizationId,actorId:c.created_by,authVersion:c.issuer_auth_version},true);
   const now=Number((await tx.query<{now:string}>("SELECT extract(epoch FROM clock_timestamp())*1000 AS now")).rows[0]!.now);
   if(!decision||now-decision.checkedAt<0||now-decision.checkedAt>30000||decision.request.nonce!==s.nonce||decision.request.externalActorId!==s.external_actor_id||decision.request.accountId!==Number(s.account_id)||decision.request.destinationRevision!==s.destination_revision||!decision.value.member||!decision.value.accountActive||!decision.value.featureEnabled||decision.value.role===null||action!=='flow:read'&&decision.value.role!=='administrator')fail();
   role=decision.value.role==='administrator'?'ADMIN':'OPERATOR';
  }
  const a=await account(tx,access.organizationId);
  if(a.base_url!==s.destination_origin||Number(a.account_id)!==Number(s.account_id)||a.credential_version!==s.account_credential_version||a.destination!.revision!==s.destination_revision)fail('FLOW_CONTEXT_CHANGED',409);
  const grants=(await tx.query<Mapping>('SELECT * FROM flow_delegation_session_grants WHERE organization_id=$1 AND session_id=$2 ORDER BY integration_id FOR SHARE',[access.organizationId,s.id])).rows;
  if(!grants.length||!grants.some(g=>g.scopes.includes(action)))fail();
  const current=await mapping(tx,access.organizationId,grants.map(g=>g.integration_id),a);
  if(grants.some(g=>!current.some(c=>sameMapping(c,g))))fail('FLOW_CONTEXT_CHANGED',409);
  if(s.actor_kind==='BROKER'&&role==='OPERATOR')await currentMemberGrants(tx,access.organizationId,s.user_id!,grants,[action]);
  if(s.actor_kind==='JRC_NATIVE'&&(!decision||JSON.stringify(grants.map(g=>Number(g.inbox_id)).sort((a,b)=>a-b))!==JSON.stringify([...decision.request.inboxIds].sort((a,b)=>a-b))))fail();
  if(s.actor_kind==='JRC_NATIVE'){
   const origin=await readFlowOriginCapability(tx,a,options.knownNativeOrigins);
   const profiles=(await tx.query<{integration_id:string;destination_origin:string;account_id:string;inbox_id:string;destination_revision:number;account_credential_version:number;origin_capability_revision:number}>("SELECT * FROM flow_executor_profiles WHERE organization_id=$1 AND integration_id=ANY($2::uuid[]) AND host_kind='JRC_NATIVE' FOR SHARE",[access.organizationId,grants.map(g=>g.integration_id)])).rows;
   if(origin.kind!=='JRC_NATIVE'||grants.some(g=>!profiles.some(p=>p.integration_id===g.integration_id&&p.destination_origin===a.base_url&&p.account_id===g.account_id&&p.inbox_id===g.inbox_id&&p.destination_revision===g.destination_revision&&p.account_credential_version===a.credential_version&&p.origin_capability_revision===origin.revision)))fail('FLOW_CONTEXT_CHANGED',409);
  }
  if(!await delegationLive(tx,access.organizationId,'flow_delegation_sessions',s.id)||s.actor_kind==='JRC_NATIVE'&&!await delegationLive(tx,access.organizationId,'flow_delegation_credentials',s.credential_id!))fail();
  if(s.actor_kind==='JRC_NATIVE'){
   const now=Number((await tx.query<{now:string}>("SELECT extract(epoch FROM clock_timestamp())*1000 AS now")).rows[0]!.now);
   if(!decision||now-decision.checkedAt<0||now-decision.checkedAt>30000)fail();
  }
  return {session:s,role,account:a,grants:current.map(row=>({...row,scopes:grants.find(g=>g.integration_id===row.integration_id)!.scopes}))};
 }
 function grantsAllow(state:Authority,rows:Mapping[],action:FlowScope){
  if(!rows.length||rows.some(scope=>!state.grants.some(g=>sameMapping(g,scope)&&g.scopes.includes(action))))fail();
 }
 async function definitionScope(tx:TenantTransaction,org:string,id:string,state:Authority,action:FlowScope,revision?:number){
  const row=(await tx.query<{delegation_scope_revision:number}>('SELECT delegation_scope_revision FROM automation_definitions WHERE organization_id=$1 AND id=$2 FOR SHARE',[org,id])).rows[0];
  if(!row||row.delegation_scope_revision===0)fail('FLOW_DEFINITION_NOT_FOUND',404);
  if(revision!==undefined&&row.delegation_scope_revision!==revision)fail('FLOW_SCOPE_CHANGED',409);
  const rows=(await tx.query<Mapping>('SELECT * FROM automation_definition_scopes WHERE organization_id=$1 AND automation_id=$2 ORDER BY integration_id FOR SHARE',[org,id])).rows;
  grantsAllow(state,rows,action);
  return {rows,revision:row.delegation_scope_revision};
 }
 async function graphScope(tx:TenantTransaction,org:string,graph:AutomationGraphV1,state:Authority,allowed:Mapping[],seen=new Set<string>()){
  for(const node of graph.nodes){
   if(node.type==='handoff'&&node.data.destination&&typeof node.data.destination==='object'){
    const target=node.data.destination as Record<string,unknown>;
    const match=allowed.find(scope=>target.kind==='LOCAL'?scope.channel_id===target.channelId&&target.organizationId===org:scope.integration_id===target.integrationId);
    if(!match||target.kind!=='LOCAL'&&(target.accountId!==Number(match.account_id)||target.inboxId!==Number(match.inbox_id)||target.destinationRevision!==match.destination_revision||target.credentialRevision!==state.account.credential_version))fail();
   }
   if(node.type==='subflow'){
    const id=String(node.data.automationId),version=Number(node.data.version),key=`${id}:${version}`;
    if(seen.has(key))continue;seen.add(key);if(seen.size>1000)fail('FLOW_DEPENDENCY_LIMIT',409);
    const child=await definitionScope(tx,org,id,state,'flow:read');
    if(child.rows.some(row=>!allowed.some(scope=>sameMapping(row,scope))))fail();
    const value=await repository.getVersion(tx,org,id,version);
    if(value)await graphScope(tx,org,value.graph,state,allowed,seen);
   }
  }
 }
 async function guard(tx:TenantTransaction,access:FlowAccess,request:Request,decision?:NativeDecision){
  const state=await authority(tx,access,request.action,decision);
  if(request.id){
   const bound=await definitionScope(tx,access.organizationId,request.id,state,request.action,request.scopeRevision);
   const definition=await repository.getDefinition(tx,access.organizationId,request.id);
   if(definition)await graphScope(tx,access.organizationId,definition.draftGraph,state,bound.rows);
   if(request.bind){const version=await repository.getVersion(tx,access.organizationId,request.id,request.bind.version);if(!version)fail('AUTOMATION_VERSION_NOT_FOUND',404);await graphScope(tx,access.organizationId,version.graph,state,bound.rows);}
  }else if(request.createIntegrations)grantsAllow(state,request.createIntegrations.map(id=>state.grants.find(g=>g.integration_id===id)??fail()),request.action);
  return state;
 }
 const cutovers=createDelegatedCutovers({transact:options.transact,decision:nativeDecision,authorize:(tx,access,decision,action='flow:bind')=>authority(tx,access,action,decision),client:options.client,identity:options.identity,nativeAdapter:options.nativeAdapter,knownNativeOrigins:options.knownNativeOrigins,remoteTimeoutMs});
 function scoped(access:FlowAccess,request:Request,existing?:TenantTransaction,existingDecision?:NativeDecision){
  let state:Authority;
  const delegatedRepository={...repository,
   async listSubflowVersions(tx:TenantTransaction,org:string,rootId:string,input:Parameters<typeof repository.listSubflowVersions>[3]){
    const rows=(await tx.query<Awaited<ReturnType<typeof repository.listSubflowVersions>>['rows'][number]>(`SELECT v.automation_id AS "automationId",d.name,v.version,v.checksum,v.runtime_state_version AS "runtimeStateVersion",v.published_at AS "publishedAt"
      FROM automation_versions v JOIN automation_definitions d ON d.organization_id=v.organization_id AND d.id=v.automation_id
      WHERE v.organization_id=$1 AND v.automation_id<>$2 AND d.lifecycle_status<>'ARCHIVED' AND v.runtime_state_version=2
      AND EXISTS(SELECT 1 FROM automation_definition_scopes s WHERE s.organization_id=d.organization_id AND s.automation_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM automation_definition_scopes s WHERE s.organization_id=d.organization_id AND s.automation_id=d.id AND NOT EXISTS(
       SELECT 1 FROM flow_delegation_session_grants g WHERE g.organization_id=s.organization_id AND g.session_id=$3 AND g.integration_id=s.integration_id AND g.channel_id=s.channel_id AND g.inbox_id=s.inbox_id AND g.account_id=s.account_id AND g.destination_revision=s.destination_revision AND 'flow:read'=ANY(g.scopes)))
      AND NOT EXISTS(SELECT 1 FROM automation_definition_scopes child WHERE child.organization_id=d.organization_id AND child.automation_id=d.id AND NOT EXISTS(
       SELECT 1 FROM automation_definition_scopes root WHERE root.organization_id=child.organization_id AND root.automation_id=$2 AND root.integration_id=child.integration_id AND root.channel_id=child.channel_id AND root.inbox_id=child.inbox_id AND root.destination_revision=child.destination_revision))
      AND ($4::uuid IS NULL OR v.automation_id>$4::uuid OR (v.automation_id=$4::uuid AND v.version<$5)) ORDER BY v.automation_id,v.version DESC LIMIT $6`,
      [org,rootId,state.session.id,input.cursor?.automationId??null,input.cursor?.version??null,input.pageSize+1])).rows;
    for(const row of rows)await definitionScope(tx,org,row.automationId,state,'flow:read');
    return {rows:rows.slice(0,input.pageSize),hasMore:rows.length>input.pageSize};
   },
   async insertDefinition(tx:TenantTransaction,row:Parameters<typeof repository.insertDefinition>[1]){
    const allowed=request.createIntegrations!.map(id=>state.grants.find(g=>g.integration_id===id)!);
    await graphScope(tx,row.org,row.graph,state,allowed);
    const created=await repository.insertDefinition(tx,row);
    for(const scope of allowed)await tx.query(`INSERT INTO automation_definition_scopes(organization_id,automation_id,integration_id,channel_id,account_id,inbox_id,destination_revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,[row.org,row.id,scope.integration_id,scope.channel_id,scope.account_id,scope.inbox_id,scope.destination_revision]);
    await tx.query('UPDATE automation_definitions SET delegation_scope_revision=1 WHERE organization_id=$1 AND id=$2',[row.org,row.id]);
    request.id=row.id;request.scopeRevision=1;
    return created;
   },
   async getDefinition(tx:TenantTransaction,org:string,id:string,lock=false){
    await definitionScope(tx,org,id,state,id===request.id?request.action:'flow:read',id===request.id?request.scopeRevision:undefined);
    return repository.getDefinition(tx,org,id,lock);
   },
   async updateDefinition(tx:TenantTransaction,row:Parameters<typeof repository.updateDefinition>[1]){
    const bound=await definitionScope(tx,row.org,row.id,state,request.action,request.scopeRevision);
    await graphScope(tx,row.org,row.graph,state,bound.rows);return repository.updateDefinition(tx,row);
   },
   async getVersion(tx:TenantTransaction,org:string,id:string,version:number){
    await definitionScope(tx,org,id,state,id===request.id?request.action:'flow:read',id===request.id?request.scopeRevision:undefined);
    return repository.getVersion(tx,org,id,version);
   },
   async listDefinitions(tx:TenantTransaction,org:string,input:Parameters<typeof repository.listDefinitions>[2]){
    const rows=(await tx.query<DefinitionPageRow>(`SELECT d.id,d.organization_id AS "organizationId",d.name,d.lifecycle_status AS "lifecycleStatus",d.draft_graph AS "draftGraph",d.draft_revision AS "draftRevision",d.active_version AS "activeVersion",d.updated_at AS "updatedAt",to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorUpdatedAt"
     FROM automation_definitions d WHERE d.organization_id=$1 AND d.delegation_scope_revision>0
     AND EXISTS(SELECT 1 FROM automation_definition_scopes s WHERE s.organization_id=d.organization_id AND s.automation_id=d.id)
     AND NOT EXISTS(SELECT 1 FROM automation_definition_scopes s WHERE s.organization_id=d.organization_id AND s.automation_id=d.id AND NOT EXISTS(
      SELECT 1 FROM flow_delegation_session_grants g WHERE g.organization_id=s.organization_id AND g.session_id=$2 AND g.integration_id=s.integration_id
       AND g.channel_id=s.channel_id AND g.account_id=s.account_id AND g.inbox_id=s.inbox_id AND g.destination_revision=s.destination_revision AND 'flow:read'=ANY(g.scopes)))
     AND ($3::timestamptz IS NULL OR (d.updated_at,d.id)<($3::timestamptz,$4::uuid)) ORDER BY d.updated_at DESC,d.id DESC LIMIT $5`,[org,state.session.id,input.cursor?.updatedAt??null,input.cursor?.id??null,input.pageSize+1])).rows;
    return {rows:rows.slice(0,input.pageSize),hasMore:rows.length>input.pageSize};
   },
  };
  async function transaction<T>(tx:TenantTransaction,work:OrganizationTransaction<T>,decision?:NativeDecision){
   state=await guard(tx,access,request,decision);
   if(request.bind)await cutovers.verify(tx,access,request.bind,decision);
   let result:T=await work(tx);state=await guard(tx,access,request,decision);
   if(request.bind){
    if(result&&typeof result==='object'&&'ownerRevision' in result&&'id' in result&&'automationId' in result)await cutovers.activate(tx,access,request.bind,decision,result as {ownerRevision:number;id:string;automationId:string});
    else if(result&&typeof result==='object'&&'ownerRevision' in result&&'binding' in result&&result.binding)await cutovers.activate(tx,access,request.bind,decision,{...(result.binding as {id:string;automationId:string}),ownerRevision:Number(result.ownerRevision)});
    else await cutovers.verify(tx,access,request.bind,decision);
   }
   if(result&&typeof result==='object'&&'draft' in result&&'id' in result){
    const scope=await definitionScope(tx,access.organizationId,String(result.id),state,request.action,request.scopeRevision);
    result={...result,scopeRevision:scope.revision} as T;
   }
   if(request.mutation&&request.id&&result&&typeof result==='object'&&(
    (['FLOW_DRAFT_CREATED','FLOW_DRAFT_SAVED'].includes(request.mutation)&&'draft' in result)
    ||request.mutation==='FLOW_PUBLISHED'&&'version' in result&&'graph' in result&&!('draftGraph' in result)
    ||request.mutation==='FLOW_BOUND'&&'ownerRevision' in result)){
    const bound=await definitionScope(tx,access.organizationId,request.id,state,request.action,request.scopeRevision);
    await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
     VALUES($1,$2,$3,'automation',$4,$5,'SUCCESS',$6)`,[access.organizationId,state.session.user_id,request.mutation,request.id,randomUUID(),JSON.stringify({actorKind:state.session.actor_kind,...(state.session.external_actor_id?{externalActorId:state.session.external_actor_id}:{}),scopeRevision:bound.revision,...('ownerRevision' in result?{ownerRevision:result.ownerRevision}:{})})]);
   }
   return result;
  }
  const transact=async<T>(org:string,work:OrganizationTransaction<T>)=>{
   if(org!==access.organizationId)fail();if(existing)return transaction(existing,work,existingDecision);
   let decision=await nativeDecision(access);
   if(request.bind){await cutovers.beforeTransaction(access,request.bind,decision);decision=await nativeDecision(access);}
   return options.transact(org,tx=>transaction(tx,work,decision));
  };
  return {...createAutomationService({...options.automation,repository:delegatedRepository,transact}),_transact:transact};
 }
 async function projectTargets(tx:TenantTransaction,org:string,rows:Mapping[]){
  const profiles=(await tx.query<{integration_id:string;revision:number}>('SELECT integration_id,revision FROM flow_executor_profiles WHERE organization_id=$1 AND integration_id=ANY($2::uuid[]) FOR SHARE',[org,rows.map(row=>row.integration_id)])).rows;
  return {data:await Promise.all(rows.map(async row=>({integrationId:row.integration_id,channelId:row.channel_id,accountId:Number(row.account_id),inboxId:Number(row.inbox_id),transport:row.transport,scopes:row.scopes,ownerRevision:await readOwnerRevision(tx,org,row.channel_id),profileRevision:profiles.find(profile=>profile.integration_id===row.integration_id)?.revision??0})))};
 }
 const service={
  async availableTargets(principal:BrokerPrincipal){
   return options.transact(principal.organizationId,async tx=>{
    const role=await brokerMember(tx,principal,false),a=await account(tx,principal.organizationId);
    const ids=(await tx.query<{id:string}>("SELECT id FROM chatwoot_connections WHERE organization_id=$1 AND status='READY' AND channel_id IS NOT NULL AND inbox_id IS NOT NULL ORDER BY channel_id LIMIT 101",[principal.organizationId])).rows.map(row=>row.id);
    if(ids.length>100)fail('FLOW_TARGET_LIMIT',409);
    let rows=await mapping(tx,principal.organizationId,ids,a);
    if(role==='OPERATOR'){
     const grants=(await tx.query<{integration_id:string;scopes:FlowScope[]}>('SELECT integration_id,scopes FROM flow_member_grants WHERE organization_id=$1 AND user_id=$2 ORDER BY integration_id FOR SHARE',[principal.organizationId,principal.actorId])).rows;
     rows=rows.flatMap(row=>{const granted=grants.find(grant=>grant.integration_id===row.integration_id&&grant.scopes.includes('flow:read'));return granted?[{...row,scopes:['flow:read'] as FlowScope[]}]:[];});
    }else rows=rows.map(row=>({...row,scopes:['flow:read','flow:edit','flow:publish','flow:bind'] as FlowScope[]}));
    const value=await projectTargets(tx,principal.organizationId,rows);await brokerMember(tx,principal,false);return value;
   });
  },
  async targets(access:FlowAccess){
   const decision=await nativeDecision(access);
   return options.transact(access.organizationId,async tx=>{const state=await authority(tx,access,'flow:read',decision),value=await projectTargets(tx,access.organizationId,state.grants.filter(row=>row.scopes.includes('flow:read')));await authority(tx,access,'flow:read',decision);return value;});
  },
  async scope(access:FlowAccess,id:string){
   z.uuid().parse(id);const decision=await nativeDecision(access);
   return options.transact(access.organizationId,async tx=>{const state=await guard(tx,access,{action:'flow:read',id},decision),bound=await definitionScope(tx,access.organizationId,id,state,'flow:read');await guard(tx,access,{action:'flow:read',id},decision);return {revision:bound.revision,integrationIds:bound.rows.map(row=>row.integration_id)};});
  },
  async issueBrokerSession(principal:BrokerPrincipal,raw:unknown){
   const input=brokerSessionInput.parse(raw),token=randomBytes(32).toString('base64url'),id=randomUUID(),nonce=randomUUID();
   return options.transact(principal.organizationId,async tx=>{
    const role=await brokerMember(tx,principal,input.scopes.some(scope=>scope!=='flow:read'));
    const a=await account(tx,principal.organizationId),rows=await mapping(tx,principal.organizationId,input.integrationIds,a);
    if(role==='OPERATOR')await currentMemberGrants(tx,principal.organizationId,principal.actorId,rows,input.scopes);
    const saved=(await tx.query<{expires_at:Date}>(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now)
     INSERT INTO flow_delegation_sessions(organization_id,id,token_hash,nonce,actor_kind,user_id,auth_version,destination_origin,account_id,destination_revision,account_credential_version,created_at,expires_at)
     SELECT $1,$2,$3,$4,'BROKER',$5,$6,$7,$8,$9,$10,moment.now,moment.now+interval '5 minutes' FROM moment RETURNING expires_at`,[principal.organizationId,id,digest(token),nonce,principal.actorId,principal.authVersion,a.base_url,a.account_id,a.destination!.revision,a.credential_version])).rows[0]!;
    for(const row of rows)await tx.query(`INSERT INTO flow_delegation_session_grants(organization_id,session_id,integration_id,channel_id,account_id,inbox_id,destination_revision,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[principal.organizationId,id,row.integration_id,row.channel_id,row.account_id,row.inbox_id,row.destination_revision,input.scopes]);
    return {id,token,expiresAt:saved.expires_at.toISOString()};
   });
  },
  async setMemberGrant(principal:BrokerPrincipal,raw:unknown){
   const input=z.strictObject({userId:z.uuid(),integrationId:z.uuid(),scopes:scopes.or(z.tuple([])),expectedRevision:z.number().int().nonnegative()}).parse(raw);
   return options.transact(principal.organizationId,async tx=>{
    await brokerMember(tx,principal,true);const a=await account(tx,principal.organizationId);await mapping(tx,principal.organizationId,[input.integrationId],a);
    const member=(await tx.query('SELECT role FROM lock_local_attendance_member($1)',[input.userId])).rows[0];if(!member)fail();
    const prior=(await tx.query<{revision:number}>('SELECT revision FROM flow_member_grants WHERE organization_id=$1 AND user_id=$2 AND integration_id=$3 FOR UPDATE',[principal.organizationId,input.userId,input.integrationId])).rows[0];
    if((prior?.revision??0)!==input.expectedRevision)fail('FLOW_GRANT_CHANGED',409);
    const row=(await tx.query<{revision:number}>(`INSERT INTO flow_member_grants(organization_id,user_id,integration_id,scopes,created_by) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(organization_id,user_id,integration_id) DO UPDATE SET scopes=excluded.scopes,revision=flow_member_grants.revision+1,updated_at=clock_timestamp() RETURNING revision`,[principal.organizationId,input.userId,input.integrationId,input.scopes,principal.actorId])).rows[0]!;
    return {revision:row.revision};
   });
  },
  async configureExecutorProfile(principal:BrokerPrincipal,raw:unknown){
   const input=z.strictObject({integrationId:z.uuid(),expectedRevision:z.number().int().nonnegative()}).parse(raw);
   return options.transact(principal.organizationId,async tx=>{
    await brokerMember(tx,principal,true);const a=await account(tx,principal.organizationId),rows=await mapping(tx,principal.organizationId,[input.integrationId],a),target=rows[0]!;
    const origin=await readFlowOriginCapability(tx,a,options.knownNativeOrigins);
    if(origin.kind==='JRC_NATIVE'&&!options.nativeAdapter)fail('FLOW_HOST_ADAPTER_REQUIRED',409);
    const old=(await tx.query<{revision:number;host_kind:string}>('SELECT revision,host_kind FROM flow_executor_profiles WHERE organization_id=$1 AND integration_id=$2 FOR UPDATE',[principal.organizationId,input.integrationId])).rows[0];
    if((old?.revision??0)!==input.expectedRevision)fail('FLOW_PROFILE_CHANGED',409);
    if(old?.host_kind==='JRC_NATIVE'&&origin.kind!=='JRC_NATIVE')fail('FLOW_PROFILE_MIGRATION_REQUIRED',409);
    const row=(await tx.query<{revision:number}>(`INSERT INTO flow_executor_profiles(organization_id,integration_id,host_kind,destination_origin,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,approved_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,integration_id) DO UPDATE SET host_kind=excluded.host_kind,destination_origin=excluded.destination_origin,origin_capability_revision=excluded.origin_capability_revision,account_id=excluded.account_id,inbox_id=excluded.inbox_id,destination_revision=excluded.destination_revision,account_credential_version=excluded.account_credential_version,approved_by=excluded.approved_by,revision=flow_executor_profiles.revision+1,updated_at=clock_timestamp() RETURNING revision`,[principal.organizationId,input.integrationId,origin.kind,a.base_url,origin.revision,target.account_id,target.inbox_id,target.destination_revision,a.credential_version,principal.actorId])).rows[0]!;
    await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata) VALUES($1,$2,'FLOW_EXECUTOR_PROFILE_APPROVED','chatwoot_connection',$3,$4,'SUCCESS',$5)`,[principal.organizationId,principal.actorId,input.integrationId,randomUUID(),JSON.stringify({hostKind:origin.kind,originCapabilityRevision:origin.revision,revision:row.revision})]);
    return {revision:row.revision,hostKind:origin.kind,originCapabilityRevision:origin.revision};
   });
  },
  async nativeRegistrationAdministrator(tx:TenantTransaction,principal:BrokerPrincipal){await brokerMember(tx,principal,true);},
  async nativeRegistrationAuthority(tx:TenantTransaction,auth:BrokerPrincipal|FlowAccess,credentialId:string,ids:string[],installationRenewal=false){
   z.uuid().parse(credentialId);integrationIds.parse(ids);z.uuid().parse(auth.organizationId);
   let c:Awaited<ReturnType<typeof credential>>;
   if('token' in auth){z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(auth.token);c=await credential(tx,auth);if(c.id!==credentialId)fail();}
   else{
    await brokerMember(tx,auth,true);
    c=(await tx.query<Awaited<ReturnType<typeof credential>>>('SELECT * FROM flow_delegation_credentials WHERE organization_id=$1 AND id=$2 FOR SHARE',[auth.organizationId,credentialId])).rows[0]??fail();
    await brokerMember(tx,{organizationId:auth.organizationId,actorId:c.created_by,authVersion:c.issuer_auth_version},true);
   }
   const a=await account(tx,auth.organizationId),rows=await mapping(tx,auth.organizationId,ids,a);
   if(c.destination_origin!==a.base_url||Number(c.account_id)!==Number(a.account_id)||c.destination_revision!==a.destination!.revision)fail('FLOW_CONTEXT_CHANGED',409);
   if(installationRenewal){
    if('token' in auth)fail();
    const live=(await tx.query<{live:boolean}>('SELECT revoked_at IS NULL AS live FROM flow_delegation_credentials WHERE organization_id=$1 AND id=$2',[auth.organizationId,c.id])).rows[0];
    if(!live?.live)fail();
   }else if(!await delegationLive(tx,auth.organizationId,'flow_delegation_credentials',c.id))fail();
   return {origin:a.base_url,expiresAt:c.expires_at,tuple:{credentialId:c.id,credentialRevision:c.revision,destinationRevision:a.destination!.revision,accountCredentialVersion:a.credential_version,accountId:Number(a.account_id),targets:rows.map(r=>({integrationId:r.integration_id,channelId:r.channel_id,inboxId:Number(r.inbox_id),transport:r.transport,provider:r.provider})).sort((a,b)=>a.integrationId.localeCompare(b.integrationId))}};
  },
  async nativeContext(access:FlowAccess,raw:unknown){
   z.uuid().parse(access.organizationId);z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(access.token);
   const input=NativeContextQuerySchema.parse(raw);
   return options.transact(access.organizationId,async tx=>{
    const c=await credential(tx,access),a=await account(tx,access.organizationId);
    if(c.destination_origin!==a.base_url||Number(c.account_id)!==Number(a.account_id)||c.destination_revision!==a.destination!.revision)fail('FLOW_CONTEXT_CHANGED',409);
    // UUID keyset cursor is only an ordering boundary; it carries no tenant or authority.
    const candidates=(await tx.query<{id:string}>(`SELECT c.id FROM chatwoot_connections c
     JOIN messaging_channels m ON m.organization_id=c.organization_id AND m.id=c.channel_id
     LEFT JOIN instances i ON i.organization_id=m.organization_id AND i.id=m.instance_id
     WHERE c.organization_id=$1 AND ($2::uuid IS NULL OR c.id>$2::uuid) AND c.status='READY'
     AND m.deleting_at IS NULL AND (m.instance_id IS NULL OR i.archived_at IS NULL)
     AND m.transport IN ('BROKER_TRANSPORT','CENTRAL_TRANSPORT') ORDER BY c.id LIMIT $3`,[access.organizationId,input.cursor??null,input.limit+1])).rows;
    const ids=candidates.slice(0,input.limit).map(row=>row.id),rows=ids.length?await mapping(tx,access.organizationId,ids,a):[];
    const targets=ids.map(id=>{const row=rows.find(row=>row.integration_id===id)!;return {integrationId:row.integration_id,channelId:row.channel_id,accountId:Number(row.account_id),inboxId:Number(row.inbox_id),transport:row.transport,provider:row.provider};});
    if(!await delegationLive(tx,access.organizationId,'flow_delegation_credentials',c.id))fail();
    return NativeContextResponseSchema.parse({credential:{id:c.id,revision:c.revision,expiresAt:c.expires_at.toISOString(),scopes:c.scopes},destination:{organizationId:access.organizationId,origin:a.base_url,accountId:Number(a.account_id),destinationRevision:a.destination!.revision,accountCredentialVersion:a.credential_version},targets,nextCursor:candidates.length>input.limit?ids.at(-1)!:null});
   });
  },
  async issueNativeCredential(principal:BrokerPrincipal,raw:unknown){
   const input=z.strictObject({scopes,expiresInSeconds:z.number().int().min(60).max(86400)}).parse(raw),token=randomBytes(32).toString('base64url');
   return options.transact(principal.organizationId,async tx=>{
    await brokerMember(tx,principal,true);const a=await account(tx,principal.organizationId);
    const row=(await tx.query<{id:string;expires_at:Date}>(`INSERT INTO flow_delegation_credentials(organization_id,token_hash,destination_origin,account_id,destination_revision,scopes,created_by,issuer_auth_version,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+($9*interval '1 second')) RETURNING id,expires_at`,[principal.organizationId,digest(token),a.base_url,a.account_id,a.destination!.revision,input.scopes,principal.actorId,principal.authVersion,input.expiresInSeconds])).rows[0]!;
    await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
     VALUES($1,$2,'FLOW_NATIVE_CREDENTIAL_ISSUED','flow_credential',$3,$4,'SUCCESS',$5)`,[principal.organizationId,principal.actorId,row.id,randomUUID(),JSON.stringify({scopes:input.scopes,expiresAt:row.expires_at.toISOString()})]);
    return {id:row.id,token,expiresAt:row.expires_at.toISOString()};
   });
  },
  async issueNativeSession(access:FlowAccess,raw:unknown){
   const parsed=FlowSessionCreateSchema.parse(raw),input={...parsed,scopes:scopes.parse(parsed.scopes)},token=randomBytes(32).toString('base64url'),id=randomUUID();
   const snapshot=await options.transact(access.organizationId,async tx=>{const c=await credential(tx,access),a=await account(tx,access.organizationId),rows=await mapping(tx,access.organizationId,input.integrationIds,a);
    if(c.destination_origin!==a.base_url||Number(c.account_id)!==Number(a.account_id)||c.destination_revision!==a.destination!.revision||input.scopes.some((s:FlowScope)=>!c.scopes.includes(s)))fail();
    if(!await delegationLive(tx,access.organizationId,'flow_delegation_credentials',c.id))fail();
    return {c,a,rows};
   });
   const decision=await introspect({nonce:input.nonce,externalActorId:input.externalActorId,accountId:Number(snapshot.a.account_id),destinationRevision:snapshot.a.destination!.revision,inboxIds:snapshot.rows.map(row=>Number(row.inbox_id)).sort((a,b)=>a-b)},{organizationId:access.organizationId,origin:snapshot.a.base_url});
   try{return await options.transact(access.organizationId,async tx=>{
    const c=await credential(tx,access),a=await account(tx,access.organizationId),rows=await mapping(tx,access.organizationId,input.integrationIds,a);
    if(c.revision!==snapshot.c.revision||a.credential_version!==snapshot.a.credential_version||a.base_url!==snapshot.a.base_url||a.destination!.revision!==snapshot.a.destination!.revision||rows.some(row=>!snapshot.rows.some(s=>sameMapping(s,row))))fail('FLOW_CONTEXT_CHANGED',409);
    const issued=(await tx.query<{expires_at:Date}>(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now) INSERT INTO flow_delegation_sessions(organization_id,id,token_hash,nonce,actor_kind,external_actor_id,credential_id,credential_revision,destination_origin,account_id,destination_revision,account_credential_version,created_at,expires_at)
     SELECT $1,$2,$3,$4,'JRC_NATIVE',$5,$6,$7,$8,$9,$10,$11,moment.now,moment.now+interval '5 minutes' FROM moment RETURNING expires_at`,[access.organizationId,id,digest(token),input.nonce,input.externalActorId,c.id,c.revision,a.base_url,a.account_id,a.destination!.revision,a.credential_version])).rows[0]!;
    for(const row of rows)await tx.query(`INSERT INTO flow_delegation_session_grants(organization_id,session_id,integration_id,channel_id,account_id,inbox_id,destination_revision,scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[access.organizationId,id,row.integration_id,row.channel_id,row.account_id,row.inbox_id,row.destination_revision,input.scopes]);
    for(const scope of input.scopes)await authority(tx,{organizationId:access.organizationId,token},scope,decision);
    await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
     VALUES($1,NULL,'FLOW_NATIVE_SESSION_ISSUED','flow_session',$2,$3,'SUCCESS',$4)`,[access.organizationId,id,randomUUID(),JSON.stringify({actorKind:'JRC_NATIVE',externalActorId:input.externalActorId,credentialRevision:c.revision,scopes:input.scopes,expiresAt:issued.expires_at.toISOString()})]);
    return {id,token,expiresAt:issued.expires_at.toISOString()};
   });}catch(error){if((error as {code?:string}).code==='23505')fail('FLOW_SESSION_NONCE_REUSED',409);throw error;}
  },
  async revokeNativeSession(access:FlowAccess,id:string,raw:unknown){
   z.uuid().parse(id);z.uuid().parse(access.organizationId);z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(access.token);
   const input=z.strictObject({externalActorId:z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/),nonce:z.uuid()}).parse(raw);
   return options.transact(access.organizationId,async tx=>{
    const c=await credential(tx,access),a=await account(tx,access.organizationId);
    const s=(await tx.query<SessionRow>('SELECT * FROM flow_delegation_sessions WHERE organization_id=$1 AND id=$2 FOR UPDATE',[access.organizationId,id])).rows[0];
    if(!s||s.actor_kind!=='JRC_NATIVE'||s.credential_id!==c.id||s.credential_revision!==c.revision||s.external_actor_id!==input.externalActorId||s.nonce!==input.nonce||
     Number(s.account_id)!==Number(c.account_id)||Number(s.account_id)!==Number(a.account_id)||s.destination_origin!==c.destination_origin||s.destination_origin!==a.base_url||
     s.destination_revision!==c.destination_revision||s.destination_revision!==a.destination!.revision||s.account_credential_version!==a.credential_version)fail('FLOW_SESSION_NOT_FOUND',404);
    if(!await delegationLive(tx,access.organizationId,'flow_delegation_credentials',c.id))fail();
    const updated=await tx.query(`UPDATE flow_delegation_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp())
     WHERE organization_id=$1 AND id=$2 AND actor_kind='JRC_NATIVE' AND credential_id=$3 AND credential_revision=$4 AND external_actor_id=$5 AND nonce=$6
     AND EXISTS(SELECT 1 FROM flow_delegation_credentials c WHERE c.organization_id=$1 AND c.id=$3 AND c.revision=$4 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()) RETURNING id`,[access.organizationId,id,c.id,c.revision,input.externalActorId,input.nonce]);
    if(updated.rowCount!==1)fail();
    await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
     VALUES($1,NULL,'FLOW_NATIVE_SESSION_REVOKED','flow_session',$2,$3,'SUCCESS',$4)`,[access.organizationId,id,randomUUID(),JSON.stringify({actorKind:'JRC_NATIVE',externalActorId:input.externalActorId,credentialRevision:c.revision})]);
    return {revoked:true as const};
   });
  },
  async revokeSession(principal:BrokerPrincipal,id:string){
   z.uuid().parse(id);
   return options.transact(principal.organizationId,async tx=>{
    await brokerMember(tx,principal,true);
    const row=await tx.query('UPDATE flow_delegation_sessions SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 RETURNING id',[principal.organizationId,id]);
    if(row.rowCount!==1)fail('FLOW_SESSION_NOT_FOUND',404);
    return {revoked:true};
   });
  },
  async revokeNativeCredential(principal:BrokerPrincipal,id:string){
   z.uuid().parse(id);
   return options.transact(principal.organizationId,async tx=>{
    await brokerMember(tx,principal,true);
    const row=await tx.query('UPDATE flow_delegation_credentials SET revoked_at=clock_timestamp(),revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING id',[principal.organizationId,id]);
    if(row.rowCount!==1)fail('FLOW_CREDENTIAL_NOT_FOUND',404);
    await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
     VALUES($1,$2,'FLOW_NATIVE_CREDENTIAL_REVOKED','flow_credential',$3,$4,'SUCCESS','{}')`,[principal.organizationId,principal.actorId,id,randomUUID()]);
    return {revoked:true};
   });
  },
  async list(access:FlowAccess,raw:unknown={}){const input=z.strictObject({pageSize:z.number().int().min(1).max(100).default(50),cursor:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional()}).parse(raw);return scoped(access,{action:'flow:read'}).list(access.organizationId,{pageSize:input.pageSize,...(input.cursor===undefined?{}:{cursor:input.cursor})});},
  get:(access:FlowAccess,id:string)=>scoped(access,{action:'flow:read',id}).get(access.organizationId,id),
  async status(access:FlowAccess){const common=scoped(access,{action:'flow:read'}),result=await common.status(access.organizationId);
   const decision=await nativeDecision(access);return options.transact(access.organizationId,async tx=>{const state=await authority(tx,access,'flow:read',decision);
    const permitted=(scope:FlowScope)=>state.grants.length>0&&state.grants.every(grant=>grant.scopes.includes(scope));
    return {...result,canEdit:result.canEdit&&permitted('flow:edit'),canSimulate:result.canSimulate&&permitted('flow:edit'),canPublish:result.canPublish&&permitted('flow:publish')};});},
  async nodes(access:FlowAccess){const common=scoped(access,{action:'flow:read'});return common._transact(access.organizationId,async()=>({schemaVersion:1 as const,data:AUTOMATION_NODE_CATALOG_V1}));},
  simulate:(access:FlowAccess,id:string,raw:unknown)=>scoped(access,{action:'flow:edit',id}).simulate(access.organizationId,id,SimulationInputSchema.parse(raw)),
  httpCredentialCatalog:(access:FlowAccess,id:string,input:{pageSize?:number;cursor?:string}={})=>scoped(access,{action:'flow:read',id}).httpCredentialCatalog(access.organizationId,id,input),
  subflowCatalog:(access:FlowAccess,id:string,input:{pageSize?:number;cursor?:string}={})=>scoped(access,{action:'flow:read',id}).subflowCatalog(access.organizationId,id,input),
  aiCredentialCatalog:(access:FlowAccess,id:string,input:{pageSize?:number;cursor?:string}={})=>{
   const common=scoped(access,{action:'flow:read',id}) as ReturnType<typeof scoped>&{aiCredentialCatalog?:(org:string,id:string,input:{pageSize?:number;cursor?:string})=>Promise<unknown>};
   if(!common.aiCredentialCatalog)throw new AutomationError('AUTOMATION_AI_CATALOG_UNAVAILABLE',503);
   return common.aiCredentialCatalog(access.organizationId,id,input);
  },
  async uploadMedia(access:FlowAccess,id:string,channelId:string,input:{bytes:Uint8Array;mimeType:string;fileName:string;kind:'image'|'audio'|'video'|'document';idempotencyKey:string}){
   z.uuid().parse(channelId);z.uuid().parse(input.idempotencyKey);
   if(input.bytes.byteLength>16*1024*1024)throw new AutomationError('AUTOMATION_MEDIA_TOO_LARGE',413);
   const common=scoped(access,{action:'flow:edit',id}),transact=async<T>(org:string,work:OrganizationTransaction<T>)=>common._transact(org,async tx=>{
    const allowed=await tx.query('SELECT channel_id FROM automation_definition_scopes WHERE organization_id=$1 AND automation_id=$2 AND channel_id=$3 FOR SHARE',[org,id,channelId]);
    if(allowed.rows.length!==1)fail();return work(tx);
   });
   const uploader=createAutomationService({...options.automation,repository:createPostgresAutomationRepository(),transact}) as ReturnType<typeof createAutomationService>&{uploadMedia?:(org:string,id:string,channelId:string,uploadInput:typeof input)=>Promise<unknown>};
   if(!uploader.uploadMedia)throw new AutomationError('AUTOMATION_MEDIA_UNAVAILABLE',503);
   return uploader.uploadMedia(access.organizationId,id,channelId,input);
  },
  async handoffConnections(access:FlowAccess,id:string){
   if(!options.chatwootStatus)fail('FLOW_ACCOUNT_CLIENT_REQUIRED',503);
   const common=scoped(access,{action:'flow:read',id});await common._transact(access.organizationId,async()=>undefined);
   const raw=await options.chatwootStatus(access.organizationId),decision=await nativeDecision(access);
   return options.transact(access.organizationId,async tx=>{
    const state=await guard(tx,access,{action:'flow:read',id},decision),bound=await definitionScope(tx,access.organizationId,id,state,'flow:read'),allowed=new Set(bound.rows.map(row=>row.integration_id));
    const counts=(await tx.query<{status:string;count:string}>('SELECT status,count(*)::text AS count FROM integration_jobs WHERE organization_id=$1 AND integration_id=ANY($2::uuid[]) GROUP BY status',[access.organizationId,[...allowed]])).rows;
    if(raw.account?.accountId!==Number(state.account.account_id)||raw.baseUrl!==state.account.base_url)fail('FLOW_CONTEXT_CHANGED',409);
    await guard(tx,access,{action:'flow:read',id},decision);
    return {...raw,connections:raw.connections.filter(connection=>allowed.has(connection.id)),jobs:Object.fromEntries(counts.map(row=>[row.status,Number(row.count)]))};
   });
  },
  async handoffCatalog(access:FlowAccess,id:string,integrationId:string){
   z.uuid().parse(integrationId);if(!options.client)fail('FLOW_ACCOUNT_CLIENT_REQUIRED',503);
   const common=scoped(access,{action:'flow:read',id}),transact=async<T>(org:string,work:OrganizationTransaction<T>)=>common._transact(org,async tx=>{
    const allowed=await tx.query('SELECT integration_id FROM automation_definition_scopes WHERE organization_id=$1 AND automation_id=$2 AND integration_id=$3 FOR SHARE',[org,id,integrationId]);
    if(allowed.rows.length!==1)fail();return work(tx);
   });
   return createChatwootAttendanceService({transact,client:options.client}).catalog(access.organizationId,integrationId);
  },
  async localHandoffChannels(access:FlowAccess,id:string){const common=scoped(access,{action:'flow:read',id}),data=await createLocalAttendanceCatalog({transact:common._transact}).listChannels(access.organizationId),decision=await nativeDecision(access);
   return options.transact(access.organizationId,async tx=>{const state=await guard(tx,access,{action:'flow:read',id},decision),bound=await definitionScope(tx,access.organizationId,id,state,'flow:read'),channels=new Set(bound.rows.map(row=>row.channel_id));return {data:data.filter(row=>channels.has(row.scope.channelId))};});
  },
  async localHandoffCatalog(access:FlowAccess,id:string,channelId:string){z.uuid().parse(channelId);const common=scoped(access,{action:'flow:read',id}),decision=await nativeDecision(access);
   await options.transact(access.organizationId,async tx=>{const state=await guard(tx,access,{action:'flow:read',id},decision),bound=await definitionScope(tx,access.organizationId,id,state,'flow:read');if(!bound.rows.some(row=>row.channel_id===channelId))fail();});
   const transact=async<T>(org:string,work:OrganizationTransaction<T>)=>common._transact(org,async tx=>{
    const allowed=await tx.query('SELECT channel_id FROM automation_definition_scopes WHERE organization_id=$1 AND automation_id=$2 AND channel_id=$3 FOR SHARE',[org,id,channelId]);if(allowed.rows.length!==1)fail();return work(tx);
   });
   return createLocalAttendanceDirectory({transact}).catalog(access.organizationId,channelId);
  },
  async importPreview(access:FlowAccess,raw:unknown){
   const input=z.strictObject({source:z.enum(['AUTO','JRC','N8N','TYPEBOT']),content:z.string().max(2097152),integrationIds}).parse(raw),decision=await nativeDecision(access);
   return options.transact(access.organizationId,async tx=>{
    const request:Request={action:'flow:edit',createIntegrations:input.integrationIds},state=await guard(tx,access,request,decision);
    await requireAutomationDraftAccess(tx,access.organizationId);
    let converted:ReturnType<typeof convertAutomationArtifact>;try{converted=convertAutomationArtifact(input.source,input.content);}catch{throw new AutomationError('AUTOMATION_IMPORT_INVALID',422);}
    await graphScope(tx,access.organizationId,converted.graph,state,input.integrationIds.map(id=>state.grants.find(g=>g.integration_id===id)!));
    await guard(tx,access,request,decision);
    return {schemaVersion:1 as const,name:converted.name,source:converted.source,graph:converted.graph,report:converted.report,createdAsDraft:false};
   });
  },
  async create(access:FlowAccess,raw:unknown,key?:string){
   const input=FlowDraftCreateSchema.parse(raw);
   if(key!==undefined)z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(key);
   const decision=await nativeDecision(access);
   return options.transact(access.organizationId,async tx=>{
    const request:Request={action:'flow:edit',createIntegrations:input.integrationIds,mutation:'FLOW_DRAFT_CREATED'};await guard(tx,access,request,decision);
    const claim=key?await claimIdempotency(tx,{organizationId:access.organizationId,route:'POST /v1/integrations/flows/definitions',key,requestHash:hashIdempotencyRequest({...input,integrationIds:[...input.integrationIds].sort()}),expiresAt:new Date(Date.now()+7*86400000)}):null;
    if(claim?.kind==='REPLAY'){
     if(claim.record.status!=='COMPLETED'||!z.uuid().safeParse(claim.record.responseMetadata.definitionId).success)fail('FLOW_CREATE_REPLAY_UNAVAILABLE',503);
     return scoped(access,{action:'flow:edit',id:String(claim.record.responseMetadata.definitionId)},tx,decision).get(access.organizationId,String(claim.record.responseMetadata.definitionId));
    }
    const result=await scoped(access,request,tx,decision).create(access.organizationId,input);
    if(claim?.kind==='CLAIMED')await completeIdempotencyRecord(tx,{organizationId:access.organizationId,recordId:claim.recordId,status:'COMPLETED',responseMetadata:{definitionId:result.id}});
    return result;
   });
  },
  save:(access:FlowAccess,id:string,raw:unknown)=>{const input=FlowDraftSaveSchema.parse(raw);return scoped(access,{action:'flow:edit',id,scopeRevision:input.expectedScopeRevision,mutation:'FLOW_DRAFT_SAVED'}).save(access.organizationId,id,input);},
  publish:(access:FlowAccess,id:string,raw:unknown)=>{const input=FlowPublishSchema.parse(raw);return scoped(access,{action:'flow:publish',id,scopeRevision:input.expectedScopeRevision,mutation:'FLOW_PUBLISHED'}).publish(access.organizationId,id,input.revision);},
  prepareCutover:cutovers.prepare,
  getCutover:cutovers.get,
  reconcileCutover:cutovers.reconcile,
  async bind(access:FlowAccess,id:string,raw:unknown){
   const input=FlowBindSchema.parse(raw),decision=await nativeDecision(access);
   const target=await options.transact(access.organizationId,async tx=>{
    const state=await guard(tx,access,{action:'flow:bind',id,scopeRevision:input.expectedScopeRevision},decision);
    const bound=await definitionScope(tx,access.organizationId,id,state,'flow:bind',input.expectedScopeRevision);
    const scope=bound.rows.find(scope=>scope.integration_id===input.integrationId);if(!scope)fail();return state.grants.find(row=>row.integration_id===scope.integration_id)!;
   });
   const delegated=scoped(access,{action:'flow:bind',id,scopeRevision:input.expectedScopeRevision,bind:input,mutation:'FLOW_BOUND'});
   if(target.transport==='CENTRAL_TRANSPORT'){
    const facade=createChannelFacade({transact:delegated._transact,instances:{} as never,meta:{} as never,automationStatus:org=>delegated.status(org)});
    const result=await facade.bindAutomation(access.organizationId,target.channel_id,{automationId:id,version:input.version,expectedOwnerRevision:input.expectedOwnerRevision});
    return {...result.binding,ownerRevision:result.ownerRevision};
   }
   return delegated.bind(access.organizationId,id,{channelId:target.channel_id,version:input.version,expectedOwnerRevision:input.expectedOwnerRevision});
  },
  versions:(access:FlowAccess,id:string)=>scoped(access,{action:'flow:read',id}).versions(access.organizationId,id),
  async versionsPage(access:FlowAccess,id:string,raw:unknown={}){
   const input=z.strictObject({pageSize:z.number().int().min(1).max(1).default(1),cursor:z.string().regex(/^[1-9][0-9]{0,8}$/).optional()}).parse(raw),decision=await nativeDecision(access);
   return options.transact(access.organizationId,async tx=>{
    const state=await guard(tx,access,{action:'flow:read',id},decision),bound=await definitionScope(tx,access.organizationId,id,state,'flow:read');
    const rows=(await tx.query<import('../../automations/repository.js').VersionRow>(`SELECT automation_id AS "automationId",organization_id AS "organizationId",version,graph,checksum,published_at AS "publishedAt" FROM automation_versions WHERE organization_id=$1 AND automation_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT 2`,[access.organizationId,id,input.cursor?Number(input.cursor):null])).rows;
    for(const row of rows.slice(0,1))await graphScope(tx,access.organizationId,row.graph,state,bound.rows);
    await guard(tx,access,{action:'flow:read',id},decision);
    return {data:rows.slice(0,1).map(row=>({schemaVersion:1 as const,automationId:row.automationId,organizationId:row.organizationId,version:row.version,graph:row.graph,checksum:row.checksum,publishedAt:row.publishedAt.toISOString()})),nextCursor:rows.length>1?String(rows[0]!.version):null};
   });
  },
  validate:(access:FlowAccess,id:string)=>scoped(access,{action:'flow:read',id}).validate(access.organizationId,id),
 };
 return service;
}
