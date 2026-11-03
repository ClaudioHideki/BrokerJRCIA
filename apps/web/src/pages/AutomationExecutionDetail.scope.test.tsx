// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes,useNavigate} from 'react-router';
import {expect,it,vi} from 'vitest';
import {SessionProvider,useSession} from '../auth/SessionProvider.js';
import type {ApiClient} from '../api/client.js';
import {AutomationExecutionDetailPage} from './AutomationStudio.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const result=(id:string,correlationId:string)=>({id,automationId:first,channelId:first,version:1,status:'COMPLETED',correlationId,nodes:[],outbox:[]});
function Controls(){const navigate=useNavigate(),{switchOrganization}=useSession();return <><button onClick={()=>navigate('/execution/'+second)}>Outra execução</button><button onClick={()=>void switchOrganization(other)}>Outra empresa</button></>;}
function mount(request:(path:string)=>Promise<unknown>){const organization={id:org,name:'Teste',slug:'teste',role:'OWNER'},session=(id=org)=>({user:{id:org,email:'test@example.test'},activeOrganization:{...organization,id},organizations:[organization]});
 const client={request,restore:async()=>session(),switchOrganization:async()=>session(other),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={['/execution/'+first]}><Controls/><Routes><Route path="/execution/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
}
it('ignores a late detail response after navigating to another execution',async()=>{
 let resolve!:(value:unknown)=>void;const pending=new Promise(done=>{resolve=done;}),request=vi.fn(async(path:string)=>path.endsWith(first)?pending:result(second,'CURRENT_EXECUTION'));
 mount(request);await waitFor(()=>expect(request).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:'Outra execução'}));
 expect(await screen.findByText('CURRENT_EXECUTION')).toBeVisible();await act(async()=>resolve(result(first,'STALE_EXECUTION')));
 expect(screen.queryByText('STALE_EXECUTION')).toBeNull();expect(screen.getByText('CURRENT_EXECUTION')).toBeVisible();
});
it('clears details and suppresses a late response when the active organization changes',async()=>{
 let resolve!:(value:unknown)=>void;const pending=new Promise(done=>{resolve=done;}),request=vi.fn(async()=>pending);
 mount(request);await waitFor(()=>expect(request).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:'Outra empresa'}));
 request.mockImplementation(async()=>result(first,'CURRENT_TENANT'));
 await act(async()=>resolve(result(first,'STALE_TENANT')));
 expect(screen.queryByText('STALE_TENANT')).toBeNull();expect(await screen.findByText('CURRENT_TENANT')).toBeVisible();
});
