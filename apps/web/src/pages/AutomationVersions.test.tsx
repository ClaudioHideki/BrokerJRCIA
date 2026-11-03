// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router';
import {expect,it,vi} from 'vitest';
import {ApiClientError} from '../api/client.js';
import {welcomeFlow} from '@jrc/contracts';
import {SessionProvider,useSession} from '../auth/SessionProvider.js';
import type {ApiClient} from '../api/client.js';
import {AutomationVersionsPage} from './AutomationStudio.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const definition=(organizationId=org)=>({schemaVersion:1,id,organizationId,name:organizationId===org?'Previous organization':'Current organization',lifecycleStatus:'PUBLISHED',draft:{revision:1,graph:welcomeFlow()},activeVersion:1,updatedAt:'2030-01-01T00:00:00Z'});
const version=(organizationId=org)=>({schemaVersion:1,automationId:id,organizationId,version:1,graph:welcomeFlow(),checksum:'a'.repeat(64),publishedAt:'2030-01-01T00:00:00Z'});
function Switch(){const {switchOrganization}=useSession();return <button onClick={()=>void switchOrganization(other)}>Trocar empresa</button>;}
function mount(request:(path:string,options?:RequestInit)=>Promise<unknown>,onSwitch=()=>{},role='VIEWER'){
 const organization=(id:string)=>({id,name:id,slug:id,role}),session=(id:string)=>({user:{id:org,email:'viewer@example.test'},activeOrganization:organization(id),organizations:[organization(org),organization(other)]});
 const client={request,restore:async()=>session(org),switchOrganization:async()=>{onSwitch();return session(other);},registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={['/automations/'+id+'/versions']}><Switch/><Routes><Route path="/automations/:id/versions" element={<AutomationVersionsPage/>}/></Routes></MemoryRouter></SessionProvider>);
}
it('shows an explicit empty publication history and preserves read-only access',async()=>{
 mount(async path=>path.endsWith('/versions')?{data:[]}:definition());
 expect(await screen.findByText('Nenhuma versão publicada.')).toBeVisible();expect(screen.getByRole('link',{name:/Editor/})).toBeVisible();
});
it('compares historical content with the draft and copies only after explicit confirmation using the latest revision',async()=>{
 const historical=version(),draft=definition();draft.draft.graph.nodes[1]!.data={text:'Texto atualizado'};
 const request=vi.fn(async(path:string,options?:RequestInit)=>{
  if(options?.method==='PUT')return {...draft,draft:{revision:8,graph:historical.graph}};
  if(path.endsWith('/versions'))return {data:[historical]};
  return {...draft,draft:{...draft.draft,revision:7}};
 });
 sessionStorage.setItem(`jrc-automation-draft:${org}:${id}`,'stale');
 mount(request,()=>{},'ADMIN');
 expect(await screen.findByRole('combobox',{name:'Versão a consultar'})).toBeVisible();
 expect(screen.getByText('Texto atualizado')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Copiar v1 para rascunho'}));
 await screen.findByRole('dialog',{name:'Substituir rascunho por v1?'});
 expect(request.mock.calls.filter(([,options])=>options?.method==='PUT')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'Confirmar cópia'}));
 await screen.findByText('v1 copiada para o rascunho. Revise no editor antes de publicar.');
 const writes=request.mock.calls.filter(([,options])=>options?.method==='PUT');
 expect(writes).toHaveLength(1);expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({name:draft.name,graph:historical.graph,revision:7});
 expect(request.mock.calls.some(([path])=>/publish|bind|cancel|replay/.test(path))).toBe(false);
 expect(sessionStorage.getItem(`jrc-automation-draft:${org}:${id}`)).toBeNull();
});
it('keeps the comparison and cached draft on revision conflict and permits an explicit retry',async()=>{
 const request=vi.fn(async(path:string,options?:RequestInit)=>{
  if(options?.method==='PUT')throw new ApiClientError('REVISION_CONFLICT',409);
  return path.endsWith('/versions')?{data:[version()]}:definition();
 });
 sessionStorage.setItem(`jrc-automation-draft:${org}:${id}`,'keep');mount(request,()=>{},'OWNER');
 fireEvent.click(await screen.findByRole('button',{name:'Copiar v1 para rascunho'}));
 fireEvent.click(await screen.findByRole('button',{name:'Confirmar cópia'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('O rascunho mudou');
 expect(screen.getByRole('combobox',{name:'Versão a consultar'})).toHaveValue('1');
 expect(sessionStorage.getItem(`jrc-automation-draft:${org}:${id}`)).toBe('keep');
});
it('does not offer draft copying to a viewer',async()=>{
 mount(async path=>path.endsWith('/versions')?{data:[version()]}:definition());
 await screen.findByRole('combobox',{name:'Versão a consultar'});
 expect(screen.queryByRole('button',{name:/Copiar v/})).toBeNull();
});
it('keeps the oldest publication selectable in the existing unpaginated console response with more than 200 versions',async()=>{
 const versions=Array.from({length:201},(_,index)=>({...version(),version:index+1}));
 versions[0]!.graph.nodes[1]!.data.text='Primeira publicação preservada';
 mount(async path=>path.endsWith('/versions')?{data:versions}:definition());
 const selector=await screen.findByRole('combobox',{name:'Versão a consultar'});expect(selector).toHaveValue('201');
 fireEvent.change(selector,{target:{value:'1'}});expect(screen.getByText('Primeira publicação preservada')).toBeVisible();
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
