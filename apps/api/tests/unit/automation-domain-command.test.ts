import {expect,it,vi} from 'vitest';
import {ConversationEffectConfigSchema,getNodeDefinition,validateAutomationGraph,type AutomationGraphV1} from '@jrc/contracts';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import {ConversationEffectRequestSchema} from '../../src/modules/automations/conversation-effect-protocol.js';

const identity='11111111-1111-4111-8111-111111111111';
const config={conversationEffectVersion:2,operation:'domain',channelId:identity,target:'domain.result',timeoutMs:15000,command:'create_lead'};
const scope={organization_id:identity,integration_id:identity,operation_id:identity,dispatch_proof:identity,
  inbox_id:'2',remote_contact_id:'4',expected_control_revision:'5',operation:'domain'};

it('identifies a simulated domain result without calling transport or inventing a native resource',async()=>{
 const node=(id:string,type:string,data:Record<string,unknown>)=>({id,type,label:id,position:{x:0,y:0},data});
 const graph:AutomationGraphV1={nodes:[node('start','start',{}),node('domain','domain',config),node('end','end',{})],
  edges:[{id:'start-domain',source:'start',target:'domain',port:'next'},...['success','error','timeout'].map(port=>({id:port,source:'domain',target:'end',port}))]};
 const published={automationId:identity,version:1,graph,runtimeStateVersion:2 as const};
 const input={text:'Synthetic',clock:'2030-01-01T12:00:00.000Z'};
 const transport=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No real transport in simulation'));
 try{
  const waiting=await simulateConversation(published,input,async()=>published);
  expect(waiting.actionWait).toMatchObject({nodeId:'domain',operation:'domain'});
  const done=await simulateConversation(published,{...input,events:[{type:'ACTION_RESPONSE',nodeId:'domain',waitId:waiting.actionWait!.waitId,outcome:'success'}]},async()=>published);
  expect(done.status).toBe('COMPLETED');
  expect(done.state.variables['domain.result']).toEqual({operation:'domain',confirmed:true,simulated:true});
  expect(transport).not.toHaveBeenCalled();
 }finally{transport.mockRestore();}
});

it('exposes a finite typed domain node and rejects arbitrary remote actions',()=>{
 expect(getNodeDefinition('domain',1)?.runtimeSupported).toBe(true);
 expect(ConversationEffectConfigSchema.safeParse(config).success).toBe(true);
 expect(ConversationEffectConfigSchema.safeParse({...config,command:'send_message'}).success).toBe(false);
 expect(ConversationEffectConfigSchema.safeParse({...config,url:'https://unexpected.example.test'}).success).toBe(false);
});

it('requires an explicit current owner, title and date source for native activities',()=>{
 expect(ConversationEffectConfigSchema.safeParse({...config,command:'create_task'}).success).toBe(false);
 const task={...config,command:'create_task',ownerId:7,title:'Return to {{message}}',dueAt:{kind:'VARIABLE',variable:'return.at'}};
 expect(ConversationEffectConfigSchema.safeParse(task).success).toBe(true);
 expect(ConversationEffectConfigSchema.safeParse({...task,ownerId:0}).success).toBe(false);
 expect(ConversationEffectConfigSchema.safeParse({...task,dueAt:{kind:'VARIABLE',variable:'__proto__.at'}}).success).toBe(false);
});

it('admits only bounded typed native arguments under the integration and conversation control scope',()=>{
 expect(ConversationEffectRequestSchema.safeParse({...scope,value_json:JSON.stringify({command:'create_lead'})}).success).toBe(true);
 expect(ConversationEffectRequestSchema.safeParse({...scope,integration_id:undefined,value_json:JSON.stringify({command:'create_lead'})}).success).toBe(false);
 expect(ConversationEffectRequestSchema.safeParse({...scope,value_json:JSON.stringify({command:'create_lead',sql:'select 1'})}).success).toBe(false);
 expect(ConversationEffectRequestSchema.safeParse({...scope,value_json:JSON.stringify({command:'create_task',owner_id:7,title:'Task',due_at:'tomorrow'})}).success).toBe(false);
});

it('waits for the persisted native receipt and exposes success, error and unknown in the same engine',async()=>{
 const node=(id:string,type:string,data:Record<string,unknown>)=>({id,type,label:id,position:{x:0,y:0},data});
 const graph:AutomationGraphV1={nodes:[node('start','start',{}),node('domain','domain',config),node('end','end',{})],
  edges:[{id:'start-domain',source:'start',target:'domain',port:'next'},...['success','error','timeout'].map(port=>({id:port,source:'domain',target:'end',port}))]};
 expect(validateAutomationGraph(graph)).toEqual([]);
 const published={automationId:identity,version:1,graph,runtimeStateVersion:2 as const};
 const first=await executeAutomation(published,{text:'Synthetic',eventType:'MESSAGE',now:new Date(),effectWaitId:()=>identity},async()=>published);
 expect(first.status).toBe('WAITING');expect(first.effects).toMatchObject([{kind:'IO_CONVERSATION',payload:{operation:'domain',waitId:identity}}]);
 const uncertain=await executeAutomation(published,{text:'',eventType:'RESUME',now:new Date(),payload:{waitId:identity,outcome:'unknown'}},async()=>published,first.state);
 expect(uncertain.status).toBe('WAITING');expect(uncertain.effects).toEqual([]);
 const done=await executeAutomation(published,{text:'',eventType:'RESUME',now:new Date(),payload:{waitId:identity,outcome:'success',output:{resourceId:7,confirmed:true}}},async()=>published,first.state);
 expect(done.status).toBe('COMPLETED');expect(done.state.variables['domain.result']).toEqual({resourceId:7,confirmed:true});
});
