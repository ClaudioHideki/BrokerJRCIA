// @vitest-environment jsdom
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {welcomeFlow} from '@jrc/contracts';
import type {ApiClient} from '../api/client.js';
import {App} from '../app/App.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',automationId='33333333-3333-4333-8333-333333333333',timestamp='2030-01-01T12:00:00Z';
const channel={schemaVersion:1,id,organizationId:org,provider:'QR',identity:{displayName:'Caixa sintética',maskedAddress:null},providerReference:{providerAccountId:org,instanceId:id},transportStatus:'CONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:timestamp,updatedAt:timestamp};
const automation={schemaVersion:1,id:automationId,organizationId:org,name:'Fluxo sintético',lifecycleStatus:'PUBLISHED',draft:{revision:1,graph:welcomeFlow()},activeVersion:2,updatedAt:timestamp};
function mount(options:{role?:'OWNER'|'ADMIN'|'OPERATOR'|'VIEWER';items?:unknown[];catalogError?:boolean;entry?:string;transportStatus?:string;bindingStatus?:string;bindingError?:boolean;delayedBinding?:Promise<unknown>;request?:ApiClient['request']}={}){
 let bound=false;
 const activeOrganization={id:org,name:'Empresa sintética',slug:'synthetic',role:options.role??'OWNER'};
 const request=options.request??vi.fn(async(path:string,init?:RequestInit)=>{
  if(path==='/v1/flows/status'||path==='/v1/automations/status')return {enabled:true,canEdit:true,canPublish:true};
  if(path===`/v1/channels/${id}`)return {...channel,transportStatus:options.transportStatus??'CONNECTED'};
  if(path===`/v1/channels/${id}/automation`){if(options.bindingError)throw new Error('protected binding error');if(options.delayedBinding)return options.delayedBinding;if(init?.method==='PUT')bound=true;return {binding:bound||options.bindingStatus?{schemaVersion:1,id:automationId,organizationId:org,automationId,version:2,channelId:id,humanDestinationId:null,status:options.bindingStatus??'ACTIVE',revision:1,createdAt:timestamp,updatedAt:timestamp}:null,ownerRevision:7};}
  if(path==='/v1/automations'||path.startsWith('/v1/automations?')){if(options.catalogError)throw new Error('protected payload');return {data:options.items??[automation]};}
  throw new Error(`Unexpected request ${path} ${init?.method??'GET'}`);
 }) as ApiClient['request'];
 const client={request,restore:vi.fn(async()=>({user:{id:org,email:'operator@example.test'},activeOrganization,organizations:[activeOrganization]})),registerTenantPurge:vi.fn(()=>()=>{}),subscribeToSessionExpiration:vi.fn(()=>()=>{}),login:vi.fn(),logout:vi.fn(),selectOrganization:vi.fn(),switchOrganization:vi.fn()} as unknown as ApiClient;
 render(<App client={client} initialEntries={[options.entry??`/channels/${id}`]}/>);return request;
}
it('provides keyboard-accessible ordered setup links and places the real test after binding',async()=>{
 mount();await screen.findByRole('heading',{name:'Caixa sintética'});
 const steps=screen.getByRole('navigation',{name:'Configurar bot nesta caixa'});
 const links=within(steps).getAllByRole('link');expect(links.map(link=>link.textContent)).toEqual(['1. Conectar WhatsApp','2. Publicar fluxo','3. Vincular bot à caixa','4. Testar atendimento']);
 links[2]!.focus();expect(links[2]).toHaveFocus();expect(links[2]).toHaveAttribute('href','#channel-bot-binding');
 const binding=screen.getByRole('heading',{name:'3. Vincular bot à caixa'}),test=screen.getByRole('heading',{name:'4. Testar atendimento'});
 expect(binding.compareDocumentPosition(test)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByText(/Vincular permite novas entradas/i)).toBeVisible();expect(screen.getByRole('link',{name:'Retomar uma conversa em atendimento humano'})).toHaveAttribute('href','/mensagens');
});
it('offers publication as the next action when no published version exists',async()=>{
 mount({items:[{...automation,lifecycleStatus:'DRAFT',activeVersion:null}]});
 expect(await screen.findByText(/Nenhuma versão publicada disponível/)).toBeVisible();
 expect(screen.queryByRole('option',{name:/Fluxo sintético/})).toBeNull();expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();
 expect(screen.getByRole('link',{name:'Criar ou publicar fluxo'})).toHaveAttribute('href',`/automations?channel=${id}`);
});
it('requires a selection and keeps the current owner revision in the binding request',async()=>{
 const request=mount();await screen.findByRole('option',{name:'Fluxo sintético · v2'});
 expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Automação publicada'),{target:{value:automationId}});fireEvent.click(screen.getByRole('button',{name:'Vincular automação'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith(`/v1/channels/${id}/automation`,expect.objectContaining({method:'PUT',body:JSON.stringify({automationId,expectedOwnerRevision:7})})));
 expect(await screen.findByRole('status')).toHaveTextContent('Automação vinculada. Novas mensagens usarão esta versão.');
 expect(screen.getByText(/Vincular permite novas entradas/i)).toHaveTextContent(/Conversas em atendimento humano continuam/);
 expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[0].includes('/resume')||call[0].endsWith('/mode'))).toBe(false);
});
it.each([
 ['DISCONNECTED',undefined,[automation],'Conectar WhatsApp agora','#channel-connect'],
 ['CONNECTED',undefined,[],'Publicar um fluxo','#channel-flow'],
 ['CONNECTED',undefined,[automation],'Escolher e vincular fluxo','#channel-bot-binding'],
 ['CONNECTED','PAUSED',[automation],'Conferir vínculo do bot','#channel-bot-binding'],
 ['CONNECTED','ACTIVE',[automation],'Testar atendimento agora','#channel-test'],
] as const)('shows one next action for transport %s and binding %s',async(transportStatus,bindingStatus,items,action,target)=>{
 mount({transportStatus,...(bindingStatus?{bindingStatus}:{}),items:[...items]});
 const next=await screen.findByRole('region',{name:'Próximo passo'});
 expect(await within(next).findByRole('link',{name:action})).toHaveAttribute('href',target);
 expect(within(next).getAllByRole('link')).toHaveLength(1);
 expect(next).not.toHaveTextContent(/entrega confirmada|bot retomado/);
});
it('withholds readiness while the binding is pending and offers a read-only refresh after failure',async()=>{
 const request=mount({bindingError:true});
 const next=await screen.findByRole('region',{name:'Próximo passo'});
 expect(await within(next).findByRole('button',{name:'Atualizar configuração'})).toBeEnabled();
 expect(within(next).queryByRole('link',{name:'Testar atendimento agora'})).toBeNull();
 const requestCallsBefore=screen.getByRole('button',{name:'Vincular automação'});expect(requestCallsBefore).toBeDisabled();
 fireEvent.click(within(next).getByRole('button',{name:'Atualizar configuração'}));
 await waitFor(()=>expect((request as ReturnType<typeof vi.fn>).mock.calls.filter(call=>call[0]===`/v1/channels/${id}/automation`)).toHaveLength(2));
 expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[1]?.method&&call[1].method!=='GET')).toBe(false);
});
it('does not turn a delayed binding into an empty binding or offer a test action',async()=>{
 mount({delayedBinding:new Promise(()=>{})});await screen.findByRole('option',{name:'Fluxo sintético · v2'});
 const next=screen.getByRole('region',{name:'Próximo passo'});
 expect(within(next).getByRole('button',{name:'Conferindo configuração'})).toBeDisabled();
 expect(screen.queryByText('Nenhuma automação vinculada.')).toBeNull();
 expect(within(next).queryByRole('link',{name:'Testar atendimento agora'})).toBeNull();
});
it('blocks changes to an earlier binding after refresh fails and restores controls only after a current read',async()=>{
 let bindingReads=0,catalogReads=0,activated=false;
 const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path==='/v1/flows/status')return {enabled:true};
  if(path===`/v1/channels/${id}`)return channel;
  if(path===`/v1/channels/${id}/automation`){
   bindingReads++;if(bindingReads===2)throw new Error('synthetic binding read failure');
   return {binding:{schemaVersion:1,id:automationId,organizationId:org,automationId,version:2,channelId:id,humanDestinationId:null,status:activated?'ACTIVE':'PAUSED',revision:bindingReads===1?1:2,createdAt:timestamp,updatedAt:timestamp},ownerRevision:bindingReads===1?7:8};
  }
  if(path==='/v1/automations'){catalogReads++;if(catalogReads===1)throw new Error('synthetic catalog read failure');return {data:[automation]};}
  if(path===`/v1/automations/${automationId}/bindings/${automationId}`&&init?.method==='PATCH'){activated=true;return {};}
  throw new Error(`Unexpected request ${path}`);
 }) as ApiClient['request'];
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 try{
  mount({request});const next=await screen.findByRole('region',{name:'Próximo passo'});
  expect(await screen.findByRole('button',{name:'Retomar novas entradas'})).toBeEnabled();
  const refresh=await within(next).findByRole('button',{name:'Atualizar configuração'});await waitFor(()=>expect(refresh).toBeEnabled());fireEvent.click(refresh);
  await waitFor(()=>expect(bindingReads).toBe(2));await waitFor(()=>expect(refresh).toBeEnabled());
  const resume=screen.getByRole('button',{name:'Retomar novas entradas'}),unlink=screen.getByRole('button',{name:'Desvincular automação'});
  expect(resume).toBeDisabled();expect(unlink).toBeDisabled();expect(screen.getByText(/Estado anterior não confirmado/)).toHaveTextContent(/versão 2/);
  expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();fireEvent.click(resume);fireEvent.click(unlink);
  expect(confirm).not.toHaveBeenCalled();expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[1]?.method==='PATCH')).toBe(false);
  fireEvent.click(refresh);await waitFor(()=>expect(bindingReads).toBe(3));await waitFor(()=>expect(resume).toBeEnabled());expect(unlink).toBeEnabled();
  expect(screen.queryByText(/Estado anterior não confirmado/)).toBeNull();fireEvent.click(resume);
  await waitFor(()=>expect(request).toHaveBeenCalledWith(`/v1/automations/${automationId}/bindings/${automationId}`,expect.objectContaining({method:'PATCH',body:JSON.stringify({status:'ACTIVE',revision:2,expectedOwnerRevision:8})})));
  expect(await screen.findByRole('button',{name:'Pausar novas entradas'})).toBeEnabled();
 }finally{confirm.mockRestore();}
});
it('makes catalog failure actionable and does not render a secret or a false empty catalog',async()=>{
 mount({catalogError:true});expect(await screen.findByText(/Não foi possível consultar os fluxos/)).toBeVisible();
 expect(screen.queryByText(/protected payload/)).toBeNull();expect(screen.queryByText(/Nenhuma versão publicada disponível/)).toBeNull();
 expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();
});
it.each(['OPERATOR','VIEWER'] as const)('explains who can publish and bind for %s without presenting mutation controls',async(role)=>{
 mount({role});await screen.findByRole('heading',{name:'Caixa sintética'});
 expect(screen.getByText(/Um administrador da empresa deve publicar e vincular/)).toBeVisible();
 expect(screen.queryByRole('button',{name:'Vincular automação'})).toBeNull();expect(screen.queryByRole('link',{name:'Criar ou publicar fluxo'})).toBeNull();
});
it('preserves the selected box while navigating to an existing or new automation',async()=>{
 mount({entry:`/automations?channel=${id}`});await screen.findByRole('heading',{name:'Automações'});
 expect(screen.getByRole('link',{name:'Voltar à caixa para vincular e testar'})).toHaveAttribute('href',`/channels/${id}`);
 expect(await screen.findByRole('link',{name:'Nova automação'})).toHaveAttribute('href',`/automations/new?channel=${id}`);
 expect(await screen.findByRole('link',{name:'Editar'})).toHaveAttribute('href',`/automations/${automationId}/edit?channel=${id}`);
});
