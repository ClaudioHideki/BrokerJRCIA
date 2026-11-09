// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {MemoryRouter,Route,Routes} from 'react-router';
import type {ChannelV1} from '@jrc/contracts';
import {ApiClientError,type ApiClient} from '../api/client.js';
import {SessionProvider} from '../auth/SessionProvider.js';
import {ProtectedRoute} from '../auth/guards.js';
import {ChannelDetailPage} from './ChannelDetail.js';
import {ChannelsPage} from './Channels.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',instance='33333333-3333-4333-8333-333333333333',user='44444444-4444-4444-8444-444444444444',at='2026-11-01T12:00:00.000Z';
function fixture(){return {schemaVersion:1,id,organizationId:org,provider:'QR',providerReference:{providerAccountId:user,instanceId:instance},
 identity:{displayName:'Caixa sintética',maskedAddress:null},transportStatus:'DISCONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:at,updatedAt:at} as ChannelV1;}
function mount(request:ReturnType<typeof vi.fn>,list=false,role:'OWNER'|'VIEWER'='OWNER'){
 const organization={id:org,name:'Empresa sintética',slug:'synthetic',role};
 const client={request,restore:async()=>({user:{id:user,email:'synthetic@example.test'},activeOrganization:organization,organizations:[organization]}),
  registerTenantPurge:()=>()=>undefined,subscribeToSessionExpiration:()=>()=>undefined} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={[list?'/channels':`/channels/${id}`]}><Routes>
  <Route path="/channels" element={<ProtectedRoute><ChannelsPage/></ProtectedRoute>}/><Route path="/channels/:id" element={<ProtectedRoute><ChannelDetailPage/></ProtectedRoute>}/>
 </Routes></MemoryRouter></SessionProvider>);
}
const workspace=()=>({observedAt:at,providerAvailable:false,instance:{id:instance,name:'Sintética',status:'DISCONNECTED',createdAt:at,updatedAt:at},
 profile:{name:null,phone:null,state:null},counts:{contacts:null,chats:null,messages:null},settings:null,operations:[]});
describe('connection recovery and diagnostic journey',()=>{
 it('retries an unavailable list using the current bounded API instead of leaving a dead end',async()=>{
  let attempts=0;const request=vi.fn(async(path:string)=>{if(path==='/v1/guided-setups/availability')return {enabled:false};if(!attempts++)throw new ApiClientError('Indisponível',503,'synthetic-request');return {data:[fixture()]};});
  mount(request,true);await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Tentar carregar caixas novamente'}));
  expect(await screen.findByRole('heading',{name:'Caixa sintética'})).toBeVisible();expect(request.mock.calls.filter(([path])=>path==='/v1/channels?pageSize=50')).toHaveLength(2);
  expect(request).toHaveBeenLastCalledWith('/v1/channels?pageSize=50');
 });
 it('ends the detail loading state on failure and permits an explicit safe read retry',async()=>{
  let attempts=0;const request=vi.fn(async(path:string,_options?:RequestInit)=>{if(path===`/v1/channels/${id}`){if(!attempts++)throw new ApiClientError('Offline',503,'synthetic-reference');return fixture();}return workspace();});
  mount(request);expect(await screen.findByRole('alert',{name:'Erro da caixa'})).toHaveTextContent('synthetic-reference');
  expect(screen.queryByText('Carregando caixa…')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Tentar carregar caixa novamente'}));
  expect(await screen.findByRole('heading',{name:'Caixa sintética'})).toBeVisible();expect(attempts).toBe(2);
 });
 it('distinguishes denied detail access and does not expose mutations',async()=>{
  const request=vi.fn().mockRejectedValue(new ApiClientError('Forbidden',403));mount(request);
  expect(await screen.findByRole('heading',{name:'Sem acesso a esta caixa'})).toBeVisible();
  expect(screen.queryByRole('button',{name:'Reconectar'})).not.toBeInTheDocument();expect(screen.queryByText('Carregando caixa…')).not.toBeInTheDocument();
 });
 it('keeps a pending no-challenge operation visible and blocks duplicate pairing requests',async()=>{
  const channel=fixture();const request=vi.fn(async(path:string)=>{
   if(path.endsWith('/pair')){channel.transportStatus='PAIRING';return {provider:'QR',channel,action:{type:'NONE',reason:'CONNECTION_PENDING'},operationId:user,replayed:false,pending:true,reconciliationRequired:false};}
   if(path.includes('/workspace'))return workspace();return channel;
  });mount(request);fireEvent.click(await screen.findByRole('button',{name:'Gerar QR Code'}));
  expect(await screen.findByRole('status',{name:'Pareamento pendente'})).toBeVisible();
  expect(screen.getByRole('button',{name:'Gerar QR Code'})).toBeDisabled();expect(screen.getByRole('button',{name:'Reconectar'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Atualizar status'})).toBeEnabled();
  expect(request.mock.calls.filter(([path])=>path.endsWith('/pair'))).toHaveLength(1);
 });
 it('opens company-wide delivery diagnostics lazily from a connection without adding channel filters or writes',async()=>{
  const request=vi.fn(async(path:string,_options?:RequestInit)=>{if(path===`/v1/channels/${id}`)return fixture();if(path.includes('/workspace'))return workspace();
   if(path==='/v1/integrations/chatwoot/jobs/summary')return {data:[{status:'UNKNOWN',code:'CHATWOOT_OUTCOME_UNKNOWN',total:2,firstSeenAt:at,lastSeenAt:at}]};throw Error('Unexpected synthetic request');});
  mount(request,false,'VIEWER');fireEvent.click(await screen.findByRole('tab',{name:'Diagnóstico de entregas'}));
  expect(screen.getByText(/Os totais abaixo abrangem toda a empresa/)).toBeVisible();
  expect(request.mock.calls.some(([path])=>path.endsWith('/jobs/summary'))).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));expect(await screen.findByText('Resultado incerto')).toBeVisible();
  expect(request).toHaveBeenCalledWith('/v1/integrations/chatwoot/jobs/summary');
  expect(request.mock.calls.some(([,options])=>options?.method&&options.method!=='GET')).toBe(false);
  expect(screen.queryByRole('button',{name:/Reprocessar|Reenviar/})).not.toBeInTheDocument();
 });
});


it('keeps an uncertain reconnect blocked until a connected status is confirmed, without blind replay',async()=>{
 const channel=fixture();let connected=false;
 const request=vi.fn(async(path:string)=>{
  if(path.endsWith('/reconnect')){channel.transportStatus='UNKNOWN';return {provider:'QR',channel,action:{type:'NONE',reason:'CONNECTION_PENDING'},operationId:user,replayed:false,pending:true,reconciliationRequired:true};}
  if(path.endsWith('/status')&&connected)return {...channel,transportStatus:'CONNECTED'};
  if(path.includes('/workspace'))return workspace();return channel;
 });mount(request);fireEvent.click(await screen.findByRole('button',{name:'Reconectar'}));
 expect(await screen.findByText('Resultado do pareamento incerto')).toBeVisible();
 expect(screen.getByText(/Abra o histórico e use Atualizar painel/)).toBeVisible();
 expect(screen.getByRole('button',{name:'Reconectar'})).toBeDisabled();expect(screen.getByRole('button',{name:'Gerar QR Code'})).toBeDisabled();
 connected=true;fireEvent.click(screen.getByRole('button',{name:'Atualizar status'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Reconectar'})).toBeEnabled());
 expect(screen.queryByText('Resultado do pareamento incerto')).not.toBeInTheDocument();
 expect(request.mock.calls.filter(([path])=>path.endsWith('/reconnect'))).toHaveLength(1);
});

it.each([
 ['DISCONNECTED','poll'],['DEGRADED','poll'],['DISCONNECTED','manual'],['DEGRADED','manual'],
] as const)('keeps the pending reconciliation fence after physical status %s via %s',async(status,mode)=>{
 const channel=fixture();let statusCalls=0,releaseStatus!:(value:ChannelV1)=>void;
 const physicalStatus=new Promise<ChannelV1>(resolve=>{releaseStatus=resolve;});
 const request=vi.fn(async(path:string)=>{
  if(path.endsWith('/pair')){channel.transportStatus='PAIRING';return {provider:'QR',channel,action:{type:'NONE',reason:'CONNECTION_PENDING'},operationId:user,replayed:false,pending:true,reconciliationRequired:false};}
  if(path.endsWith('/status')){statusCalls++;return statusCalls===1?physicalStatus:{...channel,transportStatus:status};}
  if(path.includes('/workspace'))return workspace();return channel;
 });mount(request);fireEvent.click(await screen.findByRole('button',{name:'Gerar QR Code'}));
 await screen.findByRole('status',{name:'Pareamento pendente'});await waitFor(()=>expect(statusCalls).toBe(1));
 await act(async()=>releaseStatus({...channel,transportStatus:mode==='poll'?status:'PAIRING'}));
 if(mode==='manual'){
  fireEvent.click(screen.getByRole('button',{name:'Atualizar status'}));
  await screen.findByText(status==='DISCONNECTED'?'Desconectado':'Com falha',{exact:true});
 }
 await waitFor(()=>expect(screen.getByRole('button',{name:'Atualizar status'})).toBeEnabled());
 expect(screen.getByRole('button',{name:'Gerar QR Code'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Reconectar'})).toBeDisabled();
 expect(screen.getByRole('status',{name:'Pareamento pendente'})).toBeVisible();
 expect(request.mock.calls.filter(([path])=>path.endsWith('/pair'))).toHaveLength(1);
});
it('keeps the pending reconciliation fence after CONNECT_RECONCILIATION_REQUIRED instead of inviting another request',async()=>{
 const channel=fixture();const request=vi.fn(async(path:string)=>{
  if(path.endsWith('/reconnect'))throw new ApiClientError('Reconciliation required',409,undefined,'CONNECT_RECONCILIATION_REQUIRED');
  if(path.includes('/workspace'))return workspace();return channel;
 });mount(request);fireEvent.click(await screen.findByRole('button',{name:'Reconectar'}));
 await screen.findByRole('alert',{name:'Erro da caixa'});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Atualizar status'})).toBeEnabled());
 expect(screen.getByRole('button',{name:'Gerar QR Code'})).toBeDisabled();expect(screen.getByRole('button',{name:'Reconectar'})).toBeDisabled();
 expect(screen.getByText('Resultado do pareamento incerto')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Gerar QR Code'}));fireEvent.click(screen.getByRole('button',{name:'Reconectar'}));
 expect(request.mock.calls.filter(([path])=>path.endsWith('/reconnect'))).toHaveLength(1);
 expect(request.mock.calls.some(([path])=>path.endsWith('/pair'))).toBe(false);
});
