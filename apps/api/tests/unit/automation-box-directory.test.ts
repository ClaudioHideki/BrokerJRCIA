import {describe,it,expect} from 'vitest';
import {BoxRoutingConfigSchema,RouteHandoffV3Schema} from '@jrc/contracts';
import {resolveBoxDirectory,resolveRouteHandoff} from '../../src/modules/automations/box-directory.js';
import {catalog,config,integration} from './fixtures/box-routing.js';
const snapshot=()=>resolveBoxDirectory(config(),catalog(),new Map([[10,[{id:2,name:'Bruno'},{id:1,name:'Ana'},{id:3,name:'Fora'}]]]),1);
describe('box routing directory',()=>{
 it('intersects team and inbox, orders deterministically and resolves a single canonical target',()=>{
  const value=snapshot();expect(value.routes[0]?.agents.map(a=>a.name)).toEqual(['Ana','Bruno']);
  expect(resolveRouteHandoff(value,'sales',2)).toEqual({handoffVersion:1,destination:{integrationId:integration,destinationRevision:1,accountId:1,inboxId:20,credentialRevision:1},target:{teamId:null,agentId:2}});
  expect(JSON.stringify(value)).not.toContain('email');
 });
 it('resolves the same model in another box without leaking its first destination',()=>{
  const other=catalog();other.scope={...other.scope,inboxId:21,integrationId:'44444444-4444-4444-8444-444444444444'};
  const value=resolveBoxDirectory(config(),other,new Map([[10,[{id:1,name:'Ana'}]]]),2);
  expect(resolveRouteHandoff(value,'sales',1).destination.inboxId).toBe(21);
 });
 it('preserves explicit order and rejects revoked or unauthorized selections',()=>{
  const selected=config();selected.routes[0] = {...selected.routes[0]!,membership:'SELECTED',agentIds:[2,1]};
  expect(resolveBoxDirectory(selected,catalog(),new Map([[10,[{id:1,name:'Ana'},{id:2,name:'Bruno'}]]]),1).routes[0]?.agents.map(a=>a.id)).toEqual([2,1]);
  expect(()=>resolveBoxDirectory(selected,catalog(),new Map([[10,[{id:1,name:'Ana'}]]]),1)).toThrow('FLOW_BOX_AGENT_UNAVAILABLE');
  expect(()=>resolveRouteHandoff(snapshot(),'sales',3)).toThrow('FLOW_BOX_AGENT_UNAVAILABLE');
 });
 it('rejects empty/overlong lists, ambiguous names and unsafe settings without truncating',()=>{
  expect(()=>resolveBoxDirectory(config(),catalog(),new Map([[10,[]]]),1)).toThrow('FLOW_BOX_ROUTE_EMPTY');
  const long=catalog();long.agents=Array.from({length:10},(_,i)=>({id:i+1,name:`Agent ${i}`,inboxMember:true}));
  expect(()=>resolveBoxDirectory(config(),long,new Map([[10,long.agents]]),1)).toThrow('FLOW_BOX_AGENT_LIMIT');
  const duplicate=catalog();duplicate.agents[1]!.name='Ana';
  expect(()=>resolveBoxDirectory(config(),duplicate,new Map([[10,duplicate.agents]]),1)).toThrow('FLOW_BOX_AGENT_NAME_AMBIGUOUS');
  expect(BoxRoutingConfigSchema.safeParse({schemaVersion:1,routes:[config().routes[0],config().routes[0]]}).success).toBe(false);
  expect(RouteHandoffV3Schema.safeParse({handoffVersion:3,routeKey:'sales',integrationId:integration}).success).toBe(false);
 });
 it('supports direct department transfer without implying automatic distribution',()=>{
  const direct=config();direct.routes[0]!.mode='TEAM';
  const value=resolveBoxDirectory(direct,catalog(),new Map(),1);
  expect(resolveRouteHandoff(value,'sales').target).toEqual({teamId:10,agentId:null});
 });
});
