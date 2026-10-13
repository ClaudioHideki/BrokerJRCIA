import {describe,it,expect,vi} from 'vitest';
import {createAutomationService} from '../../src/modules/automations/service.js';
import type {AutomationRepository,DefinitionRow} from '../../src/modules/automations/repository.js';
import type {OrganizationTransaction,TenantTransaction} from '../../src/db/tenant-transaction.js';
const org='11111111-1111-4111-8111-111111111111',root='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph={nodes:[node('start','start'),node('query','http',{httpConfigVersion:1,method:'GET',url:'https://api.example.test/lookup',credentialId:id,credentialRevision:3,queryParameters:{},target:'result',timeoutMs:5000,maxResponseBytes:32768,retryAttempts:0}),node('end','end')],edges:[{id:'next',source:'start',target:'query',port:'next'},...['success','client_error','server_error','timeout','unknown'].map(port=>({id:port,source:'query',target:'end',port}))]};
function fixture(change:'revision'|'revoke'|null=null){
 let reads=0;const tx={query:vi.fn(async(sql:string)=>{if(sql.includes('automation_credentials')){reads++;return{rows:[{id,organizationId:org,type:'BEARER',status:change==='revoke'&&reads>1?'REVOKED':'ACTIVE',revision:change==='revision'&&reads>1?4:3,allowedOrigins:['https://api.example.test']}]};}return{rows:sql.includes('flow_features')?[{status:'ACTIVE',moduleEnabled:true}]:[]};})} as unknown as TenantTransaction;
 const definition:DefinitionRow={id:root,organizationId:org,name:'Consulta',lifecycleStatus:'DRAFT',draftGraph:graph,draftRevision:1,activeVersion:null,updatedAt:new Date()};
 const repository={getDefinition:vi.fn().mockResolvedValue(definition),insertVersion:vi.fn(async(_tx,record)=>({...record,automationId:root,organizationId:org,publishedAt:new Date()})),activateVersion:vi.fn()} as unknown as AutomationRepository;
 const service=createAutomationService({transact:<T>(_org:string,work:OrganizationTransaction<T>)=>work(tx),repository});return{service,repository,tx};
}
describe('HTTP draft publication boundaries',()=>{
 it('rechecks credential revision inside the committing transaction and refuses a changed policy',async()=>{
  const {service,repository}=fixture('revision');await expect(service.publish(org,root,1)).rejects.toThrow('AUTOMATION_HTTP_CREDENTIAL_CHANGED');expect(repository.insertVersion).not.toHaveBeenCalled();
 });
 it('refuses a credential revoked between preflight and publication without creating a version',async()=>{
  const {service,repository,tx}=fixture('revoke');await expect(service.publish(org,root,1)).rejects.toThrow('AUTOMATION_HTTP_CREDENTIAL_UNAVAILABLE');expect(repository.insertVersion).not.toHaveBeenCalled();expect(repository.activateVersion).not.toHaveBeenCalled();expect(vi.mocked(tx.query).mock.calls.filter(([sql])=>String(sql).includes('automation_credentials'))).toHaveLength(2);
 });
 it('validates and simulates the same metadata policy before publishing an immutable graph',async()=>{
  const {service,tx,repository}=fixture();expect((await service.validate(org,root)).valid).toBe(true);
  expect((await service.simulate(org,root,{text:'Olá'})).wait?.kind).toBe('IO');await service.publish(org,root,1);
  const reads=vi.mocked(tx.query).mock.calls.filter(([sql])=>String(sql).includes('automation_credentials'));expect(reads).toHaveLength(4);expect(reads.every(([sql])=>String(sql).includes('for share'))).toBe(true);expect(repository.insertVersion).toHaveBeenCalledOnce();
 });
});
