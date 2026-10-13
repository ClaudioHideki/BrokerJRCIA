import {describe,expect,it,vi} from 'vitest';
import {createAutomationService} from '../../src/modules/automations/service.js';
import type {AutomationRepository} from '../../src/modules/automations/repository.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';

const org='11111111-1111-4111-8111-111111111111',rootId='22222222-2222-4222-8222-222222222222';
const childId='33333333-3333-4333-8333-333333333333';
const row={automationId:childId,name:'Fluxo filho',version:7,checksum:'b'.repeat(64),runtimeStateVersion:2};
const root={id:rootId,organizationId:org,name:'Raiz',lifecycleStatus:'DRAFT',draftRevision:1,activeVersion:null,updatedAt:new Date(),draftGraph:{nodes:[],edges:[]}};
type CatalogService=ReturnType<typeof createAutomationService>&{subflowCatalog(organizationId:string,id:string,input?:{pageSize?:number;cursor?:string}):Promise<unknown>};
function fixture(options:{missing?:boolean;active?:boolean;module?:boolean;pages?:Array<{rows:unknown[];hasMore:boolean}>}={}){
 const query=vi.fn(async()=>({rows:[{status:options.active===false?'DISABLED':'ACTIVE',moduleEnabled:options.module!==false}]}));
 const calls:Array<{organizationId:string;rootId:string;input:unknown}>=[];
 const pages=[...(options.pages??[{rows:[row],hasMore:false}])];
 const repository={getDefinition:async(_tx:unknown,tenant:string,id:string)=>tenant===org&&id===rootId&&!options.missing?root:null,
  listSubflowVersions:async(_tx:unknown,organizationId:string,id:string,input:unknown)=>{calls.push({organizationId,rootId:id,input});return pages.shift()??{rows:[],hasMore:false};},
 } as unknown as AutomationRepository;
 const service=createAutomationService({repository,transact:async(tenant,work)=>{if(tenant!==org)throw new Error('INVALID_TENANT');return work({query} as unknown as TenantTransaction);}}) as CatalogService;
 return {service,calls};
}
describe('tenant subflow catalog service',()=>{
 it('returns metadata for an authorized real root without graph payload or a guessed version',async()=>{
  const {service,calls}=fixture();expect(service.subflowCatalog).toBeTypeOf('function');
  expect(await service.subflowCatalog(org,rootId)).toEqual({schemaVersion:1,scope:{organizationId:org,rootAutomationId:rootId},data:[row],nextCursor:null});
  expect(calls).toEqual([{organizationId:org,rootId,input:{pageSize:200}}]);
 });
 it('requires the root to exist in the authenticated tenant and rechecks active module access',async()=>{
  for(const [options,code] of [[{missing:true},'AUTOMATION_NOT_FOUND'],[{active:false},'ORGANIZATION_NOT_ACTIVE'],[{module:false},'AUTOMATION_MODULE_DISABLED']] as const){
   const {service,calls}=fixture(options);expect(service.subflowCatalog).toBeTypeOf('function');
   await expect(service.subflowCatalog(org,rootId)).rejects.toMatchObject({code});expect(calls).toEqual([]);
  }
 });
 it('uses a bounded continuation without imposing a two-hundred-version total',async()=>{
  const first=Array.from({length:200},(_,at)=>({...row,version:400-at}));
  const {service,calls}=fixture({pages:[{rows:first,hasMore:true},{rows:[{...row,version:200}],hasMore:false}]});expect(service.subflowCatalog).toBeTypeOf('function');
  const page=await service.subflowCatalog(org,rootId) as {data:unknown[];nextCursor:string};
  expect(page.data).toHaveLength(200);expect(page.nextCursor).toBeTypeOf('string');
  expect(await service.subflowCatalog(org,rootId,{cursor:page.nextCursor})).toMatchObject({data:[{...row,version:200}],nextCursor:null});
  expect(calls[1]).toEqual({organizationId:org,rootId,input:{pageSize:200,cursor:{automationId:childId,version:201}}});
 });
 it('rejects malformed or oversized continuation inputs before querying the catalog',async()=>{
  const {service,calls}=fixture();expect(service.subflowCatalog).toBeTypeOf('function');
  for(const cursor of ['not_valid_json','!bad',Buffer.from(JSON.stringify({automationId:childId,version:0,organizationId:org})).toString('base64url')])
   await expect(service.subflowCatalog(org,rootId,{cursor})).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_CURSOR_INVALID'});
  expect(calls).toEqual([]);
 });
});
