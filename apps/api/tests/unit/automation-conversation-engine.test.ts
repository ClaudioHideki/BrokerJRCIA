import {describe, expect, it} from 'vitest';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import type {PublishedAutomation, RuntimeInput, RuntimeState} from '../../src/modules/automations/types.js';

const id='11111111-1111-4111-8111-111111111111';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const action={conversationEffectVersion:2,operation:'note',channelId:id,text:'Private',target:'action.result',timeoutMs:15000};
const root:PublishedAutomation={automationId:id,version:1,runtimeStateVersion:2,graph:{
  nodes:[node('start','start'),node('action','note',action),node('end','end')],
  edges:[edge('start','action'),edge('action','end','success')],
}};
const now=new Date('2026-10-15T12:00:00Z');
const begin=(definition=root)=>executeAutomation(definition,{text:'Hi',eventType:'MESSAGE',now},async()=>definition);
const resume=(state:RuntimeState,payload:Record<string,unknown>,definition=root)=>
  executeAutomation(definition,{text:'',eventType:'RESUME',now,payload},async()=>definition,state);

describe('protocol 2 conversation effects in the canonical engine',()=>{
  it('emits an effect tied to the exact IO wait and active definition',async()=>{
    const result=await begin();
    expect(result.status).toBe('WAITING');
    expect(result.wait).toMatchObject({kind:'IO',nodeId:'action',waitId:expect.stringMatching(/^[a-f0-9-]{36}$/)});
    expect(result.state.waiting?.waitId).toBe(result.wait?.waitId);
    expect(result.effects).toEqual([expect.objectContaining({kind:'IO_CONVERSATION',ordinal:0,
      payload:expect.objectContaining({definitionAutomationId:id,definitionVersion:1,waitId:result.wait?.waitId})})]);
  });

  it('ignores another wait, missing identity, and message input without advancing',async()=>{
    const first=await begin();
    for(const waitId of [undefined,'22222222-2222-4222-8222-222222222222']) {
      const result=await resume(first.state,{outcome:'success',output:{confirmed:true},...(waitId?{waitId}:{})});
      expect(result).toMatchObject({status:'WAITING',effects:[],state:first.state});
    }
    const message=await executeAutomation(root,{text:'Unexpected',eventType:'MESSAGE',now},async()=>root,first.state);
    expect(message).toMatchObject({status:'WAITING',effects:[],state:first.state});
  });

  it('keeps UNKNOWN durable on the same wait without writing an output or emitting again',async()=>{
    const first=await begin();
    const result=await resume(first.state,{waitId:first.wait?.waitId,outcome:'unknown',output:{error:'UNCERTAIN'}});
    expect(result).toMatchObject({status:'WAITING',effects:[],state:{waiting:first.state.waiting}});
    expect(result.state.variables['action.result']).toBeUndefined();
    expect(result.trace).toContainEqual(expect.objectContaining({nodeId:'action',output:{outcome:'unknown',pending:true}}));
  });

  it('allocates a fresh identity when the same node executes again and rejects the old receipt',async()=>{
    const loop={...root,graph:{...root.graph,edges:[edge('start','action'),edge('action','action','success')]}};
    const first=await begin(loop);
    const second=await resume(first.state,{waitId:first.wait?.waitId,outcome:'success',output:{confirmed:true}},loop);
    expect(second.status).toBe('WAITING');
    expect(second.wait?.waitId).not.toBe(first.wait?.waitId);
    const stale=await resume(second.state,{waitId:first.wait?.waitId,outcome:'success',output:{confirmed:true}},loop);
    expect(stale).toMatchObject({status:'WAITING',effects:[],state:second.state});
  });

  it('ends the entire cycle when resolve succeeds, including a parent subflow frame',async()=>{
    const child:PublishedAutomation={...root,automationId:'33333333-3333-4333-8333-333333333333',graph:{
      nodes:[node('start','start'),node('close','resolve',{...action,operation:'resolve',text:undefined,status:'RESOLVED'})],
      edges:[edge('start','close')],
    }};
    delete child.graph.nodes[1]!.data.text;
    const parent:PublishedAutomation={...root,graph:{nodes:[node('start','start'),node('call','subflow',{automationId:child.automationId,version:1}),
      node('bad','message',{text:'Must not send'}),node('end','end')],edges:[edge('start','call'),edge('call','bad'),edge('bad','end')]}};
    const load=async(key:string)=>key===child.automationId?child:parent;
    const first=await executeAutomation(parent,{text:'Hi',eventType:'MESSAGE',now},load);
    expect(first.status).toBe('WAITING');
    const result=await executeAutomation(parent,{text:'',eventType:'RESUME',now,
      payload:{waitId:first.wait?.waitId,outcome:'success',output:{confirmed:true}}},load,first.state);
    expect(result).toMatchObject({status:'COMPLETED',effects:[],state:{nodeId:null,stack:[]}});
  });

  it('emits media through the same wait identity without treating enqueue as success',async()=>{
    const media={...root,graph:{...root.graph,nodes:root.graph.nodes.map(item=>item.id==='action'?node('action','media',{
      mediaEffectVersion:2,channelId:id,mediaId:id,mediaRevision:1,target:'action.result',caption:'Caption',timeoutMs:15000,
    }):item)}};
    const result=await begin(media);
    expect(result).toMatchObject({status:'WAITING',effects:[{kind:'SEND_MEDIA',payload:{waitId:result.wait?.waitId}}]});
  });

  it('preserves historical unmarked and version 1 behavior without admitting a protocol 2 effect',async()=>{
    for(const version of [undefined,1]) {
      const historical={...root,graph:{...root.graph,nodes:root.graph.nodes.map(item=>item.id==='action'?
        node('action','note',{...action,conversationEffectVersion:version}):item)}};
      expect(await begin(historical)).toMatchObject({status:'COMPLETED',effects:[]});
    }
  });

  it('allows only an internal deterministic wait factory for reconstruction',async()=>{
    const input:RuntimeInput={text:'Hi',eventType:'MESSAGE',now,
      effectWaitId:scope=>{expect(scope).toMatchObject({automationId:id,version:1,nodeId:'action'});return id;}};
    const result=await executeAutomation(root,input,async()=>root);
    expect(result.wait?.waitId).toBe(id);
    expect(result.effects[0]?.payload.waitId).toBe(id);
  });
});
