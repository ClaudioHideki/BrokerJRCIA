// @vitest-environment jsdom
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AttendanceCatalog, FlowNode } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../../api/client.js';
import { HandoffEditor } from './HandoffEditor.js';

const organizationId='11111111-1111-4111-8111-111111111111', integrationId='22222222-2222-4222-8222-222222222222';
const otherOrganization='33333333-3333-4333-8333-333333333333';
const node:FlowNode={id:'handoff',label:'Atendimento',type:'handoff',position:{x:0,y:0},data:{handoffVersion:1}};
const status={configured:true,baseUrl:'https://chatwoot.example.test',provisioningAvailable:false,account:{accountId:4,status:'READY',hasCredential:true,lastError:null},connections:[{id:integrationId,channelId:integrationId,inboxId:8,name:'Atendimento principal',status:'READY',lastError:null,webhookUrl:'https://broker.example.test/events'}],jobs:{}};
const catalog:AttendanceCatalog={scope:{organizationId,channelId:integrationId,integrationId,destinationRevision:2,accountId:4,inboxId:8},observedAt:'2026-10-01T18:00:00.000Z',credentialRevision:3,
 teams:[{id:7,name:'Comercial',autoAssignment:false},{id:8,name:'Suporte',autoAssignment:false},{id:9,name:'Financeiro',autoAssignment:false}],agents:[{id:11,name:'Agente da caixa',inboxMember:true},{id:12,name:'Fora da caixa',inboxMember:false}],labels:[],attributes:[],hours:{enabled:false,timezone:'Etc/UTC',days:[]},remoteBot:null,inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},capabilities:{teams:'SUPPORTED',agents:'SUPPORTED',inboxMembership:'SUPPORTED',labels:'SUPPORTED',attributes:'SUPPORTED',hours:'SUPPORTED',agentBot:'SUPPORTED',signatures:'UNVERIFIED',controlEvents:'UNVERIFIED',initialPending:'UNVERIFIED'}};
const config={handoffVersion:1,destination:{integrationId,destinationRevision:2,accountId:4,inboxId:8,credentialRevision:3},target:{teamId:7,agentId:null}};
function api(request: (path:string,init?:RequestInit)=>Promise<unknown>){return {request:vi.fn(request)} as unknown as ApiClient;}
function Harness({client,initial=node,tenant=organizationId,change=vi.fn()}:{client:ApiClient;initial?:FlowNode;tenant?:string;change?:(data:FlowNode['data'])=>void}){
 const [current,setCurrent]=useState(initial);return <HandoffEditor client={client} organizationId={tenant} node={current} editable onChange={data=>{change(data);setCurrent({...current,data});}}/>;
}

