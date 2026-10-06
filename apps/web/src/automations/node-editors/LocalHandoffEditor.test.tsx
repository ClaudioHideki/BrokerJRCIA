// @vitest-environment jsdom
import { useState } from 'react';
import { act,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import type { FlowNode } from '@jrc/contracts';
import type { ApiClient } from '../../api/client.js';
import { HandoffEditor } from './HandoffEditor.js';
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222';
const node:FlowNode={id:'h',label:'Atendimento',type:'handoff',position:{x:0,y:0},data:{handoffVersion:1}};
const status={configured:false,baseUrl:null,provisioningAvailable:false,account:null,connections:[],jobs:{}};
const data=[{scope:{kind:'LOCAL',organizationId:org,channelId:channel},name:'Caixa sintética local'}];
const agent='33333333-3333-4333-8333-333333333333',team='44444444-4444-4444-8444-444444444444';
const catalog={scope:data[0]!.scope,agents:[{id:agent,email:'attendant@example.test',role:'OPERATOR'}],teams:[{id:team,name:'Suporte local',revision:1,memberIds:[agent]}]};
function harness(client:ApiClient,change=vi.fn(),initial=node,tenant=org){
 const [current,setCurrent]=useState(initial);
 return <HandoffEditor client={client} organizationId={tenant} editable node={current} onChange={value=>{change(value);setCurrent({...current,data:value});}}/>;
}
it('explicitly selects a local queue without any remote account or inbox identity',async()=>{
 const change=vi.fn(),client={request:vi.fn(async(path:string)=>path==='/v1/attendance/local-channels'?{data}:status)} as unknown as ApiClient;
 function Harness(){return harness(client,change);}render(<Harness/>);
 fireEvent.click(screen.getByRole('button',{name:'Usar fila do Broker'}));
 fireEvent.change(await screen.findByLabelText('Caixa do Broker'),{target:{value:channel}});
 expect(change).toHaveBeenLastCalledWith({handoffVersion:2,destination:data[0]!.scope,target:{kind:'QUEUE'}});
 expect(screen.getByText(/fila humana do Broker/i)).toBeVisible();expect(screen.queryByLabelText('Time de atendimento')).toBeNull();
});
it('rejects another tenant catalog and preserves the saved node',async()=>{
 const initial={...node,data:{handoffVersion:2,destination:data[0]!.scope,target:{kind:'QUEUE'}}},change=vi.fn();
 const client={request:vi.fn(async()=>({data:[{...data[0],scope:{...data[0]!.scope,organizationId:channel}}]}))} as unknown as ApiClient;
 function Harness(){return harness(client,change,initial);}render(<Harness/>);
 expect(await screen.findByRole('alert')).toHaveTextContent(/escopo/i);expect(change).not.toHaveBeenCalled();
});
it('discards a pending local catalog when the company changes',async()=>{
 let resolve:(value:unknown)=>void=()=>{};
 const request=vi.fn(async(_path:string,options?:RequestInit)=>{if(request.mock.calls.length===1)return new Promise(r=>{resolve=r;});return {data:[]};});
 const client={request} as unknown as ApiClient,initial={...node,data:{handoffVersion:2,destination:data[0]!.scope,target:{kind:'QUEUE'}}};
 const view=render(<HandoffEditor client={client} organizationId={org} editable node={initial} onChange={vi.fn()}/>);
 await waitFor(()=>expect(request).toHaveBeenCalledOnce());
 expect(request.mock.calls[0]![0]).toBe('/v1/attendance/local-channels');
 const signal=request.mock.calls[0]![1]!.signal!;
 view.rerender(<HandoffEditor client={client} organizationId={channel} editable node={node} onChange={vi.fn()}/>);
 await act(async()=>{resolve({data});});
 expect(signal.aborted).toBe(true);expect(screen.queryByRole('option',{name:'Caixa sintética local'})).toBeNull();
});
it('selects scoped local team and agent targets through an ordinary keyboard-accessible select',async()=>{
 const change=vi.fn(),client={request:vi.fn(async(path:string)=>path.endsWith('/catalog')?catalog:path==='/v1/attendance/local-channels'?{data}:status)} as unknown as ApiClient;
 const initial={...node,data:{handoffVersion:2,destination:data[0]!.scope,target:{kind:'QUEUE'}}};
 function Harness(){return harness(client,change,initial);}render(<Harness/>);
 const select=await screen.findByLabelText('Destino humano no Broker');
 await screen.findByRole('option',{name:'Time: Suporte local'});
 select.focus();expect(select).toHaveFocus();
 fireEvent.change(select,{target:{value:`TEAM:${team}`}});
 expect(change).toHaveBeenLastCalledWith({handoffVersion:2,destination:data[0]!.scope,target:{kind:'TEAM',teamId:team}});
 fireEvent.change(select,{target:{value:`AGENT:${agent}`}});
 expect(change).toHaveBeenLastCalledWith({handoffVersion:2,destination:data[0]!.scope,target:{kind:'AGENT',agentId:agent}});
 expect(screen.getByText('A conversa aguarda atendimento. Escolher um agente não significa que ele já aceitou a conversa.')).toBeVisible();
});
it('clears the previous target only after an explicit channel change',async()=>{
 const second={scope:{...data[0]!.scope,channelId:team},name:'Segunda caixa'},change=vi.fn();
 const initial={...node,data:{handoffVersion:2,destination:data[0]!.scope,target:{kind:'AGENT',agentId:agent}}};
 const client={request:vi.fn(async(path:string)=>path.endsWith('/catalog')?{...catalog,scope:path.includes(team)?second.scope:catalog.scope}:path==='/v1/attendance/local-channels'?{data:[...data,second]}:status)} as unknown as ApiClient;
 function Harness(){return harness(client,change,initial);}render(<Harness/>);
 await screen.findByRole('option',{name:'Agente: attendant@example.test'});expect(change).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Caixa do Broker'),{target:{value:team}});
 expect(change).toHaveBeenLastCalledWith({handoffVersion:2,destination:second.scope,target:{kind:'QUEUE'}});
});
it('discards a delayed directory response after switching company and preserves the node',async()=>{
 let resolve:(value:unknown)=>void=()=>{};const change=vi.fn(),initial={...node,data:{handoffVersion:2,destination:data[0]!.scope,target:{kind:'QUEUE'}}};
 const request=vi.fn(async(path:string)=>path.endsWith('/catalog')?new Promise(r=>{resolve=r;}):{data:path==='/v1/attendance/local-channels'?[...data]:[]});
 const client={request} as unknown as ApiClient,view=render(<HandoffEditor client={client} organizationId={org} editable node={initial} onChange={change}/>);
 await waitFor(()=>expect(request.mock.calls.some(([path])=>path.endsWith('/catalog'))).toBe(true));
 view.rerender(<HandoffEditor client={client} organizationId={channel} editable node={node} onChange={change}/>);
 await act(async()=>{resolve(catalog);});
 expect(screen.queryByRole('option',{name:'Agente: attendant@example.test'})).toBeNull();expect(change).not.toHaveBeenCalled();
});
