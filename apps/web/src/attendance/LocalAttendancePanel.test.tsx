// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {ApiClient} from '../api/client.js';
import {ApiClientError} from '../api/client.js';
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',actor='33333333-3333-4333-8333-333333333333',sessionId='44444444-4444-4444-8444-444444444444',teamId='55555555-5555-4555-8555-555555555555';
const row={conversationId:actor,sessionId,sessionRevision:3,cycle:1,state:'WAITING_HUMAN',target:{kind:'QUEUE'}},queue={scope:{kind:'LOCAL',organizationId:org,channelId:channel},data:[row]};
const agents=[{id:actor,email:'operator@example.test',role:'OPERATOR'}],team={id:teamId,name:'Support',status:'ACTIVE',revision:2,memberIds:[]};
async function panel(){const path='./LocalAttendancePanel.js',mod=await import(path).catch(()=>null);expect(mod?.LocalAttendancePanel,'local human panel').toBeTypeOf('function');return mod!.LocalAttendancePanel;}
it('an operator explicitly claims a waiting session with its exact identity and revision',async()=>{
 const Panel=await panel(),assigned=vi.fn(),request=vi.fn(async(path:string,init?:RequestInit)=>init?.method==='POST'?{...row,state:'HUMAN_ACTIVE',sessionRevision:4,target:{kind:'AGENT',agentId:actor}}:queue);
 render(<Panel client={{request} as unknown as ApiClient} organizationId={org} channelId={channel} actorId={actor} role="OPERATOR" onAssigned={assigned}/>);
 fireEvent.click(screen.getByRole('button',{name:'Consultar fila do Broker'}));
 fireEvent.click(await screen.findByRole('button',{name:'Assumir conversa'}));
 await waitFor(()=>expect(assigned).toHaveBeenCalledOnce());
 expect(assigned).toHaveBeenCalledWith(expect.objectContaining({conversationId:actor,sessionId,state:'HUMAN_ACTIVE'}));
 const [,options]=request.mock.calls.find(([,options])=>options?.method==='POST')!;
 expect(JSON.parse(options!.body as string)).toEqual({expectedSessionId:sessionId,sessionRevision:3,target:{kind:'AGENT',agentId:actor}});
 expect(screen.getByText('Atendimento assumido.')).toBeVisible();expect(screen.queryByRole('button',{name:'Gerenciar times do Broker'})).toBeNull();
});
it('an admin creates a team and edits its members with the returned revision',async()=>{
 const Panel=await panel(),request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST')return team;
  if(init?.method==='PUT')return {...team,revision:3,memberIds:[actor]};
  return {agents,teams:[team]};
 });
 render(<Panel client={{request} as unknown as ApiClient} organizationId={org} channelId={channel} actorId={actor} role="ADMIN" onAssigned={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Gerenciar times do Broker'}));
 fireEvent.change(await screen.findByLabelText('Nome do novo time'),{target:{value:'Support'}});
 fireEvent.click(screen.getByRole('button',{name:'Criar time'}));await screen.findByText('Time criado.');
 fireEvent.change(screen.getByLabelText('Time do Broker'),{target:{value:teamId}});
 fireEvent.click(screen.getByLabelText('operator@example.test'));
 fireEvent.click(screen.getByRole('button',{name:'Salvar membros'}));await screen.findByText('Membros atualizados.');
 const [,options]=request.mock.calls.find(([path,options])=>path.endsWith('/members')&&options?.method==='PUT')!;
 expect(JSON.parse(options!.body as string)).toEqual({expectedRevision:2,memberIds:[actor]});
});
it('a stale claim reports a conflict and does not confirm an assignment',async()=>{
 const Panel=await panel(),assigned=vi.fn(),request=vi.fn(async(_path:string,init?:RequestInit)=>{if(init?.method==='POST')throw new ApiClientError('Changed',409);return queue;});
 render(<Panel client={{request} as unknown as ApiClient} organizationId={org} channelId={channel} actorId={actor} role="OPERATOR" onAssigned={assigned}/>);
 fireEvent.click(screen.getByRole('button',{name:'Consultar fila do Broker'}));fireEvent.click(await screen.findByRole('button',{name:'Assumir conversa'}));
 expect(await screen.findByRole('alert')).toHaveTextContent(/Atualize/i);expect(assigned).not.toHaveBeenCalled();
});
it('aborts an old tenant request and never shows its queue in the new tenant',async()=>{
 const Panel=await panel();let resolve:(v:unknown)=>void=()=>{};
 const request=vi.fn(async()=>new Promise(r=>{resolve=r;})),client={request} as unknown as ApiClient;
 const view=render(<Panel client={client} organizationId={org} channelId={channel} actorId={actor} role="OPERATOR" onAssigned={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Consultar fila do Broker'}));await waitFor(()=>expect(request).toHaveBeenCalledOnce());
 view.rerender(<Panel client={client} organizationId={teamId} channelId={channel} actorId={actor} role="OPERATOR" onAssigned={vi.fn()}/>);
 await act(async()=>{resolve(queue);});expect(screen.queryByRole('button',{name:'Assumir conversa'})).toBeNull();
});
it('a viewer cannot open administration or mutate a queue',async()=>{
 const Panel=await panel(),request=vi.fn();
 render(<Panel client={{request} as unknown as ApiClient} organizationId={org} channelId={channel} actorId={actor} role="VIEWER" onAssigned={vi.fn()}/>);
 expect(screen.queryByRole('button',{name:'Consultar fila do Broker'})).toBeNull();expect(request).not.toHaveBeenCalled();
});
