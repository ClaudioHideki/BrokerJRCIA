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
async function openFlow(){fireEvent.click(await screen.findByRole('tab',{name:'Flow'}));return screen.getByRole('tabpanel',{name:'Flow'});}
it('provides keyboard-accessible areas and keeps publication, binding and the real test in order',async()=>{
 const request=mount();await screen.findByRole('heading',{name:'Caixa sintética'});
 const tabs=screen.getByRole('tablist',{name:'Áreas da conexão'});
 expect(within(tabs).getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['Visão geral','Configurações WhatsApp','Eventos','Atendimento','Flow','Histórico e grupos']);
 const overview=within(tabs).getByRole('tab',{name:'Visão geral',selected:true});overview.focus();
 fireEvent.keyDown(overview,{key:'ArrowRight'});expect(within(tabs).getByRole('tab',{name:'Configurações WhatsApp',selected:true})).toHaveFocus();
 fireEvent.keyDown(document.activeElement!,{key:'ArrowRight'});fireEvent.keyDown(document.activeElement!,{key:'ArrowRight'});fireEvent.keyDown(document.activeElement!,{key:'ArrowRight'});
 expect(within(tabs).getByRole('tab',{name:'Flow',selected:true})).toHaveFocus();
 await screen.findByRole('option',{name:'Fluxo sintético · v2'});
 const publication=screen.getByRole('heading',{name:'Criar ou publicar o fluxo'}),binding=screen.getByRole('heading',{name:'Vincular bot à caixa'}),test=screen.getByRole('heading',{name:'Testar atendimento'});
 expect(publication.compareDocumentPosition(binding)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(binding.compareDocumentPosition(test)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByText(/Vincular permite novas entradas/i)).toBeVisible();expect(screen.getByRole('link',{name:'Retomar uma conversa em atendimento humano'})).toHaveAttribute('href','/mensagens');
 expect(screen.getByText(/a entrega só é comprovada após observar/)).toBeVisible();
 expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[1]?.method&&call[1].method!=='GET')).toBe(false);
});
it('offers publication in Flow when no published version exists',async()=>{
 mount({items:[{...automation,lifecycleStatus:'DRAFT',activeVersion:null}]});await openFlow();
 expect(await screen.findByText(/Nenhuma versão publicada disponível/)).toBeVisible();
 expect(screen.queryByRole('option',{name:/Fluxo sintético/})).toBeNull();expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();
 expect(screen.getByRole('link',{name:'Criar ou publicar fluxo'})).toHaveAttribute('href',`/automations?channel=${id}`);
});
it('requires a selection and keeps the current owner revision in the binding request',async()=>{
 const request=mount();await openFlow();await screen.findByRole('option',{name:'Fluxo sintético · v2'});
 expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Automação publicada'),{target:{value:automationId}});fireEvent.click(screen.getByRole('button',{name:'Vincular automação'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith(`/v1/channels/${id}/automation`,expect.objectContaining({method:'PUT',body:JSON.stringify({automationId,expectedOwnerRevision:7})})));
 expect(await screen.findByRole('status')).toHaveTextContent('Automação vinculada. Novas mensagens usarão esta versão.');
 expect(screen.getByText(/Vincular permite novas entradas/i)).toHaveTextContent(/Conversas em atendimento humano continuam/);
 expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[0].includes('/resume')||call[0].endsWith('/mode'))).toBe(false);
});
it.each([
 ['DISCONNECTED',undefined,[automation]],
 ['CONNECTED',undefined,[]],
 ['CONNECTED',undefined,[automation]],
 ['CONNECTED','PAUSED',[automation]],
 ['CONNECTED','ACTIVE',[automation]],
] as const)('keeps transport %s and binding %s visible in their areas without claiming delivery',async(transportStatus,bindingStatus,items)=>{
 const request=mount({transportStatus,...(bindingStatus?{bindingStatus}:{}),items:[...items]});
 const overview=await screen.findByRole('tabpanel',{name:'Visão geral'});
 expect(within(overview).getByText(transportStatus==='DISCONNECTED'?'Desconectado':'Conectado',{exact:true})).toBeVisible();
 expect(within(overview).getByRole('button',{name:'Reconectar'})).toBeEnabled();
 if(transportStatus==='DISCONNECTED')expect(within(overview).getByRole('button',{name:'Gerar QR Code'})).toBeEnabled();
 else expect(within(overview).queryByRole('button',{name:'Gerar QR Code'})).toBeNull();
 expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[0]===`/v1/channels/${id}/automation`||call[0]==='/v1/automations')).toBe(false);
 const flow=await openFlow();
 if(bindingStatus){
  expect(await within(flow).findByText(`${bindingStatus==='ACTIVE'?'Ativo':'Pausado'} · versão 2`)).toBeVisible();
  expect(within(flow).getByRole('button',{name:bindingStatus==='ACTIVE'?'Pausar novas entradas':'Retomar novas entradas'})).toBeEnabled();
 }else expect(await within(flow).findByText('Nenhuma automação vinculada.')).toBeVisible();
 if(items.length)await within(flow).findByRole('option',{name:'Fluxo sintético · v2'});
 else expect(await within(flow).findByText(/Nenhuma versão publicada disponível/)).toBeVisible();
 expect(within(flow).getByRole('link',{name:'Criar ou publicar fluxo'})).toHaveAttribute('href',`/automations?channel=${id}`);
 expect(within(flow).getByRole('link',{name:'Abrir conversas para testar e retomar'})).toHaveAttribute('href','/mensagens');
 expect(within(flow).getByText(/a entrega só é comprovada após observar/)).toBeVisible();
 expect(flow).not.toHaveTextContent(/entrega confirmada|bot retomado/);
 expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[1]?.method&&call[1].method!=='GET')).toBe(false);
});
it('withholds binding changes and offers a read-only refresh after failure',async()=>{
 const request=mount({bindingError:true});await openFlow();
 expect(await screen.findByText(/Não foi possível conferir o vínculo atual/)).toBeVisible();
 const refresh=screen.getByRole('button',{name:'Atualizar fluxos e vínculo'});await waitFor(()=>expect(refresh).toBeEnabled());
 expect(screen.getByText('Vínculo ainda não conferido.')).toBeVisible();expect(screen.queryByText('Nenhuma automação vinculada.')).toBeNull();
 const requestCallsBefore=screen.getByRole('button',{name:'Vincular automação'});expect(requestCallsBefore).toBeDisabled();
 fireEvent.click(refresh);
 await waitFor(()=>expect((request as ReturnType<typeof vi.fn>).mock.calls.filter(call=>call[0]===`/v1/channels/${id}/automation`)).toHaveLength(2));
 expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[1]?.method&&call[1].method!=='GET')).toBe(false);
});
it('does not turn a delayed binding into an empty binding or allow binding changes',async()=>{
 mount({delayedBinding:new Promise(()=>{})});await openFlow();await screen.findByRole('option',{name:'Fluxo sintético · v2'});
 expect(screen.getByText('Vínculo ainda não conferido.')).toBeVisible();
 expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();
 expect(screen.queryByText('Nenhuma automação vinculada.')).toBeNull();
 expect(screen.getByText(/Conferindo o vínculo atual antes de permitir alterações/)).toBeVisible();
 expect(screen.getByText(/a entrega só é comprovada após observar/)).toBeVisible();
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
  mount({request});await openFlow();
  expect(await screen.findByRole('button',{name:'Retomar novas entradas'})).toBeEnabled();
  const refresh=screen.getByRole('button',{name:'Atualizar fluxos e vínculo'});await waitFor(()=>expect(refresh).toBeEnabled());fireEvent.click(refresh);
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
 mount({catalogError:true});await openFlow();expect(await screen.findByText(/Não foi possível consultar os fluxos/)).toBeVisible();
 expect(screen.queryByText(/protected payload/)).toBeNull();expect(screen.queryByText(/Nenhuma versão publicada disponível/)).toBeNull();
 expect(screen.getByRole('button',{name:'Vincular automação'})).toBeDisabled();
});
it.each(['OPERATOR','VIEWER'] as const)('explains who can publish and bind for %s without presenting mutation controls',async(role)=>{
 mount({role});await openFlow();
 expect(screen.getByText(/Um administrador da empresa deve publicar e vincular/)).toBeVisible();
 expect(screen.queryByRole('button',{name:'Vincular automação'})).toBeNull();expect(screen.queryByRole('link',{name:'Criar ou publicar fluxo'})).toBeNull();
});
it('preserves the selected box while navigating to an existing or new automation',async()=>{
 mount({entry:`/automations?channel=${id}`});await screen.findByRole('heading',{name:'Automações'});
 expect(screen.getByRole('link',{name:'Voltar à caixa para vincular e testar'})).toHaveAttribute('href',`/channels/${id}`);
 expect(await screen.findByRole('link',{name:'Nova automação'})).toHaveAttribute('href',`/automations/new?channel=${id}`);
 expect(await screen.findByRole('link',{name:'Editar'})).toHaveAttribute('href',`/automations/${automationId}/edit?channel=${id}`);
});
