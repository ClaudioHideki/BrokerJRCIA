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
