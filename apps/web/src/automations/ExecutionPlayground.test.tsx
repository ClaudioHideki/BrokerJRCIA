// @vitest-environment jsdom
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router';
import {expect,it,vi} from 'vitest';
import {SessionProvider} from '../auth/SessionProvider.js';
import type {ApiClient} from '../api/client.js';
import {AutomationExecutionDetailPage} from '../pages/AutomationStudio.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',flow='33333333-3333-4333-8333-333333333333';
it('opens a separate historical playground and sends replay only to the execution simulation endpoint',async()=>{
 const requests:Array<{path:string;method:string;body:unknown}>=[];
 const request=vi.fn(async(path:string,init?:RequestInit)=>{requests.push({path,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});
  if(path===`/v1/executions/${id}`)return{id,automationId:flow,version:1,status:'COMPLETED',channelId:id,correlationId:id,nodes:[],outbox:[]};
  if(path.endsWith('/playground'))return{executionId:id,automationId:flow,version:1,text:'Mensagem original',clock:'2030-01-01T12:00:00Z'};
  if(path.endsWith('/simulate'))return{source:{executionId:id,automationId:flow,version:1},status:'COMPLETED',state:{variables:{}},effects:[{kind:'SEND_TEXT',payload:{text:'Resultado histórico'}}],trace:[]};
  throw Error(path);
 });
 const organization={id:org,name:'Teste',slug:'teste',role:'OWNER'};
 const client={request,restore:async()=>({user:{id:org,email:'test@example.test'},activeOrganization:organization,organizations:[organization]}),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={['/automation-executions/'+id]}><Routes><Route path="/automation-executions/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Abrir no Playground'}));
 expect(await screen.findByLabelText('Mensagem inicial do replay')).toHaveValue('Mensagem original');
 fireEvent.change(screen.getByLabelText('Mensagem inicial do replay'),{target:{value:'Outro cenário'}});
 fireEvent.click(screen.getByRole('button',{name:'Simular versão histórica'}));
 expect(await screen.findByText('Resultado histórico')).toBeVisible();
 expect(requests.find(item=>item.method==='POST')).toEqual({path:`/v1/executions/${id}/simulate`,method:'POST',body:{text:'Outro cenário',clock:'2030-01-01T12:00:00Z',events:[]}});
 expect(requests.every(item=>!item.path.includes('/automations/')&&!item.path.endsWith('/retry'))).toBe(true);
 await waitFor(()=>expect(screen.getByText(/Nenhuma execução real será retomada/)).toBeVisible());
});
