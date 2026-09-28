// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_NODE_CATALOG_V1, welcomeFlow } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { AutomationEditorPage, AutomationsPage, NewAutomationPage, AutomationExecutionDetailPage } from './AutomationStudio.js';

const organization = { id:'92776cb0-bcba-45c0-98a3-2937fefdfdaf', name:'Empresa', slug:'empresa', role:'OWNER' as const };
const automationId = '11111111-2222-4333-8444-555555555555';
const definition = {
  schemaVersion:1 as const,
  id:automationId,
  organizationId:organization.id,
  name:'Atendimento principal',
  lifecycleStatus:'DRAFT' as const,
  draft:{revision:1,graph:welcomeFlow()},
  activeVersion:null,
  updatedAt:'2026-09-21T12:00:00.000Z',
};

function client(request:ApiClient['request']):ApiClient {
  return {request,restore:async()=>({user:{id:organization.id,email:'owner@example.test'},activeOrganization:organization,organizations:[organization]}),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{},login:vi.fn(),logout:vi.fn(),selectOrganization:vi.fn(),switchOrganization:vi.fn()} as unknown as ApiClient;
}

function mountEditor(request:ApiClient['request']) {
  return render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={[`/automations/${automationId}/edit`]}><Routes><Route path="/automations/:id/edit" element={<AutomationEditorPage/>}/></Routes></MemoryRouter></SessionProvider>);
}

beforeEach(()=>sessionStorage.clear());