describe('native handoff destination editor',()=>{
 it('builds revision-pinned targets using only catalog selectors and clears the other target',async()=>{
  const client=api(async path=>path==='/v1/integrations/chatwoot'?status:catalog),change=vi.fn();render(<Harness client={client} change={change}/>);
  fireEvent.change(await screen.findByLabelText('Caixa de atendimento'),{target:{value:integrationId}});
  const teamSelect=await screen.findByLabelText('Time de atendimento');expect(screen.queryByText(/destino mudou/i)).toBeNull();
  fireEvent.change(teamSelect,{target:{value:'7'}});
  expect(change).toHaveBeenLastCalledWith(config);
  expect(screen.getByLabelText('Time de atendimento').querySelectorAll('option')).toHaveLength(4);
  expect(screen.queryByRole('option',{name:'Fora da caixa'})).toBeNull();
  fireEvent.change(screen.getByLabelText('Agente de atendimento'),{target:{value:'11'}});
  expect(change).toHaveBeenLastCalledWith({...config,target:{teamId:null,agentId:11}});
  expect(screen.getByLabelText('Time de atendimento')).toHaveValue('');
  expect(client.request).toHaveBeenCalledWith(`/v1/integrations/chatwoot/connections/${integrationId}/attendance-catalog`,expect.objectContaining({signal:expect.any(AbortSignal)}));
  expect(screen.queryByRole('textbox')).toBeNull();
 });
 it('keeps a legacy graph intact until the operator selects a destination',async()=>{
  const change=vi.fn(),client=api(async()=>status);render(<Harness client={client} initial={{...node,data:{}}} change={change}/>);
  expect(screen.getByText(/legado.*selecione/i)).toBeVisible();await screen.findByRole('option',{name:'Atendimento principal'});expect(change).not.toHaveBeenCalled();
 });
 it('shows stale revisions without silently repinning the saved target',async()=>{
  const change=vi.fn(),client=api(async path=>path==='/v1/integrations/chatwoot'?status:{...catalog,credentialRevision:4});
  render(<Harness client={client} initial={{...node,data:config}} change={change}/>);
  expect(await screen.findByText(/destino mudou.*selecione novamente/i)).toBeVisible();expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Time de atendimento'),{target:{value:'8'}});
  expect(change).toHaveBeenLastCalledWith({...config,destination:{...config.destination,credentialRevision:4},target:{teamId:8,agentId:null}});
 });
 it('does not offer an agent whose inbox membership cannot be verified',async()=>{
  const client=api(async path=>path==='/v1/integrations/chatwoot'?status:{...catalog,capabilities:{...catalog.capabilities,inboxMembership:'UNSUPPORTED'}});
  render(<Harness client={client} initial={{...node,data:config}}/>);
  expect(await screen.findByLabelText('Agente de atendimento')).toBeDisabled();expect(screen.queryByRole('option',{name:'Agente da caixa'})).toBeNull();
 });
 it('preserves the draft and explains deleted targets and denied reads',async()=>{
  const change=vi.fn(),client=api(async path=>path==='/v1/integrations/chatwoot'?status:{...catalog,teams:[]});
  const mounted=render(<Harness client={client} initial={{...node,data:config}} change={change}/>);
  expect(await screen.findByText(/O time configurado está indisponível/i)).toBeVisible();expect(change).not.toHaveBeenCalled();mounted.unmount();
  render(<Harness client={api(async()=>{throw new ApiClientError('Sem permissão para consultar destinos.',403);})} change={change}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Sem permissão');expect(change).not.toHaveBeenCalled();
 });
 it('drops old-tenant in-flight results and never offers a catalog from another scope',async()=>{
  let finishOld!:(value:unknown)=>void,finishNew!:(value:unknown)=>void;
  const oldPending=new Promise(resolve=>{finishOld=resolve;}),newPending=new Promise(resolve=>{finishNew=resolve;});let calls=0;
  const client=api(async path=>path==='/v1/integrations/chatwoot'?status:++calls===1?oldPending:newPending);
  const mounted=render(<Harness client={client} initial={{...node,data:config}}/>);
  await waitFor(()=>expect(calls).toBe(1));mounted.rerender(<Harness client={client} initial={{...node,data:config}} tenant={otherOrganization}/>);
  expect(screen.queryByLabelText('Time de atendimento')).toBeNull();
  await waitFor(()=>expect(calls).toBe(2));await act(async()=>finishOld(catalog));expect(screen.queryByRole('option',{name:'Comercial'})).toBeNull();
  await act(async()=>finishNew({...catalog,scope:{...catalog.scope,organizationId:otherOrganization},teams:[{id:7,name:'Time da nova empresa',autoAssignment:false}]}));
  expect(await screen.findByRole('option',{name:'Time da nova empresa'})).toBeVisible();expect(screen.queryByRole('option',{name:'Comercial'})).toBeNull();
  mounted.unmount();render(<Harness client={api(async path=>path==='/v1/integrations/chatwoot'?status:catalog)} initial={{...node,data:config}} tenant={otherOrganization}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent(/catálogo.*empresa|escopo/i);expect(screen.queryByLabelText('Time de atendimento')).toBeNull();
 });
 it('refreshes the catalog without repinning a stale revision or allowing old options during loading',async()=>{
  let calls=0,finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
  const change=vi.fn(),client=api(async path=>path==='/v1/integrations/chatwoot'?status:++calls===1?catalog:pending);
  render(<Harness client={client} initial={{...node,data:config}} change={change}/>);
  await screen.findByRole('option',{name:'Comercial'});fireEvent.click(screen.getByRole('button',{name:'Atualizar destinos'}));
  expect(screen.queryByLabelText('Time de atendimento')).toBeNull();await waitFor(()=>expect(calls).toBe(2));
  await act(async()=>finish({...catalog,scope:{...catalog.scope,destinationRevision:3},teams:[{id:7,name:'Comercial revisado',autoAssignment:false}]}));
  expect(await screen.findByText(/destino mudou.*selecione novamente/i)).toBeVisible();expect(screen.getByLabelText('Time de atendimento')).toHaveValue('');expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Time de atendimento'),{target:{value:'7'}});
  expect(change).toHaveBeenLastCalledWith({...config,destination:{...config.destination,destinationRevision:3}});
 });
 it('clears the chosen target immediately when changing boxes and ignores the old catalog response',async()=>{
  const second='44444444-4444-4444-8444-444444444444';let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
  const change=vi.fn(),client=api(async path=>path==='/v1/integrations/chatwoot'?{...status,connections:[...status.connections,{...status.connections[0],id:second,name:'Outra caixa'}]}:path.includes(integrationId)?pending:{...catalog,scope:{...catalog.scope,integrationId:second,inboxId:9},teams:[{id:20,name:'Time da outra caixa',autoAssignment:false}]});
  render(<Harness client={client} initial={{...node,data:config}} change={change}/>);
  await screen.findByRole('option',{name:'Outra caixa'});await waitFor(()=>expect(client.request).toHaveBeenCalledWith(expect.stringContaining(integrationId),expect.anything()));
  fireEvent.change(screen.getByLabelText('Caixa de atendimento'),{target:{value:second}});expect(change).toHaveBeenLastCalledWith({handoffVersion:1,destination:{integrationId:second}});
  await screen.findByRole('option',{name:'Time da outra caixa'});await act(async()=>finish(catalog));expect(screen.queryByRole('option',{name:'Comercial'})).toBeNull();
  fireEvent.change(screen.getByLabelText('Time de atendimento'),{target:{value:'20'}});
  expect(change).toHaveBeenLastCalledWith({...config,destination:{...config.destination,integrationId:second,inboxId:9},target:{teamId:20,agentId:null}});
 });
 it('follows restored graph configuration instead of keeping a local uncommitted selection',async()=>{
  const client=api(async path=>path==='/v1/integrations/chatwoot'?status:catalog),change=vi.fn();
  const mounted=render(<HandoffEditor client={client} organizationId={organizationId} node={node} editable onChange={change}/>);
  fireEvent.change(await screen.findByLabelText('Caixa de atendimento'),{target:{value:integrationId}});
  const draft=change.mock.calls.at(-1)![0];mounted.rerender(<HandoffEditor client={client} organizationId={organizationId} node={{...node,data:draft}} editable onChange={change}/>);
  await screen.findByLabelText('Time de atendimento');
  mounted.rerender(<HandoffEditor client={client} organizationId={organizationId} node={{...node,data:{}}} editable onChange={change}/>);
  expect(screen.getByLabelText('Caixa de atendimento')).toHaveValue('');expect(screen.queryByLabelText('Time de atendimento')).toBeNull();
 });
 it.each([true,null])('explains active or unverified greeting, inbox assignment and selected-team assignment (%s)',async policy=>{
  const unsafe={...catalog,inboxPolicy:{greetingEnabled:policy,autoAssignmentEnabled:policy},teams:catalog.teams.map(team=>({...team,autoAssignment:policy}))};
  const change=vi.fn(),client=api(async path=>path==='/v1/integrations/chatwoot'?status:unsafe);
  render(<Harness client={client} initial={{...node,data:config}} change={change}/>);
  await screen.findByLabelText('Time de atendimento');expect(screen.getByText('A publicação e a transferência ficam bloqueadas até revisar a central:')).toBeVisible();
  expect(screen.getByText(/saudação automática da caixa/)).toBeVisible();
  expect(screen.getByText(/atribuição automática da caixa/)).toBeVisible();
  expect(screen.getByText(/atribuição automática do time Comercial/)).toBeVisible();
  if(policy===null)expect(screen.getAllByText(/estado não foi confirmado/i)).toHaveLength(3);
  expect(screen.getByLabelText('Time de atendimento')).toHaveValue('7');expect(change).not.toHaveBeenCalled();
 });
 it.each(['UNSUPPORTED','UNVERIFIED'] as const)('never treats an unobserved Agent Bot as absent (%s)',async capability=>{
  const client=api(async path=>path==='/v1/integrations/chatwoot'?status:{...catalog,capabilities:{...catalog.capabilities,agentBot:capability}});
  render(<Harness client={client} initial={{...node,data:config}}/>);
  await screen.findByLabelText('Time de atendimento');expect(screen.getByText(/Não foi possível confirmar a ausência de outro Agent Bot/)).toBeVisible();
 });
 it('explains a competing Agent Bot while preserving the saved destination',async()=>{
  const change=vi.fn(),client=api(async path=>path==='/v1/integrations/chatwoot'?status:{...catalog,remoteBot:{id:30,name:'Robô anterior'}});
  render(<Harness client={client} initial={{...node,data:config}} change={change}/>);
  await screen.findByLabelText('Time de atendimento');expect(screen.getByText(/Remova o Agent Bot Robô anterior da caixa/)).toBeVisible();expect(change).not.toHaveBeenCalled();
 });
 it('requires selected-team policy only for a team target and keeps missing catalog policy untrusted',async()=>{
  const unsafe={...catalog,teams:catalog.teams.map(team=>({...team,autoAssignment:null}))};
  const client=api(async path=>path==='/v1/integrations/chatwoot'?status:unsafe);
  const mounted=render(<Harness client={client} initial={{...node,data:{...config,target:{teamId:null,agentId:11}}}}/>);
  await screen.findByLabelText('Agente de atendimento');expect(screen.queryByText(/atribuição automática do time/)).toBeNull();mounted.unmount();
  const {inboxPolicy:ignored,...legacyCatalog}=catalog;const change=vi.fn();
  render(<Harness client={api(async path=>path==='/v1/integrations/chatwoot'?status:legacyCatalog)} initial={{...node,data:config}} change={change}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Catálogo de atendimento inválido');expect(screen.queryByLabelText('Time de atendimento')).toBeNull();expect(change).not.toHaveBeenCalled();
 });
 it('does not fetch or change protected destinations without editing permission',()=>{
  const client=api(async()=>status),change=vi.fn();render(<HandoffEditor client={client} organizationId={organizationId} node={{...node,data:config}} editable={false} onChange={change}/>);
  expect(client.request).not.toHaveBeenCalled();expect(change).not.toHaveBeenCalled();expect(screen.getByText(/permissão/i)).toBeVisible();
 });
});
