// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router';
import {expect,it} from 'vitest';
import {welcomeFlow} from '@jrc/contracts';
import {SessionProvider,useSession} from '../auth/SessionProvider.js';
import type {ApiClient} from '../api/client.js';
import {AutomationVersionsPage} from './AutomationStudio.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const definition=(organizationId=org)=>({schemaVersion:1,id,organizationId,name:organizationId===org?'Previous organization':'Current organization',lifecycleStatus:'PUBLISHED',draft:{revision:1,graph:welcomeFlow()},activeVersion:1,updatedAt:'2030-01-01T00:00:00Z'});
const version=(organizationId=org)=>({schemaVersion:1,automationId:id,organizationId,version:1,graph:welcomeFlow(),checksum:'a'.repeat(64),publishedAt:'2030-01-01T00:00:00Z'});
function Switch(){const {switchOrganization}=useSession();return <button onClick={()=>void switchOrganization(other)}>Trocar empresa</button>;}
function mount(request:(path:string)=>Promise<unknown>,onSwitch=()=>{}){
 const organization=(id:string)=>({id,name:id,slug:id,role:'VIEWER'}),session=(id:string)=>({user:{id:org,email:'viewer@example.test'},activeOrganization:organization(id),organizations:[organization(org),organization(other)]});
 const client={request,restore:async()=>session(org),switchOrganization:async()=>{onSwitch();return session(other);},registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={['/automations/'+id+'/versions']}><Switch/><Routes><Route path="/automations/:id/versions" element={<AutomationVersionsPage/>}/></Routes></MemoryRouter></SessionProvider>);
}
it('shows an explicit empty publication history and preserves read-only access',async()=>{
 mount(async path=>path.endsWith('/versions')?{data:[]}:definition());
 expect(await screen.findByText('Nenhuma versão publicada.')).toBeVisible();expect(screen.getByRole('link',{name:/Editor/})).toBeVisible();
});
it('rejects a version from another organization instead of displaying its metadata',async()=>{
 mount(async path=>path.endsWith('/versions')?{data:[version(other)]}:definition());
 expect(await screen.findByRole('alert')).toHaveTextContent('O histórico não corresponde à empresa e à automação selecionadas.');
 expect(screen.queryByText('a'.repeat(64))).toBeNull();
});
it('discards old organization history after switching during a pending request',async()=>{
 let active=org,release!:()=>void,started=false;const pending=new Promise<void>(resolve=>{release=resolve;});
 mount(async path=>{const selected=active;if(!path.endsWith('/versions'))return definition(selected);if(selected===org){started=true;await pending;return{data:[version()]};}return{data:[]};},()=>{active=other;});
 await waitFor(()=>expect(started).toBe(true));fireEvent.click(screen.getByRole('button',{name:'Trocar empresa'}));
 await screen.findByRole('heading',{name:'Versões · Current organization'});await act(async()=>release());
 expect(screen.queryByRole('heading',{name:'Versões · Previous organization'})).toBeNull();expect(screen.queryByText('a'.repeat(64))).toBeNull();
 expect(screen.getByText('Nenhuma versão publicada.')).toBeVisible();
});
