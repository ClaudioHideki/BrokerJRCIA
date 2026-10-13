import {describe,it,expect,vi} from 'vitest';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import type {PublishedAutomation} from '../../src/modules/automations/types.js';
import type {SimulationInput} from '../../src/modules/automations/simulation.js';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+'-'+port,source,target,port});
const outcomes=['success','client_error','server_error','timeout','unknown'] as const;
const http={httpConfigVersion:1,method:'GET',url:'https://api.example.test/lookup',credentialId:'11111111-1111-4111-8111-111111111111',credentialRevision:1,queryParameters:{},target:'result',timeoutMs:5000,maxResponseBytes:32768,retryAttempts:0};
const root:PublishedAutomation={automationId:'22222222-2222-4222-8222-222222222222',version:1,runtimeStateVersion:2,graph:{
 nodes:[node('start','start'),node('query','http',http),...outcomes.map(outcome=>node(outcome,'message',{text:'Resultado '+outcome})),node('end','end')],
 edges:[edge('start','query'),...outcomes.map(outcome=>edge('query',outcome,outcome)),...outcomes.map(outcome=>edge(outcome,'end'))]}};
const simulation=(events:unknown[])=>simulateConversation(root,{text:'inicial',events} as SimulationInput,async()=>{throw new Error('NO_DEPENDENCY');});
describe('explicit HTTP response simulation',()=>{
 it.each(outcomes)('takes %s through the canonical engine without network or external confirmation',async outcome=>{
  const fetch=vi.spyOn(globalThis,'fetch');try{
   const event=outcome==='timeout'||outcome==='unknown'?{type:'HTTP_RESPONSE',nodeId:'query',outcome}:{type:'HTTP_RESPONSE',nodeId:'query',outcome,status:outcome==='success'?200:outcome==='client_error'?404:503,body:'fictício'};
   const result=await simulation([event]);expect(result.status).toBe('COMPLETED');
   expect(result.effects.filter(effect=>effect.kind==='SEND_TEXT').map(effect=>effect.payload.text)).toEqual(['Resultado '+outcome]);
   expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('remoteReference');
   expect(result.state.variables.result).toEqual(outcome==='timeout'||outcome==='unknown'?{error:outcome==='timeout'?'AUTOMATION_HTTP_TIMEOUT':'AUTOMATION_HTTP_TRANSPORT_FAILED'}:{status:event.status,headers:{},body:'fictício'});
  }finally{fetch.mockRestore();}
 });
 it('accepts a response only for the exact currently waiting HTTP node',async()=>{
  expect((await simulation([])).httpWaitNodeId).toBe('query');
  await expect(simulation([{type:'HTTP_RESPONSE',nodeId:'another',outcome:'success',status:200,body:''}])).rejects.toThrow('AUTOMATION_SIMULATION_HTTP_WAIT_MISMATCH');
  const other:PublishedAutomation={...root,graph:{nodes:[node('start','start'),node('query','sql',{query:'SELECT 1',credentialId:http.credentialId,target:'result'}),node('end','end')],edges:[edge('start','query'),edge('query','end','success'),edge('query','end','error')]}};
  await expect(simulateConversation(other,{text:'start',events:[{type:'HTTP_RESPONSE',nodeId:'query',outcome:'success',status:200,body:''}]} as SimulationInput,async()=>root)).rejects.toThrow('AUTOMATION_SIMULATION_HTTP_WAIT_MISMATCH');
  expect(await simulateConversation(other,{text:'start'},async()=>root)).not.toHaveProperty('httpWaitNodeId');
 });
 it('rejects response events before an HTTP wait and oversized or inconsistent synthetic bodies',async()=>{
  await expect(simulation([{type:'HTTP_RESPONSE',nodeId:'query',outcome:'success',status:503,body:''}])).rejects.toThrow();
  await expect(simulation([{type:'HTTP_RESPONSE',nodeId:'query',outcome:'success',status:200,body:'é'.repeat(16385)}])).rejects.toThrow();
  const input:PublishedAutomation={...root,graph:{nodes:[node('start','start'),node('query','input',{variable:'name'}),node('end','end')],edges:[edge('start','query'),edge('query','end')]}};
  await expect(simulateConversation(input,{text:'start',events:[{type:'HTTP_RESPONSE',nodeId:'query',outcome:'timeout'}]} as SimulationInput,async()=>root)).rejects.toThrow('AUTOMATION_SIMULATION_HTTP_WAIT_MISMATCH');
 });
});
