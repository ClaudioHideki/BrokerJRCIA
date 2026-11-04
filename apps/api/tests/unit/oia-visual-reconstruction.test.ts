import {describe,expect,it} from 'vitest';
import {oiaVisualReconstructionFlow,OIA_DEPARTMENTS,validateAutomationGraph,AutomationHandoffConfigV1Schema} from '@jrc/contracts';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import type {PublishedAutomation,RuntimeState} from '../../src/modules/automations/types.js';

const targets=Object.fromEntries(OIA_DEPARTMENTS.flatMap((department,di)=>Array.from({length:department.positions},(_,i)=>[
  `${department.id}-${i+1}`,{label:`HML ${department.id} ${i+1}`,handoff:{handoffVersion:1,destination:{integrationId:'11111111-1111-4111-8111-111111111111',destinationRevision:1,credentialRevision:1,accountId:101,inboxId:201},target:{teamId:null,agentId:1000+di*10+i}}},
])));
const root=():PublishedAutomation=>({automationId:'22222222-2222-4222-8222-222222222222',version:1,runtimeStateVersion:2,graph:oiaVisualReconstructionFlow({targets})});
const now=new Date('2026-11-04T12:00:00Z');
async function run(definition:PublishedAutomation,text:string,state?:RuntimeState,at=now){return executeAutomation(definition,{text,eventType:'MESSAGE',now:at,...(state?.waiting?.waitId?{inputWait:{waitId:state.waiting.waitId,admittedAt:at.getTime()}}:{})},async()=>definition,state&&JSON.parse(JSON.stringify(state)));}
describe('OIA partial visual reconstruction — 26 visible routes',()=>{
  it('builds a valid portable draft and requires selection of real native destinations before use',()=>{
    const graph=oiaVisualReconstructionFlow();expect(validateAutomationGraph(graph)).toEqual([]);
    expect(graph.nodes.find(n=>n.type==='start')?.data).toMatchObject({reentry:'ONCE_PER_CONVERSATION'});
    const handoffs=graph.nodes.filter(n=>n.type==='handoff');expect(handoffs).toHaveLength(13);
    expect(handoffs.every(n=>!AutomationHandoffConfigV1Schema.safeParse(n.data).success)).toBe(true);
  });
  for(const [language,languageOption] of [['pt','1'],['en','2']] as const){
    for(const [di,department] of OIA_DEPARTMENTS.entries()){
      for(let option=1;option<=department.positions;option++)it(`${language}/${department.id}/${option}: preserves canonical context and emits one exact handoff`,async()=>{
        const definition=root();let result=await run(definition,'Olá');const all=[...result.effects];
        result=await run(definition,languageOption,result.state);all.push(...result.effects);
        result=await run(definition,String(di+1),result.state);all.push(...result.effects);
        result=await run(definition,String(option),result.state);all.push(...result.effects);
        expect(result.status).toBe('HANDOFF');expect(result.state.variables).toMatchObject({language,department:department.id,attendant_option:String(option),attendant_position:`${department.id}-${option}`});
        const handoffs=all.filter(effect=>effect.kind==='HANDOFF');expect(handoffs).toHaveLength(1);
        expect(handoffs[0]!.payload).toMatchObject(targets[`${department.id}-${option}`]!.handoff);
        expect(all.filter(effect=>effect.nodeId==='welcome')).toHaveLength(1);
        expect(all.filter(effect=>effect.nodeId==='closed-notice')).toHaveLength(0);
        expect(String(all.find(effect=>effect.nodeId===`announce-${department.id}-${option}-${language}`)?.payload.text)).toContain(department[language]);
      });
      it(`${language}/${department.id}: return keeps language, without greeting or assignment`,async()=>{
        const definition=root();let result=await run(definition,'hi');result=await run(definition,languageOption,result.state);
        result=await run(definition,String(di+1),result.state);result=await run(definition,String(department.positions+1),result.state);
        expect(result.state.variables.language).toBe(language);expect(result.state.waiting?.nodeId).toBe(`departments-${language}`);
        expect(result.effects).toHaveLength(1);expect(result.effects[0]?.kind).toBe('SEND_TEXT');expect(result.effects[0]?.nodeId).toBe(`departments-${language}`);
      });
    }
  }
  it.each(['2026-11-04T10:59:59Z','2026-11-04T21:00:00Z','2026-11-07T12:00:00Z','2026-11-08T12:00:00Z'])('notifies once outside the explicit HML schedule at %s and continues triage',async timestamp=>{
    const definition=root();let result=await run(definition,'hi',undefined,new Date(timestamp));
    expect(result.effects.filter(e=>e.nodeId==='closed-notice')).toHaveLength(1);expect(result.state.waiting?.nodeId).toBe('language');
    result=await run(definition,'x',result.state,new Date(timestamp));expect(result.effects).toHaveLength(1);
    expect(String(result.effects[0]?.payload.text)).toContain('Invalid option');expect(result.effects[0]?.nodeId).toBe('language');
  });
  it('accepts opening boundary in São Paulo and allows overriding the unconfirmed hours explicitly',async()=>{
    const definition=root();const result=await run(definition,'hi',undefined,new Date('2026-11-04T11:00:00Z'));
    expect(result.effects.some(e=>e.nodeId==='closed-notice')).toBe(false);
    const custom=oiaVisualReconstructionFlow({schedule:{timezone:'America/Sao_Paulo',weekly:[{day:6,start:'09:00',end:'10:00'}]}});
    expect(custom.nodes.find(n=>n.type==='schedule')?.data.weekly).toEqual([{day:6,start:'09:00',end:'10:00'}]);
  });
});
