// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_NODE_CATALOG_V1, welcomeFlow } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { AutomationEditorPage, AutomationsPage } from './AutomationStudio.js';

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
  it('lists only real automations returned by the runtime',async()=>{
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:true}:path==='/v1/automations'?{data:[definition]}:Promise.reject(new Error(`Unexpected ${path}`))) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('heading',{name:'Atendimento principal'})).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'Editar'})).toHaveAttribute('href',`/automations/${automationId}/edit`);
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
