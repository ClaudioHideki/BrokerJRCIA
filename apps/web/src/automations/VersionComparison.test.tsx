// @vitest-environment jsdom
import {act,fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {welcomeFlow,type AutomationDefinitionV1,type AutomationPublishedVersionV1} from '@jrc/contracts';
import {ApiClientError,type ApiClient} from '../api/client.js';
import {VersionComparison} from './VersionComparison.js';
const org='11111111-1111-4111-8111-111111111111',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const item:AutomationDefinitionV1={schemaVersion:1,id,organizationId:org,name:'Flow',lifecycleStatus:'PUBLISHED',activeVersion:1,updatedAt:'2030-01-01T00:00:00Z',draft:{revision:2,graph:welcomeFlow()}};
const version:AutomationPublishedVersionV1={schemaVersion:1,automationId:id,organizationId:org,version:1,graph:welcomeFlow(),checksum:'a'.repeat(64),publishedAt:'2030-01-01T00:00:00Z'};
const client=(request:ApiClient['request'])=>({request} as ApiClient);
it('shows the freshly fetched draft in the comparison before confirming a historical copy',async()=>{
 const current=structuredClone(item);current.draft.revision=6;current.draft.graph.nodes[1]!.data.text='Mudança concorrente a revisar';
 render(<VersionComparison client={client(vi.fn(async()=>current) as ApiClient['request'])} item={item} versions={[version,{...version,version:2}]} canEdit draftKey="draft-test"/>);
 fireEvent.change(screen.getByRole('combobox',{name:'Comparar com'}),{target:{value:'2'}});
 fireEvent.click(screen.getByRole('button',{name:'Copiar v1 para rascunho'}));await screen.findByRole('dialog');
 expect(screen.getByRole('combobox',{name:'Comparar com'})).toHaveValue('draft');
 expect(screen.getByText('Mudança concorrente a revisar')).toBeVisible();
});
it('cancels a copy without writing and prevents duplicate pending PUTs',async()=>{
 let finish!:(value:AutomationDefinitionV1)=>void;const pending=new Promise<AutomationDefinitionV1>(resolve=>{finish=resolve;});
 const request=vi.fn(async(_path:string,options?:RequestInit)=>options?.method==='PUT'?pending:item);
 render(<VersionComparison client={client(request as ApiClient['request'])} item={item} versions={[version]} canEdit draftKey="draft-test"/>);
 fireEvent.click(screen.getByRole('button',{name:/Copiar v/}));fireEvent.click(await screen.findByRole('button',{name:'Cancelar cópia'}));
 expect(request.mock.calls.filter(([,options])=>options?.method==='PUT')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:/Copiar v/}));const confirm=await screen.findByRole('button',{name:'Confirmar cópia'});
 fireEvent.click(confirm);fireEvent.click(confirm);expect(request.mock.calls.filter(([,options])=>options?.method==='PUT')).toHaveLength(1);
 await act(async()=>finish({...item,draft:{...item.draft,revision:3}}));await screen.findByRole('status');
});
it('discards a pending old-scope success without clearing cached drafts',async()=>{
 let finish!:(value:AutomationDefinitionV1)=>void;const pending=new Promise<AutomationDefinitionV1>(resolve=>{finish=resolve;});
 const request=vi.fn(async(_path:string,options?:RequestInit)=>options?.method==='PUT'?pending:item),api=client(request as ApiClient['request']);
 const view=render(<VersionComparison key="old" client={api} item={item} versions={[version]} canEdit draftKey="old-draft"/>);
 sessionStorage.setItem('old-draft','old');sessionStorage.setItem('new-draft','new');
 fireEvent.click(screen.getByRole('button',{name:/Copiar v/}));fireEvent.click(await screen.findByRole('button',{name:'Confirmar cópia'}));
 view.rerender(<VersionComparison key="new" client={api} item={{...item,id:org}} versions={[]} canEdit draftKey="new-draft"/>);
 await act(async()=>finish({...item,draft:{...item.draft,revision:3}}));
 expect(screen.queryByRole('status')).toBeNull();expect(sessionStorage.getItem('old-draft')).toBe('old');expect(sessionStorage.getItem('new-draft')).toBe('new');
});
it('reports the successful PUT even when local cache removal is unavailable',async()=>{
 const request=vi.fn(async(_path:string,options?:RequestInit)=>options?.method==='PUT'?{...item,draft:{...item.draft,revision:3}}:item);
 render(<VersionComparison client={client(request as ApiClient['request'])} item={item} versions={[version]} canEdit draftKey="cache-error"/>);
 fireEvent.click(screen.getByRole('button',{name:/Copiar v/}));await screen.findByRole('button',{name:'Confirmar cópia'});
 const remove=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('Storage unavailable');});
 try{fireEvent.click(screen.getByRole('button',{name:'Confirmar cópia'}));
  expect(await screen.findByRole('status')).toHaveTextContent('v1 copiada para o rascunho.');
  expect(screen.getByRole('alert')).toHaveTextContent('cache local');expect(screen.queryByRole('dialog')).toBeNull();
 }finally{remove.mockRestore();}
});
it.each(['foreign','archived','revoked'])('fails closed for %s draft/authority without changing cache',async mode=>{
 const request=vi.fn(async(_path:string,options?:RequestInit)=>{
  if(mode==='revoked'&&options?.method==='PUT')throw new ApiClientError('Permissão revogada.',403);
  return mode==='foreign'?{...item,organizationId:id}:mode==='archived'?{...item,lifecycleStatus:'ARCHIVED'}:item;
 });
 render(<VersionComparison client={client(request as ApiClient['request'])} item={item} versions={[version]} canEdit draftKey="keep"/>);sessionStorage.setItem('keep','cached');
 fireEvent.click(screen.getByRole('button',{name:/Copiar v/}));
 if(mode==='revoked')fireEvent.click(await screen.findByRole('button',{name:'Confirmar cópia'}));
 await screen.findByRole('alert');expect(screen.queryByRole('status')).toBeNull();expect(sessionStorage.getItem('keep')).toBe('cached');
 if(mode!=='revoked')expect(request.mock.calls.filter(([,options])=>options?.method==='PUT')).toHaveLength(0);
});
