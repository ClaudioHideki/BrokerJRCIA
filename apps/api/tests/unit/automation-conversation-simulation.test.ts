import { describe, expect, it, vi } from 'vitest';
import { createAutomationService } from '../../src/modules/automations/service.js';
import type { AutomationRepository } from '../../src/modules/automations/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+'-'+port,source,target,port});
export const nativeBot={nodes:[node('start','start'),node('hello','message',{text:'Bem-vindo'}),node('menu','menu',{text:'Escolha',variable:'menu',options:[{value:'1',label:'Atendimento'},{value:'2',label:'Encerrar'}]}),node('name','input',{text:'Qual seu nome?',variable:'nome'}),node('known','condition',{field:'nome',operator:'present',value:''}),node('thanks','message',{text:'Olá, {{nome}}'}),node('handoff','handoff'),node('end','end')],edges:[edge('start','hello'),edge('hello','menu'),edge('menu','name','option-1'),edge('menu','end','option-2'),edge('name','known'),edge('known','thanks','yes'),edge('known','end','no'),edge('thanks','handoff')]};
function service(graph=nativeBot){
 const row={id:'bot',organizationId:'tenant',name:'Bot',lifecycleStatus:'DRAFT',draftGraph:graph,draftRevision:1,activeVersion:null,updatedAt:new Date()};
 return createAutomationService({enabled:false,repository:{getDefinition:vi.fn(async()=>row)} as unknown as AutomationRepository,transact:async(_org,work)=>work({query:async()=>({rows:[{status:'ACTIVE',moduleEnabled:true}]})} as unknown as TenantTransaction)});
}
describe('native bot conversation preview',()=>{
 it('processes successive deadlines in their order within one virtual time advance',async()=>{
  const graph={nodes:[node('start','start'),node('first','delay',{seconds:5}),node('message','message',{text:'Primeira espera'}),node('second','delay',{seconds:5}),node('done','message',{text:'Segunda espera'}),node('end','end')],edges:[edge('start','first'),edge('first','message'),edge('message','second'),edge('second','done'),edge('done','end')]};
  const partial=await service(graph).simulate('tenant','bot',{text:'Olá',clock:'2030-01-01T00:00:00.000Z',events:[{type:'ELAPSE',seconds:7}]});
  expect(partial).toMatchObject({status:'WAITING',wait:{kind:'DELAY',nodeId:'second'}});
  expect(partial.wait?.wakeAt?.toISOString()).toBe('2030-01-01T00:00:10.000Z');
  const complete=await service(graph).simulate('tenant','bot',{text:'Olá',clock:'2030-01-01T00:00:00.000Z',events:[{type:'ELAPSE',seconds:10}]});
  expect(complete.status).toBe('COMPLETED');
  expect(complete.effects.map(effect=>effect.payload.text)).toEqual(['Primeira espera','Segunda espera']);
 });
 it('advances virtual time through delay without replacing the captured message or using the network',async()=>{
  const graph={nodes:[node('start','start'),node('delay','delay',{seconds:5}),node('message','message',{text:'Depois: {{message}}'}),node('input','input',{variable:'answer',text:'Nome?'}),node('thanks','message',{text:'Olá {{answer}}'}),node('end','end')],edges:[edge('start','delay'),edge('delay','message'),edge('message','input'),edge('input','thanks'),edge('thanks','end')]};
  const fetchSpy=vi.spyOn(globalThis,'fetch');
  try {
   const input={text:'inicial',clock:'2030-01-01T00:00:00.000Z',events:[{type:'ELAPSE',seconds:3},{type:'MESSAGE',text:'ignorada'},{type:'ELAPSE',seconds:2},{type:'MESSAGE',text:'Pessoa'}]};
   const result=await service(graph).simulate('tenant','bot',input);
   expect(result).toMatchObject({status:'COMPLETED',state:{variables:{answer:'Pessoa'}}});
   expect(result.effects.filter(item=>item.kind==='SEND_TEXT').map(item=>item.payload.text)).toEqual(['Depois: inicial','Nome?','Olá Pessoa']);
   expect(fetchSpy).not.toHaveBeenCalled();
   const partial=await service(graph).simulate('tenant','bot',{...input,events:[{type:'ELAPSE',seconds:4}]});
   expect(partial).toMatchObject({status:'WAITING',effects:[],wait:{kind:'DELAY'}});
   expect(partial.wait?.wakeAt?.toISOString()).toBe('2030-01-01T00:00:05.000Z');
  } finally {fetchSpy.mockRestore();}
 });
 it('tests menu, capture, condition and handoff without publication or external delivery',async()=>{
  const bot=service();
  expect(await bot.validate('tenant','bot')).toEqual({valid:true,diagnostics:[],errors:[]});
  const first=await bot.simulate('tenant','bot',{text:'Olá'});
  expect(first).toMatchObject({status:'WAITING',wait:{kind:'EVENT',nodeId:'menu'}});
  const result=await bot.simulate('tenant','bot',{text:'Olá',replies:['1','Pessoa de teste']});
  expect(result).toMatchObject({status:'HANDOFF',state:{variables:{nome:'Pessoa de teste',menu:'1'}}});
  expect(result.effects.filter(item=>item.kind==='SEND_TEXT').map(item=>item.payload.text)).toEqual(['Bem-vindo','Escolha\n1 - Atendimento\n2 - Encerrar','Qual seu nome?','Olá, Pessoa de teste']);
  expect(result.effects.at(-1)?.kind).toBe('HANDOFF');
 });
 it('keeps invalid menu answers waiting and refuses answers after terminal state',async()=>{
  const bot=service();
  expect(await bot.simulate('tenant','bot',{text:'Olá',replies:['9']})).toMatchObject({status:'WAITING',wait:{nodeId:'menu'}});
  await expect(bot.simulate('tenant','bot',{text:'Olá',replies:['2','extra']})).rejects.toMatchObject({code:'AUTOMATION_SIMULATION_NOT_WAITING'});
 });
 it('stops at external IO without accessing network or credentials',async()=>{
  const graph={nodes:[node('start','start'),node('http','http',{target:'result',url:'https://example.test',credentialId:'11111111-1111-4111-8111-111111111111'}),node('end','end')],edges:[edge('start','http'),...['success','client_error','server_error','timeout','unknown'].map(port=>edge('http','end',port))]};
  const fetchSpy=vi.spyOn(globalThis,'fetch');
  try{const result=await service(graph).simulate('tenant','bot',{text:'Olá'});expect(result).toMatchObject({status:'WAITING',wait:{kind:'IO'}});expect(fetchSpy).not.toHaveBeenCalled();}
  finally{fetchSpy.mockRestore();}
 });
});
