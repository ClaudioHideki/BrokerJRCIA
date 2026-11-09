import {BoxRoutingConfigSchema,BoxDirectorySnapshotSchema,boxTemplateRoutes,type BoxRoutingConfig,type BoxDirectorySnapshot,type AttendanceCatalog,type AutomationGraphV1} from '@jrc/contracts';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import {resolveBoxDirectory,resolveRouteHandoff} from './box-directory.js';
import {resolveAttendanceScope,lockAttendanceChannel} from '../attendance/repository.js';
import {readChatwootAccount} from '../integrations/chatwoot-context.js';
import type {HandoffReadiness,PreparedHandoffReadiness} from '../attendance/handoff-readiness.js';
import {AutomationError} from './errors.js';
import {requireActiveOrganization} from '../tenancy/operational-limits.js';

export interface BoxProfile {organizationId:string;automationId:string;version:number;channelId:string;revision:number;activeRevision:number|null;config:BoxRoutingConfig;snapshot:BoxDirectorySnapshot}
type ProfileWrite=Omit<BoxProfile,'revision'|'activeRevision'>&{expectedRevision:number;actorId:string};
type ProfileSource='LATEST'|'ACTIVE';
export interface PreparedBoxBinding extends PreparedHandoffReadiness {activateProfile(tx:TenantTransaction):Promise<void>}
export interface BoxProfileStore {
 read(tx:TenantTransaction,org:string,automation:string,version:number,channel:string,source?:ProfileSource):Promise<BoxProfile|null>;
 graph(tx:TenantTransaction,org:string,automation:string,version:number):Promise<AutomationGraphV1>;
 write(tx:TenantTransaction,input:ProfileWrite):Promise<BoxProfile>;
 activate(tx:TenantTransaction,org:string,automation:string,version:number,channel:string,revision:number):Promise<void>;
 assertScope(tx:TenantTransaction,org:string,channel:string,snapshot:BoxDirectorySnapshot):Promise<void>;
}
type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;store?:BoxProfileStore;
 integration(org:string,channel:string):Promise<string>;
 catalog(org:string,integration:string):Promise<AttendanceCatalog>;
 teamMembers(org:string,integration:string,teamId:number):Promise<Array<{id:number;name:string}>>;
 readiness?:HandoffReadiness;
};
const fail=(code:string):never=>{throw new AutomationError(code,409);};
const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])):v;
const same=(a:unknown,b:unknown)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
export function postgresBoxProfileStore():BoxProfileStore{
 const store:BoxProfileStore={
  async read(tx,org,automation,version,channel,source='LATEST'){
   const schema=await tx.query<{ready:boolean}>(`SELECT count(*)=2 AS ready FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('automation_box_profile_heads','automation_box_profile_versions')
    AND c.relrowsecurity AND c.relforcerowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='jrc_migrator'
    AND pg_catalog.has_table_privilege('jrc_app',c.oid,'SELECT') AND pg_catalog.has_table_privilege('jrc_app',c.oid,'INSERT')`);
   if(schema.rows[0]?.ready!==true)return fail('FLOW_BOX_SCHEMA_PENDING');
   return (await tx.query<BoxProfile>(`SELECT v.organization_id AS "organizationId",v.automation_id AS "automationId",v.version,v.channel_id AS "channelId",v.revision,h.active_revision AS "activeRevision",v.config,v.snapshot
   FROM automation_box_profile_heads h JOIN automation_box_profile_versions v ON v.organization_id=h.organization_id AND v.channel_id=h.channel_id
    AND v.automation_id=h.automation_id AND v.version=h.version AND v.revision=CASE WHEN $5='ACTIVE' THEN h.active_revision ELSE h.revision END
   WHERE h.organization_id=$1 AND h.automation_id=$2 AND h.version=$3 AND h.channel_id=$4`,[org,automation,version,channel,source])).rows[0]??null;},
  async graph(tx,org,automation,version){const row=(await tx.query<{graph:AutomationGraphV1}>('SELECT graph FROM automation_versions WHERE organization_id=$1 AND automation_id=$2 AND version=$3',[org,automation,version])).rows[0];
   if(!row)return fail('AUTOMATION_VERSION_NOT_FOUND');return row.graph;},
  async write(tx,input){
   const i=input;await requireActiveOrganization(tx,i.organizationId);await lockAttendanceChannel(tx,i.organizationId,i.channelId);
   await store.assertScope(tx,i.organizationId,i.channelId,i.snapshot);
   const current=await store.read(tx,i.organizationId,i.automationId,i.version,i.channelId);
   if((current?.revision??0)!==i.expectedRevision)return fail('FLOW_BOX_PROFILE_CHANGED');
   const revision=i.expectedRevision+1,snapshot={...i.snapshot,profileRevision:revision};
   await tx.query(`INSERT INTO automation_box_profile_versions(organization_id,channel_id,automation_id,version,revision,config,snapshot,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[i.organizationId,i.channelId,i.automationId,i.version,revision,JSON.stringify(i.config),JSON.stringify(snapshot),i.actorId]);
   await tx.query(`INSERT INTO automation_box_profile_heads(organization_id,channel_id,automation_id,version,revision) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(organization_id,channel_id,automation_id,version) DO UPDATE SET revision=EXCLUDED.revision`,[i.organizationId,i.channelId,i.automationId,i.version,revision]);
   return {organizationId:i.organizationId,automationId:i.automationId,version:i.version,channelId:i.channelId,revision,activeRevision:current?.activeRevision??null,config:i.config,snapshot};
  },
  async activate(tx,org,automation,version,channel,revision){
   await requireActiveOrganization(tx,org);
   await lockAttendanceChannel(tx,org,channel);
   const current=await store.read(tx,org,automation,version,channel);
   if(current?.revision!==revision)return fail('FLOW_BOX_PROFILE_CHANGED');
   await store.assertScope(tx,org,channel,current.snapshot);
   const changed=await tx.query(`UPDATE automation_box_profile_heads SET active_revision=$5 WHERE organization_id=$1 AND automation_id=$2 AND version=$3 AND channel_id=$4 AND revision=$5`,[org,automation,version,channel,revision]);
   if(!changed.rowCount)return fail('FLOW_BOX_PROFILE_CHANGED');
  },
  async assertScope(tx,org,channel,expected){
   if(expected.scope.organizationId!==org||expected.scope.channelId!==channel)return fail('FLOW_BOX_SCOPE_CHANGED');
   const scope=await resolveAttendanceScope(tx,org,channel),account=await readChatwootAccount(tx,org);
   if(!scope||!account||Object.entries(expected.scope).some(([k,v])=>scope[k as keyof typeof scope]!==v)||account.credential_version!==expected.credentialRevision)return fail('FLOW_BOX_SCOPE_CHANGED');
  },
 };return store;
}
export function createBoxRoutingService(options:Options){
 const store=options.store??postgresBoxProfileStore();
 async function directory(org:string,channel:string,config:BoxRoutingConfig,revision:number){
  const integration=await options.integration(org,channel),catalog=await options.catalog(org,integration);
  if(catalog.scope.organizationId!==org||catalog.scope.channelId!==channel||catalog.scope.integrationId!==integration)return fail('FLOW_BOX_SCOPE_CHANGED');
  const teams=[...new Set(config.routes.filter(r=>r.mode==='AGENT').map(r=>r.teamId))];
  const members=await Promise.all(teams.map(async id=>[id,await options.teamMembers(org,integration,id)] as const));
  const result=resolveBoxDirectory(config,catalog,new Map(members),revision);
  await options.transact(org,tx=>store.assertScope(tx,org,channel,result));return result;
 }
 async function read(org:string,automation:string,version:number,channel:string,source:ProfileSource='LATEST'){return options.transact(org,tx=>store.read(tx,org,automation,version,channel,source));}
 async function loadDirectory(org:string,automation:string,version:number,channel:string,source:ProfileSource){
  const graph=await options.transact(org,tx=>store.graph(tx,org,automation,version));if(!boxTemplateRoutes(graph).length)return undefined;
  const profile=await read(org,automation,version,channel,source);if(!profile)return fail('FLOW_BOX_PROFILE_REQUIRED');
  const result=await directory(org,channel,profile.config,profile.revision);
  if(!same(result.scope,profile.snapshot.scope)||result.credentialRevision!==profile.snapshot.credentialRevision)return fail('FLOW_BOX_SCOPE_CHANGED');
  return result;
 }
 return {
  _options:options,
  async get(org:string,automation:string,version:number,channel:string,requestedTeam?:number){
   const graph=await options.transact(org,tx=>store.graph(tx,org,automation,version));const routes=boxTemplateRoutes(graph);
   const profile=routes.length?await read(org,automation,version,channel):null;
   const integration=await options.integration(org,channel),catalog=await options.catalog(org,integration);
   if(catalog.scope.organizationId!==org||catalog.scope.channelId!==channel)return fail('FLOW_BOX_SCOPE_CHANGED');
   const needed=new Set(profile?.config.routes.filter(r=>r.mode==='AGENT').map(r=>r.teamId)??[]);
   if(requestedTeam!==undefined){if(!catalog.teams.some(t=>t.id===requestedTeam))return fail('FLOW_BOX_TEAM_UNAVAILABLE');needed.add(requestedTeam);}
   const members=await Promise.all([...needed].map(async team=>({teamId:team,agents:(await options.teamMembers(org,integration,team))
    .filter(agent=>catalog.agents.some(a=>a.id===agent.id&&a.inboxMember)).map(agent=>({id:agent.id,name:catalog.agents.find(a=>a.id===agent.id)!.name}))})));
   await options.transact(org,tx=>store.assertScope(tx,org,channel,{schemaVersion:1,profileRevision:1,scope:catalog.scope,credentialRevision:catalog.credentialRevision,routes:[]}));
   return {schemaVersion:1 as const,scope:{organizationId:org,automationId:automation,version,channelId:channel},routes,catalog,teamMembers:members,profile,rulesCheck:'UNVERIFIED' as const};
  },
  async save(org:string,automation:string,channel:string,input:{version:number;expectedRevision:number;config:BoxRoutingConfig},actorId:string){
   const config=BoxRoutingConfigSchema.parse(input.config),graph=await options.transact(org,tx=>store.graph(tx,org,automation,input.version));
   const declared=boxTemplateRoutes(graph);
   if(declared.length!==config.routes.length||declared.some(r=>!config.routes.some(c=>c.routeKey===r.routeKey&&c.mode===r.mode)))return fail('FLOW_BOX_ROUTES_MISMATCH');
   const snapshot=await directory(org,channel,config,input.expectedRevision+1);
   return options.transact(org,async tx=>{
    await lockAttendanceChannel(tx,org,channel);
    await store.assertScope(tx,org,channel,snapshot);
    const current=await store.read(tx,org,automation,input.version,channel);
    if(current&&same(current.config,config)&&same(current.snapshot.scope,snapshot.scope)&&current.snapshot.credentialRevision===snapshot.credentialRevision)return current;
    return store.write(tx,{organizationId:org,automationId:automation,version:input.version,channelId:channel,expectedRevision:input.expectedRevision,config,snapshot,actorId});
   });
  },
  prepareSession:(org:string,automation:string,version:number,channel:string)=>loadDirectory(org,automation,version,channel,'ACTIVE'),
  async assertSession(tx:TenantTransaction,org:string,automation:string,version:number,channel:string,snapshot:BoxDirectorySnapshot){
   await store.assertScope(tx,org,channel,snapshot);
   const current=await store.read(tx,org,automation,version,channel,'ACTIVE');
   if(!current||current.revision!==snapshot.profileRevision)return fail('FLOW_BOX_PROFILE_CHANGED');
  },
  async prepareBinding(org:string,automation:string,version:number,channel:string,expectedRevision?:number,source:ProfileSource='LATEST'):Promise<PreparedBoxBinding>{
   const snapshot=await loadDirectory(org,automation,version,channel,source);if(!snapshot)return {async assertCurrent(){},async activateProfile(){}};
   if(expectedRevision===undefined)return fail('FLOW_BOX_PROFILE_REVISION_REQUIRED');
   if(expectedRevision!==snapshot.profileRevision)return fail('FLOW_BOX_PROFILE_CHANGED');
   if(!options.readiness)return fail('AUTOMATION_HANDOFF_UNAVAILABLE');
   const graph:AutomationGraphV1={nodes:snapshot.routes.flatMap(route=>(route.mode==='TEAM'?[undefined]:route.agents.map(a=>a.id)).map((agentId,i)=>({
    id:`${route.routeKey}-${i}`,type:'handoff',label:route.routeKey,position:{x:0,y:0},data:resolveRouteHandoff(snapshot,route.routeKey,agentId)}))),edges:[]};
   const ready=await options.readiness.prepare(org,graph,channel);
   const assertCurrent=async(tx:TenantTransaction)=>{await lockAttendanceChannel(tx,org,channel);await store.assertScope(tx,org,channel,snapshot);const current=await store.read(tx,org,automation,version,channel,source);
    if(current?.revision!==snapshot.profileRevision)return fail('FLOW_BOX_PROFILE_CHANGED');await ready.assertCurrent(tx);};
   return {assertCurrent,async activateProfile(tx){await assertCurrent(tx);if(source==='LATEST')await store.activate(tx,org,automation,version,channel,snapshot.profileRevision);}};
  },
 };
}
export type BoxRoutingService=ReturnType<typeof createBoxRoutingService>;
