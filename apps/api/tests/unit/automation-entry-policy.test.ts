import {afterEach,describe,expect,it,vi} from 'vitest';
import {getNodeDefinition} from '@jrc/contracts';
import {createPostgresAutomationRepository} from '../../src/modules/automations/repository.js';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import * as authority from '../../src/modules/attendance/runtime-authority.js';
import * as attendance from '../../src/modules/attendance/repository.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
const ids={org:'11111111-1111-4111-8111-111111111111',flow:'22222222-2222-4222-8222-222222222222',channel:'33333333-3333-4333-8333-333333333333',conversation:'44444444-4444-4444-8444-444444444444',event:'55555555-5555-4555-8555-555555555555',execution:'66666666-6666-4666-8666-666666666666'};
const config={entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ONCE_PER_CONVERSATION',keywords:{mode:'CONTAINS',terms:['orçamento'],quantifier:'ANY',ignoreCase:true,ignoreAccents:true}};
const graph=(data:Record<string,unknown>)=>({nodes:[{id:'start',type:'start',label:'Início',position:{x:0,y:0},data},{id:'end',type:'end',label:'Fim',position:{x:0,y:0},data:{}}],edges:[{id:'next',source:'start',target:'end',port:'next'}]});
afterEach(()=>vi.restoreAllMocks());
function fixture(data:Record<string,unknown>=config,prior=false){
 vi.spyOn(attendance,'lockAttendanceChannelRead').mockResolvedValue(undefined);
 vi.spyOn(authority,'runtimeAuthorityAllows').mockResolvedValue(true);
 const binding={id:ids.flow,automationId:ids.flow,version:7,status:'ACTIVE'};
 const inserts:unknown[][]=[];
 const query=vi.fn(async(sql:string,params:readonly unknown[]=[])=>{
  if(sql.includes('from automation_bindings'))return {rows:[binding],rowCount:1};
  if(sql.includes('from automation_versions')){expect(params).toEqual([ids.org,ids.flow,7]);return{rows:[{graph:graph(data)}],rowCount:1};}
  if(sql.includes('select 1 from automation_executions')){
   expect(params).toEqual([ids.org,ids.flow,ids.channel,ids.conversation]);return{rows:prior?[{exists:1}]:[],rowCount:prior?1:0};}
  if(sql.includes('from automation_executions'))return{rows:[],rowCount:0};
  if(sql.startsWith('insert into automation_executions')){inserts.push([...params]);return{rows:[{id:ids.execution}],rowCount:1};}
  if(sql.startsWith('update automation_events'))return{rows:[],rowCount:1};
  throw Error(sql);
 });
 return {inserts,run:(text:string,conversationId:string|null=ids.conversation)=>createPostgresAutomationRepository().routeEvent({query} as unknown as TenantTransaction,{org:ids.org,eventId:ids.event,executionId:ids.execution,correlationId:ids.event,channelId:ids.channel,conversationId,eventKey:'fixture',input:{text,eventType:'MESSAGE'}})};
}
describe('versioned canonical entry policy',()=>{
 it('refuses events the canonical router does not implement instead of publishing an inert trigger',()=>{
  expect(getNodeDefinition('start',1)!.schema.safeParse({...config,trigger:'CONTACT_CREATED'}).success).toBe(false);
 });
 it('rejects unsupported regex and blank keyword entries at publication',()=>{
  expect(getNodeDefinition('start',1)!.schema.safeParse({...config,keywords:{...config.keywords,mode:'REGEX'}}).success).toBe(false);
  expect(getNodeDefinition('start',1)!.schema.safeParse({...config,keywords:{...config.keywords,terms:[' ']}}).success).toBe(false);
 });
 it('does not start a new execution when the published keyword policy does not match',async()=>{
  const f=fixture();expect(await f.run('Suporte')).toBeNull();expect(f.inserts).toHaveLength(0);
 });
 it('normalizes accents and case using the pinned published version before creating an execution',async()=>{
  const f=fixture();expect(await f.run('Quero ORCAMENTO')).toMatchObject({execution:{id:ids.execution},resumed:false});expect(f.inserts).toHaveLength(1);
 });
 it('blocks a second completed run of this flow within the same channel and conversation',async()=>{
  const f=fixture(config,true);expect(await f.run('orçamento')).toBeNull();expect(f.inserts).toHaveLength(0);
 });
 it('fails closed for once-per-conversation without a server-owned conversation identity',async()=>{
  const f=fixture();expect(await f.run('orçamento',null)).toBeNull();expect(f.inserts).toHaveLength(0);
 });
 it('keeps unmarked historical entry fields inert',async()=>{
  const {entryConfigVersion:_,...legacy}=config,f=fixture(legacy,true);
  expect(await f.run('Suporte')).toMatchObject({execution:{id:ids.execution}});
 });
 it('uses the same keyword decision in the playground without claiming an execution occurred',async()=>{
  const root={automationId:ids.flow,version:7,runtimeStateVersion:2 as const,graph:graph(config)};
  await expect(simulateConversation(root,{text:'Suporte'},async()=>root)).rejects.toThrow('AUTOMATION_SIMULATION_TRIGGER_NOT_MATCHED');
  expect((await simulateConversation(root,{text:'ORCAMENTO'},async()=>root)).status).toBe('COMPLETED');
 });
});
