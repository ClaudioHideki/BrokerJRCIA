import {describe,expect,it} from 'vitest';
import {InputCaptureConfigSchema} from '@jrc/contracts';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import type {PublishedAutomation,RuntimeInput,RuntimeState} from '../../src/modules/automations/types.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,data,position:{x:0,y:0}});
const config={inputConfigVersion:3,inputType:'image',variable:'attachment',maxAttempts:2,timeoutSeconds:30};
const root:PublishedAutomation={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,graph:{
 nodes:[node('start','start'),node('capture','input',config),node('end','end'),node('fallback','end')],
 edges:[{id:'begin',source:'start',target:'capture',port:'next'},...['next','exhausted','timeout'].map(port=>({id:port,source:'capture',target:port==='next'?'end':'fallback',port}))],
}};
const now=new Date('2030-01-01T00:00:00.000Z'),image={source:'SIMULATION_FIXTURE' as const,kind:'image' as const,fileName:'synthetic.png'};
const resolve=async()=>root;
const begin=()=>executeAutomation(root,{text:'Oi',eventType:'MESSAGE',now},resolve);
const reply=(state:RuntimeState,media?:typeof image|{source:'SIMULATION_FIXTURE';kind:'document';fileName:string}):RuntimeInput=>({
 text:'',eventType:'MESSAGE',now:new Date(now.getTime()+1000),inputWait:{waitId:state.waiting!.waitId!,admittedAt:now.getTime()+1000},...(media?{media}:{})});

describe('versioned media capture',()=>{
 it('requires V3 explicitly so older typed capture schemas cannot silently accept an attachment',()=>{
  expect(InputCaptureConfigSchema.safeParse(config).success).toBe(true);
  expect(InputCaptureConfigSchema.safeParse({...config,inputConfigVersion:2}).success).toBe(false);
 });
 it('captures only the typed reference and keeps binary/download data out of state and trace',async()=>{
  const first=await begin();expect(first.state.waiting).toMatchObject({inputConfigVersion:3,invalidAttempts:0});
  const result=await executeAutomation(root,reply(first.state,image),resolve,first.state);
  expect(result.status).toBe('COMPLETED');expect(result.state.variables.attachment).toEqual(image);expect(result.effects).toEqual([]);
  expect(JSON.stringify(result.trace)).not.toContain('synthetic.png');
 });
 it('counts an incorrect attachment kind and preserves the original deadline before a valid retry',async()=>{
  const first=await begin();const invalid=await executeAutomation(root,reply(first.state,{source:'SIMULATION_FIXTURE',kind:'document',fileName:'synthetic.pdf'}),resolve,first.state);
  expect(invalid.status).toBe('WAITING');expect(invalid.state.variables).not.toHaveProperty('attachment');
  expect(invalid.state.waiting).toMatchObject({inputConfigVersion:3,invalidAttempts:1,deadlineAt:first.state.waiting!.deadlineAt});
  expect(invalid.state.waiting!.waitId).not.toBe(first.state.waiting!.waitId);
  expect((await executeAutomation(root,reply(invalid.state,image),resolve,invalid.state)).state.variables.attachment).toEqual(image);
 });
 it('does not treat a filename or a caller payload as an attached image',async()=>{
  const first=await begin(),input={...reply(first.state),text:'https://example.test/photo.png',payload:{media:image}};
  const result=await executeAutomation(root,input,resolve,first.state);
  expect(result.status).toBe('WAITING');expect(result.state.waiting?.invalidAttempts).toBe(1);expect(result.state.variables).not.toHaveProperty('attachment');
 });
 it('reconstructs a media reply in Playground as a fixture without claiming custody',async()=>{
  const result=await simulateConversation(root,{text:'Oi',clock:now.toISOString(),events:[{type:'MEDIA',kind:'image',fileName:'synthetic.png'}]},resolve);
  expect(result.status).toBe('COMPLETED');expect(result.state.variables.attachment).toEqual(image);
 });
 it('fails closed if a caller tries to hand media to a historical text capture runtime',async()=>{
  const legacy={...root,graph:{...root.graph,nodes:root.graph.nodes.map(node=>node.id==='capture'?{...node,data:{...config,inputConfigVersion:2,inputType:'text'}}:node)}};
  const first=await executeAutomation(legacy,{text:'Oi',eventType:'MESSAGE',now},async()=>legacy);
  await expect(executeAutomation(legacy,{...reply(first.state,image),text:'caption'},async()=>legacy,first.state))
   .rejects.toThrow('AUTOMATION_INPUT_MEDIA_VERSION_MISMATCH');
 });
});
