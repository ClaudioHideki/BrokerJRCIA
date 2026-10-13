// @vitest-environment jsdom
import {useState} from 'react';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import type {FlowNode} from '@jrc/contracts';
import type {ApiClient} from '../../api/client.js';
import {getSubflowCatalogPage} from '../api.js';
import {SubflowEditor} from './SubflowEditor.js';
import {FlowCanvas} from '../../flows/FlowCanvas.js';

const org='11111111-1111-4111-8111-111111111111',root='22222222-2222-4222-8222-222222222222',child='33333333-3333-4333-8333-333333333333';
const row=(version=7)=>({automationId:child,name:'Atendimento',version,checksum:'a'.repeat(64),runtimeStateVersion:2});
const page=(data=[row()],nextCursor:string|null=null,organizationId=org)=>({schemaVersion:1,scope:{organizationId,rootAutomationId:root},data,nextCursor});
const node=(data:Record<string,unknown>={}):FlowNode=>({id:'call',type:'subflow',label:'Subfluxo',position:{x:0,y:0},data});
function harness(request:ReturnType<typeof vi.fn>,initial:Record<string,unknown>={},editable=true){
 const changed=vi.fn(),client={request} as unknown as ApiClient;
 function Harness(){const [current,setCurrent]=useState(node(initial));return <SubflowEditor node={current} nodes={[current]} editable={editable} client={client} organizationId={org} rootAutomationId={root} onChange={data=>{changed(data);setCurrent({...current,data});}}/>;}
 return {view:render(<Harness/>),client,changed};
}
describe('published subflow selection with the real scoped DTO',()=>{
 it('selects only an actual catalog version without inventing version one',async()=>{
  const request=vi.fn().mockResolvedValue(page([row(7),row(5)])),{changed}=harness(request);
  const automation=await screen.findByRole('combobox',{name:'Automação publicada do subfluxo'});
  await waitFor(()=>expect(automation).toBeEnabled());fireEvent.change(automation,{target:{value:child}});
  expect(changed.mock.lastCall?.[0]).toEqual({automationId:child});
  fireEvent.change(screen.getByRole('combobox',{name:'Versão publicada do subfluxo'}),{target:{value:'7'}});
  expect(changed.mock.lastCall?.[0]).toEqual({automationId:child,version:7});expect(request.mock.calls[0]![0]).toBe(`/v1/automations/${root}/subflow-catalog?pageSize=200`);
 });
 it('loads the next page without clearing the pinned selection or imposing a 200-total cap',async()=>{
  const request=vi.fn().mockResolvedValueOnce(page([row(7)],'next')).mockResolvedValueOnce(page([row(5)])),{changed}=harness(request,{automationId:child,version:7});
  fireEvent.click(await screen.findByRole('button',{name:'Carregar mais versões'}));
  await screen.findByRole('option',{name:'Versão 5'});expect(screen.getByRole('combobox',{name:'Versão publicada do subfluxo'})).toHaveValue('7');expect(changed).not.toHaveBeenCalled();
  expect(request.mock.calls[1]![0]).toContain('cursor=next');
 });
 it('rejects a tenant or root mismatch at the API consumer and exposes no forged catalog',async()=>{
  const client={request:vi.fn().mockResolvedValue(page([row()],null,'99999999-9999-4999-8999-999999999999'))} as unknown as ApiClient;
  await expect(getSubflowCatalogPage(client,org,root)).rejects.toMatchObject({status:409});
  const request=vi.fn().mockResolvedValue({...page(),scope:{organizationId:org,rootAutomationId:child}});harness(request);
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar');expect(screen.queryByRole('option',{name:'Atendimento'})).not.toBeInTheDocument();
 });
 it('keeps read-only and imported configuration intact without fetching or emitting defaults',()=>{
  const request=vi.fn(),initial={automationId:child,version:'7',timeoutMs:null,input:{'menu.choice':'{{menu.choice}}',payload:{enabled:true}},inputSchema:{type:'object'},outputSchema:{type:'object'}};
  const {changed}=harness(request,initial,false);expect(request).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox',{name:'Automação publicada do subfluxo'})).toBeDisabled();expect(screen.getByText(/compartilham as mesmas variáveis/)).toBeVisible();
 });
 it('does not rewrite a stored version when a catalog reload no longer includes it',async()=>{
  const request=vi.fn().mockResolvedValueOnce(page([row(7)])).mockResolvedValueOnce(page([row(5)])),{changed}=harness(request,{automationId:child,version:7});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Atualizar versões'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Atualizar versões'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('versão selecionada não está');expect(changed).not.toHaveBeenCalled();
 });
 it('ignores a late response from a previous tenant/root/block context',async()=>{
  let finish!:(value:unknown)=>void;const request=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const client={request} as unknown as ApiClient,changed=vi.fn();const props={nodes:[],editable:true,client,organizationId:org,rootAutomationId:root,onChange:changed};
  const view=render(<SubflowEditor {...props} node={node()}/>);
  const nextClient={request:vi.fn().mockResolvedValue(page([]))} as unknown as ApiClient;
  view.rerender(<SubflowEditor {...props} client={nextClient} node={{...node(),id:'different'}}/>);
  await screen.findByText('Nenhuma versão publicada disponível.');await act(async()=>{finish(page());});
  expect(screen.queryByRole('option',{name:'Atendimento'})).not.toBeInTheDocument();expect(changed).not.toHaveBeenCalled();
 });
 it('preserves typed JSON inputs and advanced schemas when changing timeout, without silently fixing invalid input',async()=>{
  const request=vi.fn().mockResolvedValue(page()),initial={automationId:child,version:7,input:{count:0,enabled:false,payload:{value:null}},inputSchema:{type:'object'},outputSchema:{type:'object'}};
  const {changed}=harness(request,initial);await waitFor(()=>expect(screen.getByRole('button',{name:'Atualizar versões'})).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Tempo limite do subfluxo (ms)'),{target:{value:'99'}});
  expect(changed.mock.lastCall?.[0]).toEqual({...initial,timeoutMs:99});expect(screen.getByRole('alert')).toHaveTextContent('100 a 30000');
  fireEvent.change(screen.getByLabelText('Tempo limite do subfluxo (ms)'),{target:{value:'12000'}});expect(changed.mock.lastCall?.[0].input).toEqual(initial.input);
 });
 it('cannot select a valid new reference while loading, empty or failed',async()=>{
  const request=vi.fn().mockRejectedValue(new Error('unavailable'));harness(request);
  expect(screen.getByRole('combobox',{name:'Automação publicada do subfluxo'})).toBeDisabled();
  await screen.findByRole('alert');expect(screen.getByRole('combobox',{name:'Versão publicada do subfluxo'})).toBeDisabled();
 });
 it('adds the canonical exact-variable input mapping without changing existing typed values',async()=>{
  const request=vi.fn().mockResolvedValue(page()),initial={automationId:child,version:7,input:{zero:0,disabled:false,missing:null}};
  const {changed}=harness(request,initial);await waitFor(()=>expect(screen.getByRole('button',{name:'Atualizar versões'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Adicionar entrada da variável'}));
  expect(changed.mock.lastCall?.[0]).toEqual({...initial,input:{...initial.input,entrada:'{{message}}'}});
 });
 it('preserves the internal start policy during normal canvas editing and never renders it as a field',()=>{
  const start={...node({dependencyPolicyVersion:1}),id:'start',type:'start',label:'Início'},changed=vi.fn();
  render(<FlowCanvas graph={{nodes:[start],edges:[]}} editable onChange={changed}/>);
  fireEvent.change(screen.getByLabelText('Nome do bloco'),{target:{value:'Início renomeado'}});
  expect(changed.mock.lastCall?.[0].nodes[0].data).toEqual({dependencyPolicyVersion:1});
  expect(screen.queryByLabelText(/dependencyPolicyVersion/)).not.toBeInTheDocument();
 });
 it('adds an unconfigured subflow without inventing an ID or version and keeps the canonical next port',()=>{
  const start={...node(),id:'start',type:'start',label:'Início'},changed=vi.fn();
  function Canvas(){const [value,setValue]=useState({nodes:[start],edges:[] as Array<{id:string;source:string;target:string;port:string}>});return <FlowCanvas graph={value} editable catalog={[{type:'subflow',label:'Subfluxo publicado',description:'Contrato real'}]} onChange={next=>{changed(next);setValue(next);}}/>;}
  render(<Canvas/>);
  fireEvent.click(screen.getByRole('button',{name:'Subfluxo publicado'}));
  expect(changed.mock.lastCall?.[0].nodes.at(-1).data).toEqual({automationId:'',timeoutMs:10000});
  expect(screen.getByLabelText('Destino Continuar')).toBeVisible();expect(screen.queryByLabelText('ID da automação')).not.toBeInTheDocument();
 });
});
