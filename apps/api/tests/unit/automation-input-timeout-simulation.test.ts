import {describe,expect,it} from 'vitest';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import type {PublishedAutomation} from '../../src/modules/automations/types.js';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const graph={nodes:[node('start','start'),node('capture','input',{inputConfigVersion:1,variable:'answer',timeoutSeconds:5}),node('answered','message',{text:'Recebido {{answer}}'}),node('expired','message',{text:'Prazo encerrado'}),node('end','end')],edges:[edge('start','capture'),edge('capture','answered'),edge('capture','expired','timeout'),edge('answered','end'),edge('expired','end')]};
const root:PublishedAutomation={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,graph};
const clock='2026-10-15T12:00:00.000Z';
describe('capture virtual deadline uses the same engine',()=>{
  it('expires an event wait when virtual time reaches its deadline without network IO',async()=>{
    const result=await simulateConversation(root,{text:'Oi',clock,events:[{type:'ELAPSE',seconds:5}]},async()=>root);
    expect(result.status).toBe('COMPLETED');
    expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Prazo encerrado']);
    expect(result.state.variables).toEqual({message:'Oi'});
  });
  it('continues a reply before deadline using a simulator-owned wait identity and admission time',async()=>{
    const result=await simulateConversation(root,{text:'Oi',clock,events:[{type:'ELAPSE',seconds:4},{type:'MESSAGE',text:'Maria'}]},async()=>root);
    expect(result.status).toBe('COMPLETED');
    expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Recebido Maria']);
    expect(result.state.variables.answer).toBe('Maria');
  });
});
