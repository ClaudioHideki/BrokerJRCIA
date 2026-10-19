// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { SessionProvider, useSession } from '../auth/SessionProvider.js';
import { NewAutomationPage } from './NewAutomation.js';

const organizationA = { id: '92776cb0-bcba-45c0-98a3-2937fefdfdaf', name: 'ADM-A', slug: 'adm-a', role: 'OWNER' as const };
const organizationB = { ...organizationA, id: '22222222-2222-4222-8222-222222222222', name: 'ADM-B', slug: 'adm-b' };
const preview = { name: 'Synthetic import', graph: welcomeFlow(), report: {
  summary: { total: 1, exact: 1, partial: 0, unsupported: 0, manualReviewRequired: false }, nodes: [], warnings: [],
} };
const definition = { schemaVersion: 1, id: '11111111-2222-4333-8444-555555555555', organizationId: organizationA.id,
  name: preview.name, lifecycleStatus: 'DRAFT', draft: { revision: 1, graph: welcomeFlow() },
  activeVersion: null, updatedAt: '2026-09-25T12:00:00.000Z' };

function Controls() {
  const navigate = useNavigate();
  const { session, switchOrganization } = useSession();
  return <><p>Active tenant: {session?.activeOrganization.name}</p>
    <button onClick={() => navigate('/elsewhere')}>Navigate away</button>
    <button onClick={() => void switchOrganization(organizationB.id)}>Switch tenant</button></>;
}

beforeEach(() => sessionStorage.clear());

describe('NewAutomation interrupted import persistence', () => {
  it.each(['route unmount', 'tenant switch'] as const)('does not create a draft after %s while persistence is pending', async interruption => {
    let resolvePersistence!: (value: typeof preview) => void;
    const persistence = new Promise<typeof preview>(resolve => { resolvePersistence = resolve; });
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/automations/status') return { enabled: true };
      if (path === '/v1/automation-imports/preview') return preview;
      if (path === '/v1/automation-imports') return persistence;
      if (path === '/v1/automations') return definition;
      throw new Error(`Unexpected synthetic request: ${path}`);
    });
    const session = (activeOrganization = organizationA) => ({ user: { id: organizationA.id, email: 'admin@example.test' },
      activeOrganization, organizations: [organizationA, organizationB] });
    const client = { request: request as ApiClient['request'], restore: async () => session(),
      switchOrganization: vi.fn(async () => session(organizationB)), registerTenantPurge: () => () => {},
      subscribeToSessionExpiration: () => () => {}, login: vi.fn(), logout: vi.fn(), selectOrganization: vi.fn() } as unknown as ApiClient;
    render(<SessionProvider client={client}><MemoryRouter initialEntries={['/automations/new']}><Controls/><Routes>
      <Route path="/automations/new" element={<NewAutomationPage/>}/>
      <Route path="/elsewhere" element={<p>Elsewhere</p>}/>
      <Route path="/automations/:id/edit" element={<p>Unexpected editor</p>}/>
    </Routes></MemoryRouter></SessionProvider>);
    const fileInput = await screen.findByLabelText('Arquivo JSON');
    await waitFor(() => expect(fileInput).toBeEnabled());
    fireEvent.change(fileInput, { target: { files: [{ name: 'synthetic.json', size: 24, text: async () => '{"format":"jrc-flows/1"}' }] } });
    expect(await screen.findByRole('heading', { name: /Revisar importa/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Importar rascunho e abrir editor/ }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/v1/automation-imports')).toHaveLength(1));
    expect(request.mock.calls.some(([path]) => path === '/v1/automations')).toBe(false);
    if (interruption === 'route unmount') {
      fireEvent.click(screen.getByRole('button', { name: 'Navigate away' }));
      expect(await screen.findByText('Elsewhere')).toBeVisible();
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Switch tenant' }));
      expect(await screen.findByText('Active tenant: ADM-B')).toBeVisible();
      await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/v1/automations/status')).toHaveLength(2));
    }
    const requestsBeforeResolution = request.mock.calls.length;
    await act(async () => { resolvePersistence(preview); await persistence; });
    expect(request.mock.calls.filter(([path]) => path === '/v1/automations')).toHaveLength(0);
    expect(request.mock.calls.slice(requestsBeforeResolution)).toEqual([]);
    expect(screen.queryByText('Unexpected editor')).not.toBeInTheDocument();
  });
});
