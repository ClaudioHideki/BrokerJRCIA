// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router';
import {expect,it,vi} from 'vitest';
import {SessionProvider} from '../auth/SessionProvider.js';
import type {ApiClient} from '../api/client.js';
import {AutomationExecutionsPage} from '../pages/AutomationStudio.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const row={schemaVersion:1,id,organizationId:org,automationId:id,version:3,bindingId:id,channelId:id,status:'FAILED',currentNodeId:'capture',correlationId:id,startedAt:'2030-01-01T12:00:00.000Z',updatedAt:'2030-01-01T12:00:01.000Z',completedAt:'2030-01-01T12:00:01.000Z',durationMs:1000,errorCode:'AUTOMATION_STEP_LIMIT',conversationRef:id};
const page={data:[row],nextCursor:'next-page',metrics:{total:250,completed:100,active:100,failed:20,unknown:5,canceled:15,handoff:10,completionRate:40},period:{from:'2030-01-01T00:00:00.000Z',to:'2030-01-02T00:00:00.000Z'}};
function mount(request:(path:string,init?:RequestInit)=>Promise<unknown>){const organization={id:org,name:'Teste',slug:'teste',role:'OWNER'};
 const client={request,restore:async()=>({user:{id:org,email:'test@example.test'},activeOrganization:organization,organizations:[organization]}),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={['/automation-executions']}><Routes><Route path="/automation-executions" element={<AutomationExecutionsPage/>}/></Routes></MemoryRouter></SessionProvider>);
}
it('distinguishes loading from zero and uses full-interval server metrics while loading another page',async()=>{
 let resolve!:(value:unknown)=>void;const pending=new Promise(done=>{resolve=done;});const request=vi.fn(async(_path:string)=>pending);mount(request);
 expect(await screen.findByText('Carregando execuções…')).toBeVisible();expect(screen.queryByText('Nenhuma execução encontrada.')).toBeNull();
 await act(async()=>resolve(page));
 expect(await screen.findByText('250')).toBeVisible();expect(screen.getByText('40%')).toBeVisible();
 request.mockImplementation(async()=>({...page,data:[{...row,id:'33333333-3333-4333-8333-333333333333'}],nextCursor:null}));
 fireEvent.click(screen.getByRole('button',{name:'Carregar mais execuções'}));
 await waitFor(()=>expect(screen.getAllByRole('link',{name:/v3/})).toHaveLength(2));
 expect(String(request.mock.lastCall?.[0])).toContain('cursor=next-page');
});
it('sends status and identity filters to the API instead of filtering a truncated client list',async()=>{
 const request=vi.fn(async(_path:string)=>({...page,nextCursor:null}));mount(request);await screen.findByText('250');
 fireEvent.change(screen.getByRole('combobox',{name:'Status'}),{target:{value:'FAILED'}});
 fireEvent.change(screen.getByRole('textbox',{name:'ID da execução, conversa ou correlação'}),{target:{value:id}});
 fireEvent.change(screen.getByRole('textbox',{name:'ID da etapa'}),{target:{value:'capture'}});
 fireEvent.change(screen.getByRole('textbox',{name:'ID do canal'}),{target:{value:id}});
 fireEvent.click(screen.getByRole('button',{name:'Aplicar filtros'}));
 await waitFor(()=>expect(String(request.mock.lastCall?.[0])).toContain('status=FAILED'));
 expect(String(request.mock.lastCall?.[0])).toContain('search='+id);
 expect(String(request.mock.lastCall?.[0])).toContain('nodeId=capture');expect(String(request.mock.lastCall?.[0])).toContain('channelId='+id);
});
it('shows the recorded step, channel and conversation identities already authorized in each result',async()=>{
 mount(async()=>({...page,nextCursor:null}));await screen.findByText('250');
 expect(screen.getByText('capture')).toBeVisible();expect(screen.getByText('Canal:')).toBeVisible();
 expect(screen.getByText('Conversa:')).toBeVisible();expect(screen.getByText('Etapa registrada:')).toBeVisible();
 expect(screen.getByText('15')).toBeVisible();expect(screen.getByText('Canceladas')).toBeVisible();
});
it('does not display a failed request as an empty successful result',async()=>{
 mount(async()=>{throw Error('offline');});
 expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar as execuções.');
 expect(screen.queryByText('Nenhuma execução encontrada.')).toBeNull();
});
