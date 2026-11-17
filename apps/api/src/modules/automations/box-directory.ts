import {BoxRoutingConfigSchema,BoxDirectorySnapshotSchema,AutomationHandoffConfigV1Schema,
 type BoxRoutingConfig,type BoxDirectorySnapshot,type AttendanceCatalog} from '@jrc/contracts';

/** Remote data is already scoped by the canonical attendance catalog. No emails or credentials are retained. */
export function resolveBoxDirectory(raw:BoxRoutingConfig,catalog:AttendanceCatalog,teamMembers:Map<number,Array<{id:number;name:string}>>,profileRevision:number):BoxDirectorySnapshot{
 const config=BoxRoutingConfigSchema.parse(raw);
 if(catalog.capabilities.teams!=='SUPPORTED'||catalog.capabilities.agents!=='SUPPORTED'||catalog.capabilities.inboxMembership!=='SUPPORTED')throw Error('FLOW_BOX_DIRECTORY_UNVERIFIED');
 const routes=config.routes.map(route=>{
  const team=catalog.teams.find(t=>t.id===route.teamId);if(!team)throw Error('FLOW_BOX_TEAM_UNAVAILABLE');
  let agents:Array<{id:number;name:string}>=[];
  if(route.mode==='AGENT'){
   const members=teamMembers.get(team.id);if(!members)throw Error('FLOW_BOX_TEAM_MEMBERS_UNVERIFIED');
   if(new Set(members.map(m=>m.id)).size!==members.length)throw Error('FLOW_BOX_DIRECTORY_AMBIGUOUS');
   const eligible=catalog.agents.filter(a=>a.inboxMember&&members.some(m=>m.id===a.id));
   agents=route.membership==='SELECTED'?route.agentIds.map(id=>{
    const found=eligible.find(a=>a.id===id);if(!found)throw Error('FLOW_BOX_AGENT_UNAVAILABLE');return {id:found.id,name:found.name};
   }):eligible.map(a=>({id:a.id,name:a.name})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')||a.id-b.id);
   if(!agents.length)throw Error('FLOW_BOX_ROUTE_EMPTY');if(agents.length>9)throw Error('FLOW_BOX_AGENT_LIMIT');
   if(new Set(agents.map(a=>a.name.trim().toLocaleLowerCase('pt-BR'))).size!==agents.length)throw Error('FLOW_BOX_AGENT_NAME_AMBIGUOUS');
  }
  return {routeKey:route.routeKey,teamId:team.id,teamName:team.name,mode:route.mode,agents};
 });
 return BoxDirectorySnapshotSchema.parse({schemaVersion:1,profileRevision,scope:catalog.scope,credentialRevision:catalog.credentialRevision,routes});
}

export function resolveRouteHandoff(raw:BoxDirectorySnapshot,routeKey:string,agentId?:number){
 const snapshot=BoxDirectorySnapshotSchema.parse(raw),route=snapshot.routes.find(r=>r.routeKey===routeKey);
 if(!route)throw Error('FLOW_BOX_ROUTE_UNAVAILABLE');
 if(route.mode==='AGENT'&&!route.agents.some(a=>a.id===agentId))throw Error('FLOW_BOX_AGENT_UNAVAILABLE');
 if(route.mode==='TEAM'&&agentId!==undefined)throw Error('FLOW_BOX_TARGET_AMBIGUOUS');
 const s=snapshot.scope;
 return AutomationHandoffConfigV1Schema.parse({handoffVersion:1,destination:{integrationId:s.integrationId,destinationRevision:s.destinationRevision,
  accountId:s.accountId,inboxId:s.inboxId,credentialRevision:snapshot.credentialRevision},target:{teamId:route.mode==='TEAM'?route.teamId:null,agentId:route.mode==='AGENT'?agentId:null}});
}

/** Internal execution state binds the external single target to its authorizing team. */
export function boxHandoffAuthorization(state:Record<string,unknown>,payload:unknown):{teamId:number;agentId:number|null}|null{
 if(state.boxDirectory===undefined)return null;
 const snapshot=BoxDirectorySnapshotSchema.parse(state.boxDirectory),canonical=AutomationHandoffConfigV1Schema.parse(payload);
 const selection=state.boxSelection as {routeKey?:string;agentId?:number}|undefined;
 const route=canonical.target.agentId!==null?snapshot.routes.find(r=>r.routeKey===selection?.routeKey&&r.mode==='AGENT'):
  snapshot.routes.find(r=>r.mode==='TEAM'&&r.teamId===canonical.target.teamId);
 if(!route)throw Error('FLOW_BOX_TARGET_CHANGED');
 const expected=resolveRouteHandoff(snapshot,route.routeKey,route.mode==='AGENT'?selection?.agentId:undefined);
 if(JSON.stringify(expected)!==JSON.stringify(canonical))throw Error('FLOW_BOX_TARGET_CHANGED');
 return {teamId:route.teamId,agentId:canonical.target.agentId};
}
