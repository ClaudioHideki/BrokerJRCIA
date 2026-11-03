import {afterEach,describe,expect,it,vi} from 'vitest';
import {createExecutionService} from '../../src/modules/automations/service.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',flow='33333333-3333-4333-8333-333333333333';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph={nodes:[node('start','start'),node('answer','message',{text:'Versão 1: {{message}}'}),node('end','end')],edges:[{id:'a',source:'start',target:'answer',port:'next'},{id:'b',source:'answer',target:'end',port:'next'}]};
afterEach(()=>vi.restoreAllMocks());
function fixture(missing=false){
 const writes:string[]=[];
 const repository={getExecution:async(_tx:unknown,scope:string,key:string)=>scope===org&&key===id&&!missing?{id,automationId:flow,version:1,startedAt:new Date('2030-01-01T12:00:00Z')}:null,
  getVersion:async(_tx:unknown,scope:string,key:string,version:number)=>scope===org&&key===flow&&version===1?{graph,runtimeStateVersion:2}:null,
  getDefinition:async()=>{throw Error('MUST_NOT_LOAD_CURRENT_DRAFT');}};
 const transact=async(_org:string,work:(tx:unknown)=>Promise<unknown>)=>work({query:async(sql:string)=>{if(/^(insert|update|delete)/i.test(sql)){writes.push(sql);throw Error('MUST_NOT_WRITE');}
  return {rows:sql.includes('automation_events')?[{text:'Mensagem inicial'}]:[{status:'ACTIVE',moduleEnabled:true}],rowCount:1};}});
 return {service:createExecutionService({repository:repository as never,transact:transact as never}),writes};
}
describe('historical execution playground',()=>{
 it('loads the original message and immutable version without mutating execution state',async()=>{
  const {service,writes}=fixture();
  expect(await service.playground(org,id)).toEqual({executionId:id,automationId:flow,version:1,text:'Mensagem inicial',clock:'2030-01-01T12:00:00.000Z'});
  expect(writes).toEqual([]);
 });
 it('runs the recorded published version in simulation even if current drafts or active versions differ',async()=>{
  const {service,writes}=fixture(),fetch=vi.spyOn(globalThis,'fetch');
  const result=await service.simulateHistorical(org,id,{text:'Outro cenário',clock:'2030-01-01T12:00:00Z'});
  expect(result).toMatchObject({status:'COMPLETED',source:{executionId:id,automationId:flow,version:1}});
  expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Versão 1: Outro cenário']);
  expect(fetch).not.toHaveBeenCalled();expect(writes).toEqual([]);
 });
 it('does not disclose or simulate an execution outside the tenant scope',async()=>{
  const {service}=fixture(true);
  await expect(service.playground(org,id)).rejects.toMatchObject({code:'AUTOMATION_EXECUTION_NOT_FOUND',statusCode:404});
  await expect(service.simulateHistorical(org,id,{text:'x'})).rejects.toMatchObject({code:'AUTOMATION_EXECUTION_NOT_FOUND',statusCode:404});
 });
});
