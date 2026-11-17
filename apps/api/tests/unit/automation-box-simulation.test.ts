import {it,expect,vi} from 'vitest';
import {oiaBoxTemplateFlow} from '@jrc/contracts';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import {executeAutomation} from '../../src/modules/automations/engine.js';
it('uses an explicitly marked synthetic directory only inside simulation and never calls an external adapter',async()=>{
 const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2 as const,graph:oiaBoxTemplateFlow()},resolve=vi.fn(async()=>root);
 const result=await simulateConversation(root,{text:'Oi',replies:['1','1','1'],clock:'2030-01-01T12:00:00Z'},resolve);
 expect(result.status).toBe('HANDOFF');expect(result.routingFixture).toEqual({kind:'SIMULATION_ONLY',syntheticNames:true});
 expect(result.effects.some(e=>String(e.payload.text).includes('Atendente fictício'))).toBe(true);expect(resolve).not.toHaveBeenCalled();
 await expect(executeAutomation(root,{text:'Oi',eventType:'MESSAGE',now:new Date('2030-01-01T12:00:00Z')},resolve).then(first=>executeAutomation(root,{text:'1',eventType:'MESSAGE',now:new Date('2030-01-01T12:00:00Z'),inputWait:{waitId:first.wait!.waitId!,admittedAt:+new Date('2030-01-01T12:00:00Z')}},resolve,first.state)).then(second=>executeAutomation(root,{text:'1',eventType:'MESSAGE',now:new Date('2030-01-01T12:00:00Z'),inputWait:{waitId:second.wait!.waitId!,admittedAt:+new Date('2030-01-01T12:00:00Z')}},resolve,second.state))).rejects.toThrow('FLOW_BOX_PROFILE_REQUIRED');
});
