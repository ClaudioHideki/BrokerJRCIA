// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { FlowsPage } from './Flows.js';
const organization={id:'92776cb0-bcba-45c0-98a3-2937fefdfdaf',name:'Empresa',slug:'empresa',role:'OWNER'};
function mount(enabled=true,role='OWNER'){
 let saved={id:'11111111-2222-4333-8444-555555555555',name:'Meu chatbot',graph:welcomeFlow(),revision:1,publishedVersion:null as number|null,updatedAt:new Date().toISOString()};
 const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path==='/v1/flows/status')return {enabled};
  if(path==='/v1/flows/library')return {data:[{id:'welcome',name:'Boas-vindas',description:'Teste',graph:welcomeFlow()}]};
  if(path==='/v1/flows/channels')return {data:[]};
  if(path==='/v1/flows/chatwoot/inboxes')return {accountId:2,data:[{id:7,name:'Suporte por e-mail',channelType:'Channel::Email',binding:null}]};
  if(path.endsWith('/chatwoot/bind'))return {id:saved.id,status:'READY'};
  if(path==='/v1/flows'&&init?.method==='POST'){saved={...saved,...JSON.parse(String(init.body))};return saved;}
  if(path==='/v1/flows')return {data:[]};
  if(init?.method==='PUT'){saved={...saved,...JSON.parse(String(init.body)),revision:saved.revision+1};return saved;}
  if(path.endsWith('/publish'))return {...saved,publishedVersion:1};
  if(path.endsWith('/runs'))return {data:[]};
  throw new Error('Unexpected '+path);
 });
 const activeOrganization={...organization,role};
 const client={request,restore:async()=>({user:{id:organization.id,email:'owner@example.test'},activeOrganization,organizations:[activeOrganization]}),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{},login:vi.fn(),logout:vi.fn(),selectOrganization:vi.fn(),switchOrganization:vi.fn()} as unknown as ApiClient;
 render(<SessionProvider client={client}><FlowsPage/></SessionProvider>);
 return request;
}
describe('Native Flows workspace',()=>{
 it('lets the administrator publish and choose a remote inbox without a WhatsApp channel',async()=>{
  const request=mount();
  fireEvent.click(await screen.findByRole('button',{name:'Novo flow'}));
  fireEvent.click(screen.getByRole('button',{name:'Criar flow'}));
  fireEvent.click(await screen.findByRole('button',{name:'Publicar versão'}));
  await screen.findByText(/Versão publicada. Vincule/);
  fireEvent.click(screen.getByRole('button',{name:'Conexões'}));
  fireEvent.click(await screen.findByRole('button',{name:'Caixas do Chatwoot / JRC'}));
  await screen.findByRole('option',{name:/Suporte por e-mail/});
  fireEvent.click(screen.getByRole('button',{name:'Ativar chatbot nesta caixa'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith('/v1/flows/'+savedId()+'/chatwoot/bind',expect.objectContaining({method:'POST',body:JSON.stringify({inboxId:7})})));
 });
 it('shows no editor when the company has not been granted access',async()=>{
  const request=mount(false);
  expect(await screen.findByText('JRC Flows não está habilitado para esta empresa.')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Novo flow'})).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalledWith('/v1/flows',expect.anything());
 });
 it('creates a flow, edits a node and saves its graph before publication',async()=>{
  const request=mount();
  fireEvent.click(await screen.findByRole('button',{name:'Novo flow'}));
  fireEvent.change(screen.getByLabelText('Nome do novo flow'),{target:{value:'Meu chatbot'}});
  fireEvent.click(screen.getByRole('button',{name:'Criar flow'}));
  fireEvent.click(await screen.findByRole('button',{name:'Configurar Boas-vindas'}));
  fireEvent.change(screen.getByLabelText('Mensagem'),{target:{value:'Olá da empresa'}});
  expect(screen.getByRole('button',{name:'Publicar versão'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Salvar'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith(expect.stringContaining(savedId()),expect.objectContaining({method:'PUT',body:expect.stringContaining('Olá da empresa')})));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Publicar versão'})).not.toBeDisabled());
 });
 it('adds and configures a menu block with one output for each option',async()=>{
  const request=mount();
  fireEvent.click(await screen.findByRole('button',{name:'Novo flow'}));
  fireEvent.click(screen.getByRole('button',{name:'Criar flow'}));
  fireEvent.click(await screen.findByRole('button',{name:'Menu de opções'}));
  expect(screen.getByLabelText('Mensagem do menu')).toHaveValue('Escolha uma opção:');
  fireEvent.change(screen.getByLabelText('Opções, uma por linha'),{target:{value:'1|Financeiro\n2|Suporte\n3|Comercial'}});
  expect(screen.getByLabelText('Destino Opção 1')).toBeInTheDocument();
  expect(screen.getByLabelText('Destino Opção 2')).toBeInTheDocument();
  expect(screen.getByLabelText('Destino Opção 3')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Salvar'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith(expect.stringContaining(savedId()),expect.objectContaining({method:'PUT',body:expect.stringContaining('Financeiro')})));
 });
 it('keeps creation controls unavailable for a reader',async()=>{
  mount(true,'VIEWER');
  await screen.findByText('Seus flows');
  expect(screen.queryByRole('button',{name:'Novo flow'})).not.toBeInTheDocument();
 });
});
function savedId(){return '11111111-2222-4333-8444-555555555555';}
