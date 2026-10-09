// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { NewAutomationPage } from './NewAutomation.js';

const organization = { id: '92776cb0-bcba-45c0-98a3-2937fefdfdaf', name: 'Empresa', slug: 'empresa', role: 'OWNER' as const };
const definition = {
  schemaVersion: 1, id: '11111111-2222-4333-8444-555555555555', organizationId: organization.id,
  name: 'Atendimento', lifecycleStatus: 'DRAFT', draft: { revision: 1, graph: welcomeFlow() },
  activeVersion: null, updatedAt: '2026-09-25T12:00:00.000Z',
};

function client(request: ApiClient['request']): ApiClient {
  return { request, restore: async () => ({ user: { id: organization.id, email: 'owner@example.test' },
    activeOrganization: organization, organizations: [organization] }), registerTenantPurge: () => () => {},
    subscribeToSessionExpiration: () => () => {}, login: vi.fn(), logout: vi.fn(),
    selectOrganization: vi.fn(), switchOrganization: vi.fn() } as unknown as ApiClient;
}

beforeEach(() => sessionStorage.clear());

describe('NewAutomation retry', () => {
  it('keeps the box context after creating a draft without binding it',async()=>{
    const box='22222222-2222-4222-8222-222222222222';
    const request=vi.fn(async(path:string)=>path==='/v1/automations/status'?{enabled:true}:definition) as ApiClient['request'];
    function EditorLocation(){const location=useLocation();return <p>{location.pathname+location.search}</p>;}
    render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={[`/automations/new?channel=${box}`]}><Routes>
      <Route path="/automations/new" element={<NewAutomationPage/>}/><Route path="/automations/:id/edit" element={<EditorLocation/>}/>
    </Routes></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('link',{name:'Voltar à caixa para vincular e testar'})).toHaveAttribute('href',`/channels/${box}`);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Criar e abrir editor'})).toBeDisabled());
    fireEvent.change(screen.getByLabelText('Nome da automação'),{target:{value:'Fluxo sintético'}});
    await waitFor(()=>expect(screen.getByRole('button',{name:'Criar e abrir editor'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Criar e abrir editor'}));
    expect(await screen.findByText(`/automations/${definition.id}/edit?channel=${box}`)).toBeVisible();
    expect((request as ReturnType<typeof vi.fn>).mock.calls.some(call=>call[0].startsWith('/v1/channels/'))).toBe(false);
  });
  it('reuses the draft creation key after an uncertain response', async () => {
    const creationKeys: string[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/automations/status') return { enabled: true };
      if (path === '/v1/automation-imports/preview') return { name: 'Atendimento', graph: welcomeFlow(),
        report: { summary: { total: 1, exact: 1, partial: 0, unsupported: 0, manualReviewRequired: false }, nodes: [], warnings: [] } };
      if (path === '/v1/automation-imports') return { name: 'Atendimento', graph: welcomeFlow(),
        report: { summary: { total: 1, exact: 1, partial: 0, unsupported: 0, manualReviewRequired: false }, nodes: [], warnings: [] } };
      if (path === '/v1/automations') {
        creationKeys.push(String((init?.headers as Record<string, string>)?.['Idempotency-Key']));
        if (creationKeys.length === 1) throw new ApiClientError('Resposta incerta.', 503, 'create-uncertain');
        return definition;
      }
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<SessionProvider client={client(request)}><MemoryRouter initialEntries={['/automations/new']}><Routes>
      <Route path="/automations/new" element={<NewAutomationPage />} />
      <Route path="/automations/:id/edit" element={<div>Editor aberto</div>} />
    </Routes></MemoryRouter></SessionProvider>);
    const fileInput = await screen.findByLabelText('Arquivo JSON');
    await waitFor(() => expect(fileInput).toBeEnabled());
    fireEvent.change(fileInput, { target: { files: [{ name: 'flow.json', size: 50, text: async () => '{"format":"jrc-flows/1"}' }] } });
    expect(await screen.findByRole('heading', { name: 'Revisar importação' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Importar rascunho e abrir editor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('create-uncertain');
    fireEvent.click(screen.getByRole('button', { name: 'Importar rascunho e abrir editor' }));
    expect(await screen.findByText('Editor aberto')).toBeVisible();
    expect(creationKeys).toHaveLength(2);
    expect(creationKeys[0]).toBeTruthy();
    expect(creationKeys[1]).toBe(creationKeys[0]);
  });
});
