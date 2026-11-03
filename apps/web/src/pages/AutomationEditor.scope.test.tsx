// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router';
import {afterEach,expect,it,vi} from 'vitest';
import {AUTOMATION_NODE_CATALOG_V1,welcomeFlow} from '@jrc/contracts';
import {SessionProvider,useSession} from '../auth/SessionProvider.js';
import type {ApiClient} from '../api/client.js';
import {AutomationEditorPage} from './AutomationStudio.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function Switch(){const {switchOrganization}=useSession();return <button onClick={()=>void switchOrganization(other)}>Trocar empresa</button>;}
afterEach(()=>sessionStorage.clear());
it('does not restore a saved draft or persist its local data into a different organization after switching',async()=>{
 const definition={schemaVersion:1,id,organizationId:org,name:'OLD_TENANT_FLOW',lifecycleStatus:'DRAFT',draft:{revision:1,graph:welcomeFlow()},activeVersion:null,updatedAt:'2030-01-01T00:00:00Z'};
 let active=org,resolve!:(value:unknown)=>void;const pending=new Promise(done=>{resolve=done;});
 const organization=(id:string)=>({id,name:id,slug:id,role:'OWNER'}),session=(id:string)=>({user:{id:org,email:'test@example.test'},activeOrganization:organization(id),organizations:[organization(org),organization(other)]});
 const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path==='/v1/automations/status')return{enabled:true,canEdit:true,canPublish:true};if(path==='/v1/automation-nodes')return{data:AUTOMATION_NODE_CATALOG_V1};
  if(init?.method==='PUT')return pending;if(active===other)throw Error('not found in new tenant');return definition;
 });
 const client={request,restore:async()=>session(org),switchOrganization:async()=>{active=other;return session(other);},registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={['/automations/'+id+'/edit']}><Switch/><Routes><Route path="/automations/:id/edit" element={<AutomationEditorPage/>}/></Routes></MemoryRouter></SessionProvider>);
 fireEvent.change(await screen.findByRole('textbox',{name:'Nome da automação'}),{target:{value:'PRIVATE_LOCAL_DRAFT'}});fireEvent.click(screen.getByRole('button',{name:'Salvar'}));
 await waitFor(()=>expect(request.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'Trocar empresa'}));await waitFor(()=>expect(active).toBe(other));
 await act(async()=>resolve({...definition,name:'PRIVATE_SAVED_DRAFT',draft:{...definition.draft,revision:2}}));
 expect(screen.queryByDisplayValue('PRIVATE_SAVED_DRAFT')).toBeNull();expect(sessionStorage.getItem('jrc-automation-draft:'+other+':'+id)).toBeNull();
});
