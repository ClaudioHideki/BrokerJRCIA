// @vitest-environment jsdom
import {fireEvent,render,screen} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router';
import {expect,it,vi} from 'vitest';
import {welcomeFlow} from '@jrc/contracts';
import type {ApiClient} from '../api/client.js';
import {NativeVersions} from './workspace.js';
import {createNativeEditorTransport,type NativeEditorOptions} from './transport.js';
const org='11111111-1111-4111-8111-111111111111',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',handle='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const definition={schemaVersion:1,id,organizationId:org,name:'Native Flow',lifecycleStatus:'PUBLISHED',activeVersion:2,updatedAt:'2030-01-01T00:00:00Z',draft:{revision:5,graph:welcomeFlow()}};
const version=(n:number)=>({schemaVersion:1,automationId:id,organizationId:org,version:n,graph:welcomeFlow(),checksum:'a'.repeat(64),publishedAt:'2030-01-01T00:00:00Z'});
function mount(request:NativeEditorOptions['request'],canEdit=true){
 const client=createNativeEditorTransport({accountId:3,handleId:handle,integrationIds:[handle],rootAutomationId:id,request}) as ApiClient;
 render(<MemoryRouter initialEntries={['/automations/'+id+'/versions']}><Routes><Route path="/automations/:id/versions" element={<NativeVersions client={client} organizationId={org} canEdit={canEdit} scopeKey={`3:9:${handle}`}/>}/></Routes></MemoryRouter>);
}
it('pages immutable versions and copies through the existing delegated revision-bound transport',async()=>{
 const request=vi.fn<NativeEditorOptions['request']>(async(method,path)=>{
  if(path.endsWith('/scope'))return {revision:12};
  if(path.includes('/versions'))return path.includes('cursor=')?{data:[version(1)],nextCursor:null}:{data:[version(2)],nextCursor:'older'};
  return method==='put'?{...definition,draft:{...definition.draft,revision:6}}:definition;
 });
 mount(request);fireEvent.click(await screen.findByRole('button',{name:'Carregar versão anterior'}));
 await screen.findAllByRole('option',{name:'v1'});
 fireEvent.change(screen.getByRole('combobox',{name:'Versão a consultar'}),{target:{value:'1'}});
 fireEvent.click(screen.getByRole('button',{name:'Copiar v1 para rascunho'}));fireEvent.click(await screen.findByRole('button',{name:'Confirmar cópia'}));
 await screen.findByText('v1 copiada para o rascunho. Revise no editor antes de publicar.');
 const writes=request.mock.calls.filter(([method])=>method!=='get');expect(writes).toHaveLength(1);
 expect(writes[0]![0]).toBe('put');expect(writes[0]![2]).toMatchObject({revision:5,expectedScopeRevision:12,graph:version(1).graph});
 expect(writes[0]![1]).toBe(`/api/v1/accounts/3/jrc_flow_delegation/sessions/${handle}/flows/${id}`);
});
it('retains history without offering copy when the delegated edit capability is absent',async()=>{
 mount(async(_method,path)=>path.includes('/versions')?{data:[version(2)],nextCursor:null}:definition,false);
 await screen.findByRole('combobox',{name:'Versão a consultar'});expect(screen.queryByRole('button',{name:/Copiar v/})).toBeNull();
});
it('rejects a foreign root in a paginated history',async()=>{
 mount(async(_method,path)=>path.includes('/versions')?{data:[{...version(2),automationId:handle}],nextCursor:null}:definition);
 expect(await screen.findByRole('alert')).toHaveTextContent('histórico não corresponde');
 expect(screen.queryByRole('combobox',{name:'Versão a consultar'})).toBeNull();
});
