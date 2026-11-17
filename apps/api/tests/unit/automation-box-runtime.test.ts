import {it,expect} from 'vitest';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import {resolveBoxDirectory} from '../../src/modules/automations/box-directory.js';
import type {PublishedAutomation,RuntimeState} from '../../src/modules/automations/types.js';
import {catalog,config} from './fixtures/box-routing.js';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:`${source}:${port}`,source,target,port});
const snapshot=()=>resolveBoxDirectory(config(),catalog(),new Map([[10,[{id:1,name:'Ana'},{id:2,name:'Bruno'}]]]),1);
const now=new Date('2030-01-01T00:00:00Z');
function root(language:'pt'|'en'='pt'):PublishedAutomation{return {automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,graph:{nodes:[
 node('start','start'),node('menu','directory-menu',{directoryVersion:1,routeKey:'sales',language,text:language==='pt'?'Escolha':'Choose',backLabel:language==='pt'?'Voltar':'Back',errorMessage:'Inválida',maxAttempts:3,timeoutSeconds:60}),
 node('handoff','handoff',{handoffVersion:3,routeKey:'sales'}),node('back','message',{text:'Voltou'}),node('end','end')],
 edges:[edge('start','menu'),edge('menu','handoff','selected'),edge('menu','back','back'),edge('back','end'),edge('menu','end','exhausted'),edge('menu','end','timeout')]}};}
const run=(r:PublishedAutomation,text:string,state?:RuntimeState,directory=snapshot(),seconds=0,eventType:'MESSAGE'|'TIMER'='MESSAGE')=>executeAutomation(r,
 {text,eventType,now:new Date(+now+seconds*1000),boxDirectory:directory,...(state?.waiting?.waitId?{inputWait:{waitId:state.waiting.waitId,admittedAt:+now+seconds*1000}}:{})},async()=>r,state);
it('captures menu snapshot and keeps numeric choice after profile reorder and serialization',async()=>{
 const r=root(),first=await run(r,'Oi');expect(first.status).toBe('WAITING');expect(first.effects[0]?.payload.text).toBe('Escolha\n1 - Ana\n2 - Bruno\n3 - Voltar');
 const reordered=snapshot();reordered.profileRevision=2;reordered.routes[0]!.agents.reverse();
 const next=await run(r,'1',JSON.parse(JSON.stringify(first.state)),reordered);
 expect(next.status).toBe('HANDOFF');expect(next.effects.find(e=>e.kind==='HANDOFF')?.payload).toMatchObject({handoffVersion:1,target:{teamId:null,agentId:1}});
 expect(next.effects.filter(e=>e.kind==='SEND_TEXT').map(e=>e.payload.text)).toEqual(['Aguarde, vamos encaminhar seu atendimento para Ana.']);
});
it('handles invalid option, back, timeout and English confirmation using the offered names',async()=>{
 const r=root('en'),first=await run(r,'Oi'),bad=await run(r,'9',first.state);
 expect(bad.effects[0]?.payload.text).toContain('1 - Ana');expect(bad.state.waiting?.invalidAttempts).toBe(1);
 expect((await run(r,'3',bad.state)).effects[0]?.payload.text).toBe('Voltou');
 const selected=await run(r,'2',first.state);expect(selected.effects[0]?.payload.text).toBe('Please wait, we will transfer your conversation to Bruno.');
 expect((await run(r,'',first.state,snapshot(),61,'TIMER')).status).toBe('COMPLETED');
});
it('fails closed without a server directory and does not trust a directory in public payload',async()=>{
 const r=root();await expect(executeAutomation(r,{text:'oi',eventType:'MESSAGE',now,payload:{boxDirectory:snapshot()}},async()=>r)).rejects.toThrow('FLOW_BOX_PROFILE_REQUIRED');
});
it('captures the directory for an explicitly initialized fresh restart, but never replaces a waiting menu snapshot',async()=>{
 const r=root(),fresh:RuntimeState={runtimeStateVersion:2,automationId:r.automationId,version:r.version,nodeId:'start',steps:0,stack:[],variables:{}};
 const first=await run(r,'Oi',fresh);expect(first.effects[0]?.payload.text).toContain('1 - Ana');
 const corrupted=JSON.parse(JSON.stringify(first.state));delete corrupted.boxDirectory;
 await expect(run(r,'1',corrupted)).rejects.toThrow('FLOW_BOX_PROFILE_REQUIRED');
});
it('renders variables in prompt and invalid-option text, checking the rendered menu limit without truncation',async()=>{
 const r=root(),menu=r.graph.nodes.find(n=>n.id==='menu')!;menu.data.text='Olá {{customer_name}}, escolha';menu.data.errorMessage='Inválida, {{customer_name}}';
 const fresh:RuntimeState={runtimeStateVersion:2,automationId:r.automationId,version:1,nodeId:'start',steps:0,stack:[],variables:{customer_name:'Alice'}};
 const first=await run(r,'Oi',fresh);expect(first.effects[0]?.payload.text).toContain('Olá Alice, escolha');
 const retry=await run(r,'9',first.state);expect(retry.effects[0]?.payload.text).toContain('Inválida, Alice');
 await expect(run(r,'Oi',{...fresh,variables:{customer_name:'x'.repeat(4100)}})).rejects.toThrow('FLOW_BOX_MENU_TEXT_LIMIT');
});
