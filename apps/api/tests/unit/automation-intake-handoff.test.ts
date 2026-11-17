import {describe,it,expect} from 'vitest';
import {executeAutomation} from '../../src/modules/automations/engine.js';

describe('native handoff with captured intake',()=>{
 it.each([
  {text:'Synthetic help',error:null},
  {text:'🟢'.repeat(2000),error:'intake_capture_too_large'},
  {text:'a'.repeat(1001),impact:'{{message}}',error:'intake_capture_invalid'},
  {text:'a'.repeat(3001),template:'{{message}}{{message}}',error:'intake_capture_invalid'},
 ])('emits handoff directly when capture needs $error review',async scenario=>{
  const graph={nodes:[{id:'s',type:'start',label:'Start',position:{x:0,y:0},data:{}},
   {id:'h',type:'handoff',label:'Human',position:{x:1,y:0},data:{handoffVersion:1,
    destination:{integrationId:'11111111-1111-4111-8111-111111111111',destinationRevision:1,accountId:3,inboxId:13,credentialRevision:1},
    target:{teamId:2,agentId:null},intake:{configurationId:7,configurationRevision:2,input:{system:'example',location:'south',
     reason:'request',subject:'access',identifier:'00000000000',email:'invalid',description:scenario.template??'{{message}}',
     ...(scenario.impact?{impact:scenario.impact}:{})}}}}],
   edges:[{id:'e',source:'s',target:'h',port:'next'}]};
  const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2 as const,graph};
  const result=await executeAutomation(root,{text:scenario.text,eventType:'MESSAGE',now:new Date()},async()=>root);
  expect(result.status).toBe('HANDOFF');expect(result.effects).toHaveLength(1);
  expect(result.effects[0]).toMatchObject({kind:'HANDOFF',payload:{target:{teamId:2,agentId:null},
   intakeRequest:{configuration_id:7,configuration_revision:2,...(scenario.error?
    {input:{},capture_error:scenario.error}:{input:{description:scenario.text,email:'invalid'}})}}});
  expect(result.effects[0]!.payload).not.toHaveProperty('intake');
 });
});
