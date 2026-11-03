import {describe,expect,it} from 'vitest';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import type {PublishedAutomation,RuntimeState} from '../../src/modules/automations/types.js';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const clock='2030-01-01T00:00:00.000Z';
function root(inputType='email',maxAttempts=2):PublishedAutomation{return {automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,graph:{
 nodes:[node('start','start'),node('capture','input',{inputConfigVersion:2,inputType,variable:'answer',maxAttempts,errorMessage:'Confira o formato',timeoutSeconds:10}),node('ok','message',{text:'Recebido'}),node('exhausted','message',{text:'Tentativas esgotadas'}),node('timeout','message',{text:'Prazo encerrado'}),node('end','end')],
 edges:[edge('start','capture'),edge('capture','ok'),edge('capture','exhausted','exhausted'),edge('capture','timeout','timeout'),edge('ok','end'),edge('exhausted','end'),edge('timeout','end')]}};}
const run=(flow:PublishedAutomation,text:string,previous?:RuntimeState)=>executeAutomation(flow,{text,eventType:'MESSAGE',now:new Date(clock),...(previous?.waiting?.waitId?{inputWait:{waitId:previous.waiting.waitId,admittedAt:Date.parse(clock)}}:{})},async()=>flow,previous);

describe('version 2 typed input capture',()=>{
 it.each([
  ['text','  Nome de teste  ','  Nome de teste  '],['number',' -12,5 ',-12.5],['cpf','529.982.247-25','52998224725'],
  ['cnpj','12.ABC.345/01DE-35','12ABC34501DE35'],['cnpj','11.222.333/0001-81','11222333000181'],
  ['email',' pessoa@example.test ','pessoa@example.test'],['phone','+55 (11) 95555-0123','+5511955550123'],['date','2028-02-29','2028-02-29'],
 ])('validates %s and stores its normalized typed result',async(type,text,expected)=>{
  const flow=root(type as string),first=await run(flow,text as string),result=await run(flow,text as string,first.state);
  expect(result.status).toBe('COMPLETED');expect(result.state.variables.answer).toEqual(expected);
  expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Recebido']);
 });
 it.each([['cpf','111.111.111-11'],['cpf','529.982.247-24'],['cpf','x52998224725'],['cnpj','12.ABC.345/01DE-34'],['cnpj','00.000.000/0000-00'],['email','a@@example.test'],['phone','ligue 5511955550123'],['date','2026-02-29'],['number','Infinity'],['number','12abc'],['text','   ']])('keeps invalid %s out of the capture variable and exhausts after two persisted answers',async(type,text)=>{
  const flow=root(type),first=await run(flow,'Oi'),invalid=await run(flow,text,first.state);
  expect(invalid.status).toBe('WAITING');expect(invalid.state.variables.answer).toBeUndefined();
  expect(invalid.state.waiting).toMatchObject({invalidAttempts:1,deadlineAt:Date.parse(clock)+10000});
  expect(invalid.state.waiting?.waitId).not.toBe(first.state.waiting?.waitId);
  expect(invalid.wait?.waitId).toBe(invalid.state.waiting?.waitId);
  expect(first.state.waiting).toMatchObject({invalidAttempts:0});
  const result=await run(flow,text,JSON.parse(JSON.stringify(invalid.state)));
  expect(result.status).toBe('COMPLETED');expect(result.state.variables.answer).toBeUndefined();
  expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Tentativas esgotadas']);
 });
 it('applies the original deadline after an invalid reply in simulation',async()=>{
  const flow=root();const result=await simulateConversation(flow,{text:'Oi',clock,events:[{type:'ELAPSE',seconds:9},{type:'MESSAGE',text:'inválido'},{type:'ELAPSE',seconds:1}]},async()=>flow);
  expect(result.status).toBe('COMPLETED');expect(result.effects.at(-1)?.payload.text).toBe('Prazo encerrado');
 });
 it('fails closed on corrupted counters and missing fallback instead of completing successfully',async()=>{
  const flow=root(),first=await run(flow,'Oi');
  await expect(run(flow,'bad',{...first.state,waiting:{...first.state.waiting!,invalidAttempts:-1}})).rejects.toThrow('AUTOMATION_INPUT_WAIT_INVALID');
  const exhausted=root('email',1);exhausted.graph.edges=exhausted.graph.edges.filter(item=>item.port!=='exhausted');
  const waiting=await run(exhausted,'Oi');await expect(run(exhausted,'bad',waiting.state)).rejects.toThrow('AUTOMATION_INPUT_EXHAUSTED_CONNECTION_MISSING');
 });
 it('preserves unmarked and v1 textual semantics when validation-looking fields exist',async()=>{
  for(const marker of [undefined,1]){const flow=root('number');flow.graph.nodes[1]!.data={variable:'answer',inputType:'number',maxAttempts:1,...(marker?{inputConfigVersion:marker}:{})};
   const first=await run(flow,'Oi'),result=await run(flow,'not a number',first.state);
   expect(result.state.variables.answer).toBe('not a number');expect(result.status).toBe('COMPLETED');}
 });
});
