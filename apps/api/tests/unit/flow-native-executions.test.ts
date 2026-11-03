import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {FlowSessionCreateSchema} from '@jrc/contracts';
import {serviceFixture} from './flow-native-service-fixture.js';
const capability='flow:executions:read',period={from:'2030-01-01T00:00:00.000Z',to:'2030-01-02T00:00:00.000Z'};
async function fixture(granted=true){
 const f=serviceFixture(),root=randomUUID(),base=f.query.getMockImplementation()!,seen:string[]=[];
 if(granted){f.credential.scopes.push(capability);f.mapping.scopes.push(capability);}
 f.adapter.introspect.mockImplementation(async request=>({...request,member:true,accountActive:true,featureEnabled:true,role:'administrator'}));
 f.query.mockImplementation(async(sql,values=[])=>{
  if(sql.startsWith('SELECT delegation_scope_revision'))return{rows:[{delegation_scope_revision:1}],rowCount:1};
  if(sql.startsWith('SELECT * FROM automation_definition_scopes'))return{rows:values[1]===root?[f.mapping]:[],rowCount:values[1]===root?1:0};
  if(sql.includes('from automation_definitions'))return{rows:[],rowCount:0};
  if(sql.includes('from automation_executions')){seen.push(sql);if(sql.includes('count(*)'))return{rows:[{total:0,completed:0,active:0,failed:0,unknown:0,canceled:0,handoff:0}],rowCount:1};return{rows:[],rowCount:0};}
  return base(sql,values);
 });
 const issued=await f.service.issueNativeSession(f.access,{...f.input,scopes:[...f.mapping.scopes]});
 return{...f,root,seen,access:{organizationId:f.org,token:issued.token}};
}
it('accepts the explicit capability without implicitly adding it to legacy read sessions',()=>{
 const f=serviceFixture();expect(FlowSessionCreateSchema.parse({...f.input,scopes:['flow:read',capability]}).scopes).toContain(capability);
 expect(FlowSessionCreateSchema.parse(f.input).scopes).toEqual(['flow:read']);
});
it('requires execution capability even when the same native session may read a flow',async()=>{
 const f=await fixture(false);await expect(f.service.executions(f.access,f.root,period)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});expect(f.seen).toHaveLength(0);
});
it('revalidates native membership and confines execution SQL to the granted root channels',async()=>{
 const f=await fixture();const result=await f.service.executions(f.access,f.root,period);
 expect(result.scope).toMatchObject({organizationId:f.org,rootAutomationId:f.root,accountId:7,inboxIds:[9],capabilityVersion:1});
 expect(f.seen.every(sql=>sql.includes('e.channel_id=any'))).toBe(true);
 await expect(f.service.executions(f.access,randomUUID(),period)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 f.revokeHostMembership();f.adapter.introspect.mockImplementation(async request=>({...request,member:false,accountActive:true,featureEnabled:true,role:'administrator'}));
 await expect(f.service.executions(f.access,f.root,period)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
it('refuses an execution outside the scoped root and inbox without exposing its detail',async()=>{
 const f=await fixture();await expect(f.service.execution(f.access,f.root,randomUUID())).rejects.toMatchObject({code:'AUTOMATION_EXECUTION_NOT_FOUND'});
});
import {safeExecutionCode} from '../../src/modules/automations/execution-inspection.js';
it('never forwards arbitrary uppercase persisted failure text through native metadata',()=>{
 expect(safeExecutionCode('PRIVATE_TOKEN_CANARY')).toBe('EXECUTION_DETAILS_PROTECTED');
 expect(safeExecutionCode('AUTOMATION_STEP_LIMIT')).toBe('AUTOMATION_STEP_LIMIT');
});
it('rechecks the current issuer after metadata SQL before releasing the response',async()=>{
 const f=await fixture(),query=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,values=[])=>{const result=await query(sql,values);if(sql.includes('from automation_executions'))f.setIssuerRole('VIEWER');return result;});
 await expect(f.service.executions(f.access,f.root,period)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
