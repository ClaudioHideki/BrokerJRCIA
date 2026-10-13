// @vitest-environment jsdom
import {useState} from 'react';
import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import type {FlowNode} from '@jrc/contracts';
import type {ApiClient} from '../../api/client.js';
import {HttpQueryEditor} from './HttpQueryEditor.js';
import {HttpSimulationControl} from '../HttpSimulationControl.js';
const org='11111111-1111-4111-8111-111111111111',root='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const row={id,name:'ERP da empresa',type:'BEARER',revision:3,allowedOrigins:['https://api.example.test']};
const page=(data=[row],nextCursor:string|null=null)=>({schemaVersion:1,scope:{organizationId:org,rootAutomationId:root},data,nextCursor});
const config={httpConfigVersion:1,method:'GET',url:'https://api.example.test/lookup',queryParameters:{},credentialId:'',target:'result',timeoutMs:5000,maxResponseBytes:32768,retryAttempts:0};
const node=(data:Record<string,unknown>):FlowNode=>({id:'query',type:'http',label:'Consulta',position:{x:0,y:0},data});
function harness(request:ReturnType<typeof vi.fn>,initial:Record<string,unknown>=config,editable=true){const changed=vi.fn(),client={request} as unknown as ApiClient;
 function Harness(){const [data,setData]=useState(initial);return <HttpQueryEditor node={node(data)} editable={editable} client={client} organizationId={org} rootAutomationId={root} onChange={next=>{changed(next);setData(next);}}/>;}return{...render(<Harness/>),changed};}
describe('HTTP query configuration and simulation controls',()=>{
 it('selects credentials by name and pins revision without token, UUID input or invented defaults',async()=>{
  const request=vi.fn().mockResolvedValue(page()),{changed}=harness(request);expect(screen.getByRole('combobox',{name:'Credencial da consulta'})).toBeDisabled();
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'Credencial da consulta'})).toBeEnabled());fireEvent.change(screen.getByRole('combobox',{name:'Credencial da consulta'}),{target:{value:id}});
  expect(changed.mock.lastCall?.[0]).toEqual({...config,credentialId:id,credentialRevision:3});expect(screen.queryByLabelText(/UUID|token|ID da credencial/i)).not.toBeInTheDocument();expect(screen.getByText(/https:\/\/api.example.test/)).toBeVisible();
  expect(request.mock.calls[0]![0]).toBe(`/v1/automations/${root}/http-credentials?pageSize=200`);
 });
 it('pages and reloads metadata without truncation or rewriting stale selected revisions',async()=>{
  const request=vi.fn().mockResolvedValueOnce(page([row],'next')).mockResolvedValueOnce(page([{...row,id:root,name:'Outro ERP'}])).mockResolvedValueOnce(page([{...row,revision:4}]));
  const {changed}=harness(request,{...config,credentialId:id,credentialRevision:3});fireEvent.click(await screen.findByRole('button',{name:'Carregar mais credenciais'}));await screen.findByRole('option',{name:/Outro ERP/});
  fireEvent.click(screen.getByRole('button',{name:'Atualizar credenciais'}));expect(await screen.findByRole('alert')).toHaveTextContent('desatualizada');expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox',{name:'Credencial da consulta'}),{target:{value:id}});expect(changed.mock.lastCall?.[0].credentialRevision).toBe(4);
 });
 it('rejects a catalog from another organization',async()=>{
  harness(vi.fn().mockResolvedValue({...page(),scope:{organizationId:root,rootAutomationId:root}}));expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar');
 });
 it('explains how to configure a credential whose allowed origins are missing',async()=>{
  harness(vi.fn().mockResolvedValue(page([{...row,allowedOrigins:[]} ])),{...config,credentialId:id,credentialRevision:3});expect(await screen.findByRole('alert')).toHaveTextContent('em Credenciais e atualize este catálogo');
 });
 it('ignores a late response after organization/root context changes',async()=>{
  let finish!:(data:unknown)=>void;const request=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),changed=vi.fn(),client={request} as unknown as ApiClient;
  const view=render(<HttpQueryEditor node={node(config)} editable={true} client={client} organizationId={org} rootAutomationId={root} onChange={changed}/>);
  view.rerender(<HttpQueryEditor node={node(config)} editable={false} client={client} organizationId={root} rootAutomationId={id} onChange={changed}/>);
  await act(async()=>{finish(page());});expect(screen.queryByRole('option',{name:/ERP da empresa/})).not.toBeInTheDocument();expect(changed).not.toHaveBeenCalled();
 });
 it('preserves historical mutations and read-only configuration until explicit conversion',()=>{
  const request=vi.fn(),{changed}=harness(request,{method:'POST',url:'https://api.example.test/legacy',body:{value:1}},false);expect(request).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();expect(screen.getByText(/configuração histórica/)).toBeVisible();expect(screen.getByRole('button',{name:'Configurar consulta HTTPS'})).toBeDisabled();
 });
 it('edits query values separately from the static URL and explains a disallowed destination',async()=>{
  const {changed}=harness(vi.fn().mockResolvedValue(page()),{...config,credentialId:id,credentialRevision:3});await waitFor(()=>expect(screen.getByRole('button',{name:'Adicionar parâmetro de consulta'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Adicionar parâmetro de consulta'}));fireEvent.change(screen.getByLabelText('Valor do parâmetro 1'),{target:{value:'{{message}}'}});expect(changed.mock.lastCall?.[0].queryParameters).toEqual({parametro1:'{{message}}'});
  fireEvent.change(screen.getByLabelText('Endereço HTTPS da consulta'),{target:{value:'https://other.test/lookup'}});expect(screen.getByRole('alert')).toHaveTextContent('destino não está permitido');
 });
 it('emits an explicit bounded synthetic result for the exact node without requesting a service',()=>{
  const respond=vi.fn();render(<HttpSimulationControl nodeId="query" disabled={false} onResponse={respond}/>);
  fireEvent.change(screen.getByLabelText('Corpo da resposta fictícia'),{target:{value:'{"ok":true}'}});fireEvent.click(screen.getByRole('button',{name:'Usar resposta fictícia no teste'}));
  expect(respond).toHaveBeenCalledWith({type:'HTTP_RESPONSE',nodeId:'query',outcome:'success',status:200,body:'{"ok":true}'});expect(screen.getByText(/Nenhuma requisição/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Corpo da resposta fictícia'),{target:{value:'é'.repeat(16385)}});expect(screen.getByRole('button',{name:'Usar resposta fictícia no teste'})).toBeDisabled();
 });
 it('does not require status/body for synthetic timeout or unknown outcomes',()=>{
  const respond=vi.fn();render(<HttpSimulationControl nodeId="query" disabled={false} onResponse={respond}/>);fireEvent.change(screen.getByLabelText('Resultado fictício'),{target:{value:'timeout'}});fireEvent.click(screen.getByRole('button',{name:'Usar resposta fictícia no teste'}));expect(respond).toHaveBeenCalledWith({type:'HTTP_RESPONSE',nodeId:'query',outcome:'timeout'});
 });
});
