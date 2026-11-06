// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {ApiClient} from '../api/client.js';
import {App} from '../app/App.js';
import {ChatwootPanel} from '../integrations/ChatwootPanel.js';
const org='11111111-1111-4111-8111-111111111111',other='55555555-5555-4555-8555-555555555555',id='22222222-2222-4222-8222-222222222222',id2='33333333-3333-4333-8333-333333333333',user='44444444-4444-4444-8444-444444444444',at='2026-11-04T12:00:00.000Z';
const channel=(key=id,name='Suporte')=>({schemaVersion:1,id:key,organizationId:org,provider:'QR',providerReference:{providerAccountId:user,instanceId:key},identity:{displayName:name,maskedAddress:null},transportStatus:'CONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:at,updatedAt:at});
const instance=(key=id,name='Suporte',status='CONNECTED')=>({id:key,organizationId:org,providerAccountId:user,name,provider:'BAILEYS',status,createdAt:at,updatedAt:at});
function mount(request:ReturnType<typeof vi.fn>,entry='/channels',switching=false){
 const organizations=[{id:org,name:'Empresa A',slug:'a',role:'VIEWER' as const},{id:other,name:'Empresa B',slug:'b',role:'VIEWER' as const}];
 let active=organizations[0]!;const purges=new Set<()=>void>();
 const session=()=>({user:{id:user,email:'synthetic@example.test'},activeOrganization:active,organizations:switching?organizations:[active]});
 const client={request,restore:async()=>session(),switchOrganization:async({organizationId}:{organizationId:string})=>{for(const purge of purges)purge();active=organizations.find(item=>item.id===organizationId)!;return session();},
  registerTenantPurge:(handler:()=>void)=>{purges.add(handler);return()=>purges.delete(handler);},subscribeToSessionExpiration:()=>()=>undefined} as unknown as ApiClient;
 render(<App client={client} initialEntries={[entry]}/>);
}
it('searches all channel pages by name without case or accents and restores the normal page on clear',async()=>{
 const request=vi.fn(async(path:string,_options?:RequestInit)=>path.includes('cursor=next')?{data:[channel(id2,'Comércio São José')],nextCursor:null}:{data:[channel()],nextCursor:'next'});
 mount(request);await screen.findByRole('heading',{name:'Suporte'});
 fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa por nome'}),{target:{value:'COMERCIO sao'}});
 expect(await screen.findByRole('heading',{name:'Comércio São José'})).toBeVisible();expect(screen.queryByRole('heading',{name:'Suporte'})).not.toBeInTheDocument();
 expect(screen.getByRole('status',{name:'Resultados da busca'})).toHaveTextContent('1 de 2');
 const reads=request.mock.calls.length;
 fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa por nome'}),{target:{value:'inexistente'}});
 expect(screen.getByText('Nenhuma caixa corresponde ao nome informado.')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Limpar busca de caixas'}));expect(screen.getByRole('searchbox',{name:'Buscar caixa por nome'})).toHaveValue('');
 expect(screen.getByRole('heading',{name:'Suporte'})).toBeVisible();expect(screen.getByRole('button',{name:'Carregar mais caixas'})).toBeVisible();
 fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa por nome'}),{target:{value:'sao'}});
 expect(await screen.findByRole('heading',{name:'Comércio São José'})).toBeVisible();expect(request).toHaveBeenCalledTimes(reads);
 expect(request.mock.calls.every(([,options])=>!options||!('method' in options)||options.method==='GET')).toBe(true);
});
it('never reports an empty global search when later pages failed and retries explicitly',async()=>{
 let fail=true;const request=vi.fn(async(path:string)=>{if(path.includes('cursor=next')){if(fail)throw Error('private failure');return {data:[channel(id2,'São José')],nextCursor:null};}return {data:[channel()],nextCursor:'next'};});
 mount(request);await screen.findByRole('heading',{name:'Suporte'});fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa por nome'}),{target:{value:'sao'}});
 expect(await screen.findByRole('alert',{name:'Erro da busca'})).toHaveTextContent('Não foi possível concluir');
 expect(screen.queryByText('Nenhuma caixa corresponde ao nome informado.')).not.toBeInTheDocument();
 fail=false;fireEvent.click(screen.getByRole('button',{name:'Tentar busca novamente'}));expect(await screen.findByRole('heading',{name:'São José'})).toBeVisible();
});
it('keeps the legacy status filter while searching later pages and clearing only the name',async()=>{
 const request=vi.fn(async(path:string)=>path.includes('cursor=next')?{data:[instance(id2,'Comércio São José','DISCONNECTED')],pageInfo:{hasNextPage:false,nextCursor:null}}:{data:[instance()],pageInfo:{hasNextPage:true,nextCursor:'next'}});
 mount(request,'/legacy/conexoes');await screen.findByRole('link',{name:'Suporte, ver detalhes'});
 fireEvent.change(screen.getByLabelText('Buscar conexão'),{target:{value:'comercio sao'}});
 expect(await screen.findByRole('link',{name:'Comércio São José, ver detalhes'})).toBeVisible();
 fireEvent.change(screen.getByLabelText('Filtrar por status'),{target:{value:'CONNECTED'}});expect(screen.getByText('Nenhuma conexão corresponde aos filtros.')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Limpar busca de conexões'}));expect(screen.getByLabelText('Filtrar por status')).toHaveValue('CONNECTED');expect(screen.getByRole('link',{name:'Suporte, ver detalhes'})).toBeVisible();
});
it('clears a tenant search and ignores its late page when switching company',async()=>{
 let release!:(value:unknown)=>void,initialCalls=0,searchSignal:AbortSignal|undefined;const late=new Promise(resolve=>{release=resolve;});
 const request=vi.fn(async(path:string,options?:RequestInit)=>{if(path.includes('cursor=next')){searchSignal=options?.signal??undefined;return late;}initialCalls++;return initialCalls<=2?{data:[channel()],nextCursor:'next'}:{data:[{...channel(id2,'Empresa B'),organizationId:other}],nextCursor:null};});
 mount(request,'/channels',true);await screen.findByRole('heading',{name:'Suporte'});
 fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa por nome'}),{target:{value:'sao'}});
 await waitFor(()=>expect(request.mock.calls.some(([path])=>path.includes('cursor=next'))).toBe(true));
 fireEvent.change(screen.getByLabelText('Organização ativa'),{target:{value:other}});expect(await screen.findByRole('heading',{name:'Empresa B'})).toBeVisible();
 expect(screen.getByRole('searchbox',{name:'Buscar caixa por nome'})).toHaveValue('');
 expect(searchSignal?.aborted).toBe(true);
 await act(async()=>release({data:[channel(id2,'DADO ANTIGO')],nextCursor:null}));expect(screen.queryByText('DADO ANTIGO')).not.toBeInTheDocument();
});
it('filters the complete integration card list without changing existing selected inbox or source controls',async()=>{
 const status={configured:true,baseUrl:'https://synthetic.test',provisioningAvailable:false,account:null,jobs:{},connections:[
 {id,channelId:id,name:'Comércio São José',inboxId:1,status:'READY',webhookUrl:'https://synthetic.test/events',lastError:null},
 {id:id2,channelId:id2,name:'Suporte',inboxId:2,status:'DISABLED',webhookUrl:'https://synthetic.test/events2',lastError:null}]};
 const request=vi.fn(async(path:string)=>path===''?status:{data:[]});render(<ChatwootPanel request={request} canManage={false} platform={false}/>);
 await screen.findByText('Comércio São José');fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa vinculada por nome'}),{target:{value:'COMERCIO sao'}});
 expect(screen.getByText('Comércio São José')).toBeVisible();expect(screen.getByText('Suporte')).not.toBeVisible();
 expect(screen.getByRole('status',{name:'Caixas vinculadas encontradas'})).toHaveTextContent('1 de 2');
 fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa vinculada por nome'}),{target:{value:'ausente'}});expect(screen.getByText('Nenhuma caixa vinculada corresponde ao nome informado.')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Limpar busca de caixas vinculadas'}));expect(screen.getByText('Suporte')).toBeVisible();
 expect(request.mock.calls.every(call=>call.length===1)).toBe(true);
});

it('preserves selected source and destination while filtering integration cards',async()=>{
 const status={configured:true,baseUrl:'https://synthetic.test',provisioningAvailable:false,account:{accountId:1,status:'READY',hasCredential:true,lastError:null},jobs:{},connections:[
 {id,channelId:id,name:'Comércio São José',inboxId:1,status:'READY',webhookUrl:'https://synthetic.test/events',lastError:null},
 {id:id2,channelId:id2,name:'Suporte',inboxId:2,status:'DISABLED',webhookUrl:'https://synthetic.test/events2',lastError:null}]};
 const request=vi.fn(async(path:string)=>path===''?status:path==='/sources'?{data:[{id,kind:'instance',name:'Nova conexão',label:'QR'}]}:path==='/inboxes'?{data:[{id:9,name:'Destino escolhido',hasWebhook:false}]}:path.endsWith('/agents')?{data:[{id:9,name:'Atendente sintético',email:'agent@example.test',assigned:false}]}:{data:[]});
 render(<ChatwootPanel request={request} canManage platform={false}/>);
 await screen.findByRole('option',{name:'Nova conexão · QR'});await screen.findByRole('option',{name:'Destino escolhido · Caixa 9'});
 fireEvent.change(screen.getByLabelText('Conexão WhatsApp'),{target:{value:id}});fireEvent.change(screen.getByLabelText('Destino'),{target:{value:'9'}});
 const card=screen.getByText('Comércio São José').closest('article')!;
 fireEvent.click(within(card).getByText('Atendentes desta caixa'));fireEvent.click(within(card).getByRole('button',{name:'Consultar atendentes'}));
 fireEvent.click(await within(card).findByRole('checkbox',{name:/Atendente sintético/}));
 fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa vinculada por nome'}),{target:{value:'suporte'}});
 expect(screen.getByLabelText('Conexão WhatsApp')).toHaveValue(id);expect(screen.getByLabelText('Destino')).toHaveValue('9');
 fireEvent.click(screen.getByRole('button',{name:'Limpar busca de caixas vinculadas'}));
 expect(screen.getByLabelText('Conexão WhatsApp')).toHaveValue(id);expect(screen.getByLabelText('Destino')).toHaveValue('9');
 expect(screen.getByRole('checkbox',{name:/Atendente sintético/})).toBeChecked();
 expect(request.mock.calls.every(call=>call.length===1)).toBe(true);
});

it('invalidates the completed name snapshot when the archived filter changes and preserves that filter on clear',async()=>{
 const request=vi.fn(async(path:string)=>({data:[path.includes('includeArchived=true')?{...channel(id2,'Árvore arquivada'),archivedAt:at}:channel(id,'Árvore atual')],nextCursor:null}));
 mount(request);await screen.findByRole('heading',{name:'Árvore atual'});
 fireEvent.change(screen.getByRole('searchbox',{name:'Buscar caixa por nome'}),{target:{value:'arvore'}});
 await screen.findByRole('status',{name:'Resultados da busca'});fireEvent.click(screen.getByRole('checkbox',{name:'Mostrar arquivadas'}));
 expect(await screen.findByRole('heading',{name:'Árvore arquivada'})).toBeVisible();expect(screen.queryByRole('heading',{name:'Árvore atual'})).not.toBeInTheDocument();
 expect(request.mock.calls.some(([path])=>path==='/v1/channels?includeArchived=true&pageSize=100')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Limpar busca de caixas'}));expect(screen.getByRole('checkbox',{name:'Mostrar arquivadas'})).toBeChecked();
});
