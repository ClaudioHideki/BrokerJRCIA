import {expect,it} from 'vitest';
import {operatorReceptionFlow} from '../src/operator-reception.js';
import {validateAutomationGraph} from '../src/automations-v1.js';
import {executeAutomation} from '../../../apps/api/src/modules/automations/engine.js';

it.each(['comercial','suporte','financeiro','trabalhe-conosco','privacidade','jrc-conversas'])(
 'routes %s through capture and only its own human handoff',async route=>{
  const graph=operatorReceptionFlow();
  expect(validateAutomationGraph(graph)).toEqual([]);
  const choice=graph.nodes.find(node=>node.type==='menu')!.data.options as {value:string;label:string;route:string}[];
  const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2 as const,graph};
  const resolve=async()=>{throw Error('No external dependency expected');};
  const now=new Date('2030-01-01T12:00:00Z');
  const opening=await executeAutomation(root,{text:'oi',eventType:'MESSAGE',now},resolve);
  expect(opening.status).toBe('WAITING');
  expect(opening.wait?.nodeId).toBe('menu');
  const invalid=await executeAutomation(root,{text:'invalido',eventType:'MESSAGE',now},resolve,opening.state);
  expect(invalid.wait?.nodeId).toBe('menu');
  const option=choice.find(item=>item.route===route)!;
  const selected=await executeAutomation(root,{text:option.value,eventType:'MESSAGE',now},resolve,invalid.state);
  expect(selected.wait?.nodeId).toBe(`capture-${route}`);
  const captured=await executeAutomation(root,{text:'solicitacao sintetica',eventType:'MESSAGE',now,
   inputWait:{waitId:selected.wait!.waitId!,admittedAt:now.getTime()}},resolve,selected.state);
  expect(captured.status).toBe('HANDOFF');
  expect(captured.effects.filter(effect=>effect.kind==='HANDOFF')).toMatchObject([{nodeId:`handoff-${route}`}]);
  expect(captured.state.variables[`request.${route.replaceAll('-','_')}`]).toBe('solicitacao sintetica');
  expect(graph.nodes.some(node=>['http','sql','code','ai-agent'].includes(node.type))).toBe(false);
 });

it('ends an unanswered capture after 15 minutes without claiming a human transfer',async()=>{
 const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2 as const,graph:operatorReceptionFlow()};
 const resolve=async()=>{throw Error('No external dependency expected');};
 const now=new Date('2030-01-01T12:00:00Z');
 const opening=await executeAutomation(root,{text:'oi',eventType:'MESSAGE',now},resolve);
 const selected=await executeAutomation(root,{text:'2',eventType:'MESSAGE',now},resolve,opening.state);
 const timedOut=await executeAutomation(root,{text:'',eventType:'TIMER',now:new Date(now.getTime()+900_000),
  inputWait:{waitId:selected.wait!.waitId!}},resolve,selected.state);
 expect(timedOut.status).toBe('COMPLETED');
 expect(timedOut.effects).toMatchObject([{kind:'SEND_TEXT',nodeId:'timeout'}]);
 expect(timedOut.effects.some(effect=>effect.kind==='HANDOFF')).toBe(false);
});