describe('Automation Studio',()=>{
  it('previews JSON automatically and lets the user cancel before creating an automation',async()=>{
    const request=vi.fn(async(path:string)=>{
      if(path==='/v1/automations/status')return {enabled:true};
      if(path==='/v1/automation-imports/preview')return {name:'Importação',graph:welcomeFlow(),report:{summary:{total:3,exact:3,partial:0,unsupported:0,manualReviewRequired:false},nodes:[],warnings:['Prévia sem gravação.']}};
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><NewAutomationPage/></MemoryRouter></SessionProvider>);
    const input=await screen.findByLabelText('Arquivo JSON');
    await waitFor(()=>expect(input).toBeEnabled());
    fireEvent.change(input,{target:{files:[{name:'chatbot.json',size:50,text:async()=>'{"format":"jrc-flows/1"}'}]}});
    expect(await screen.findByRole('heading',{name:'Revisar importação'})).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/v1/automation-imports/preview',expect.objectContaining({body:expect.stringContaining('"source":"AUTO"')}));
    expect(screen.queryByText(/n8n|typebot/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Cancelar importação'}));
    expect(screen.queryByRole('heading',{name:'Revisar importação'})).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith('/v1/automation-imports',expect.anything());
    expect(request).not.toHaveBeenCalledWith('/v1/automations',expect.anything());
  });
  it('persists a reviewed import only on confirmation and avoids persisting it twice if draft creation is retried',async()=>{
    let createAttempts=0;const paths:string[]=[];
    const imported={name:'Importação',graph:welcomeFlow(),report:{summary:{total:3,exact:3,partial:0,unsupported:0,manualReviewRequired:false},nodes:[],warnings:[]}};
    const request=vi.fn(async(path:string)=>{paths.push(path);
      if(path==='/v1/automations/status')return {enabled:true};
      if(path==='/v1/automation-imports/preview')return imported;
      if(path==='/v1/automation-imports')return imported;
      if(path==='/v1/automations'){createAttempts++;if(createAttempts===1)throw new ApiClientError('Falha temporária.',503,'req-create-503');return {...definition,name:'Importação'};}
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/automations/new']}><Routes><Route path="/automations/new" element={<NewAutomationPage/>}/><Route path="/automations/:id/edit" element={<div>Editor aberto</div>}/></Routes></MemoryRouter></SessionProvider>);
    const input=await screen.findByLabelText('Arquivo JSON');
    await waitFor(()=>expect(input).toBeEnabled());
    fireEvent.change(input,{target:{files:[{name:'chatbot.json',size:50,text:async()=>'{"format":"jrc-flows/1"}'}]}});
    expect(await screen.findByRole('heading',{name:'Revisar importação'})).toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith('/v1/automation-imports',expect.anything());
    fireEvent.click(screen.getByRole('button',{name:'Importar rascunho e abrir editor'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('req-create-503');
    expect(request).toHaveBeenCalledWith('/v1/automation-imports',expect.objectContaining({body:expect.stringContaining('"source":"AUTO"')}));
    fireEvent.click(screen.getByRole('button',{name:'Importar rascunho e abrir editor'}));
    expect(await screen.findByText('Editor aberto')).toBeVisible();
    expect(paths.filter(path=>path==='/v1/automation-imports')).toHaveLength(1);
    expect(paths.filter(path=>path==='/v1/automations')).toHaveLength(2);
  });
  it('explains disabled automation runtime and prevents an import from being sent',async()=>{
    const request=vi.fn(async(path:string)=>{
      if(path==='/v1/automations/status')return {enabled:false};
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><NewAutomationPage/></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Automações temporariamente desativadas');
    const input=screen.getByLabelText('Arquivo JSON');
    expect(input).toBeDisabled();
    fireEvent.change(input,{target:{files:[{name:'chatbot.json',size:50,text:async()=>'{"format":"jrc-flows/1"}'}]}});
    expect(request).not.toHaveBeenCalledWith('/v1/automation-imports',expect.anything());
    expect(screen.getByRole('button',{name:'Criar e abrir editor'})).toBeDisabled();
  });
  it('archives with confirmation and offers restore without deleting the definition',async()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
    let archived=false;
    const request=vi.fn(async(path:string)=>{
      if(path.endsWith('/archive')){archived=true;return {...definition,lifecycleStatus:'ARCHIVED'};}
      if(path==='/v1/automations/status')return {enabled:true};
      if(path==='/v1/automations')return {data:[{...definition,lifecycleStatus:archived?'ARCHIVED':'DRAFT'}]};
      if(path.endsWith('/legacy'))return {data:[],metrics:{legacyFlows:0}};
      throw new Error(path);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Arquivar'}));
    await waitFor(()=>expect(request).toHaveBeenCalledWith(`/v1/automations/${automationId}/archive`,expect.objectContaining({method:'POST',body:'{"archived":true}'})));
    fireEvent.click(screen.getByLabelText('Mostrar arquivadas'));
    expect(await screen.findByRole('button',{name:'Restaurar'})).toBeVisible();confirm.mockRestore();
  });
  it('cancels unsaved edits and clears the local recovery copy',async()=>{
    const request=vi.fn(async(path:string)=>path===`/v1/automations/${automationId}`?definition:{data:AUTOMATION_NODE_CATALOG_V1}) as ApiClient['request'];
    mountEditor(request);const name=await screen.findByLabelText('Nome da automação');fireEvent.change(name,{target:{value:'Erro de edição'}});
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'Cancelar alterações'}));
    expect(name).toHaveValue(definition.name);expect(sessionStorage.getItem(`jrc-automation-draft:${organization.id}:${automationId}`)).toBeNull();confirm.mockRestore();
  });
  it('lists only real automations returned by the runtime',async()=>{
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:true}:path==='/v1/automations'?{data:[definition]}:Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('heading',{name:'Atendimento principal'})).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'Editar'})).toHaveAttribute('href',`/automations/${automationId}/edit`);
  });

  it('loads later automation pages without duplicating a definition seen in an earlier page',async()=>{
    const second={...definition,id:'44444444-4444-4444-8444-444444444444',name:'Atendimento filial'};
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:true}
      :path==='/v1/automations'?{data:[definition],nextCursor:'next-1'}
      :path==='/v1/automations?cursor=next-1'?{data:[definition,second],nextCursor:null}
      :Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Carregar mais automações'}));
    await waitFor(()=>expect(request).toHaveBeenCalledWith('/v1/automations?cursor=next-1'));
    expect(await screen.findByRole('heading',{name:'Atendimento filial'})).toBeVisible();
    expect(screen.getAllByRole('heading',{name:'Atendimento principal'})).toHaveLength(1);
    expect(screen.queryByRole('button',{name:'Carregar mais automações'})).not.toBeInTheDocument();
  });

  it('keeps a local draft and exposes the request id when saving returns 5xx',async()=>{
    const request=vi.fn(async(path:string,init?:RequestInit)=>{
      if(path===`/v1/automations/${automationId}`&&init?.method==='PUT')throw new ApiClientError('Falha temporária.',503,'req-save-503');
      if(path===`/v1/automations/${automationId}`)return definition;
      if(path==='/v1/automation-nodes')return {data:AUTOMATION_NODE_CATALOG_V1};
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    mountEditor(request);
    const name=await screen.findByLabelText('Nome da automação');
    fireEvent.change(name,{target:{value:'Atendimento alterado'}});
    fireEvent.click(screen.getByRole('button',{name:'Salvar'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('req-save-503');
    await waitFor(()=>expect(sessionStorage.getItem(`jrc-automation-draft:${organization.id}:${automationId}`)).toContain('Atendimento alterado'));
    expect(name).toHaveValue('Atendimento alterado');
  });

  it('moves a selected block with the keyboard for accessible canvas editing',async()=>{
    const request=vi.fn(async(path:string)=>path===`/v1/automations/${automationId}`?definition:path==='/v1/automation-nodes'?{data:AUTOMATION_NODE_CATALOG_V1}:Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    mountEditor(request);
    const block=await screen.findByRole('button',{name:'Configurar Mensagem recebida'});
    fireEvent.keyDown(block,{key:'ArrowRight'});
    expect(screen.getByText(/alterações locais preservadas/)).toBeInTheDocument();
  });
});

it('cancels a queued execution only after confirmation and refreshes its status',async()=>{
 let canceled=false;const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 const request=vi.fn(async(path:string,init?:RequestInit)=>{if(path.endsWith('/cancel')){canceled=true;return {ok:true};}return {id:automationId,automationId,channelId:automationId,version:1,status:canceled?'CANCELED':'QUEUED',correlationId:'qa',nodes:[],outbox:[]};}) as ApiClient['request'];
 render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/execution/'+automationId]}><Routes><Route path="/execution/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Cancelar execução'}));
 expect(await screen.findByText('Cancelada')).toBeVisible();
 expect(request).toHaveBeenCalledWith('/v1/executions/'+automationId+'/cancel',expect.objectContaining({method:'POST'}));confirm.mockRestore();
});

it('directs a handed-off conversation to its mode control instead of resuming a terminal execution',async()=>{
 const request=vi.fn(async()=>({id:automationId,automationId,channelId:automationId,version:1,status:'HANDOFF',correlationId:'qa',nodes:[],outbox:[]})) as ApiClient['request'];
 render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/execution/'+automationId]}><Routes><Route path="/execution/:id" element={<AutomationExecutionDetailPage/>}/></Routes></MemoryRouter></SessionProvider>);
 expect(await screen.findByRole('link',{name:'Retomar bot em Conversas'})).toHaveAttribute('href','/mensagens');expect(screen.queryByRole('button',{name:'Retomar automação'})).not.toBeInTheDocument();
});
