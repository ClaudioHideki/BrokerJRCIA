// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { ApiClientError, type ApiClient } from '../api/client.js';

const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-11-09T12:00:00.000Z';
const setup = () => ({ id, organizationId: org, actorId: org, name: 'Atendimento de suporte', revision: 1, state: 'EDITING',
  selection: { transport: 'QR' }, readiness: null, proof: null, pendingAction: null, test: null, createdAt: timestamp, updatedAt: timestamp });
async function implementation() {
  const path = './GuidedSetupPage.js';
  const mod = await import(/* @vite-ignore */ path).catch(() => null); expect(mod, 'guided setup page must exist').not.toBeNull(); return mod!;
}
it('creates a tenant-scoped setup and presents the complete reusable journey', async () => {
  const { GuidedSetupSurface } = await implementation();
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/availability')) return { enabled: true };
    if (path === '/v1/guided-setups' && init?.method === 'POST') return setup();
    if (path === '/v1/guided-setups') return { data: [] };
    if (path === `/v1/guided-setups/${id}`) return setup();
    throw new Error('Unexpected request: ' + path);
  });
  render(<MemoryRouter><GuidedSetupSurface client={{ request } as unknown as ApiClient} organizationId={org} organizationName="Empresa A" /></MemoryRouter>);
  expect(await screen.findByRole('heading', { name: 'Configuração guiada' })).toBeVisible();
  fireEvent.change(await screen.findByLabelText('Nome da configuração'), { target: { value: 'Atendimento de suporte' } });
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar configuração' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/v1/guided-setups', expect.objectContaining({ method: 'POST',
    body: JSON.stringify({ name: 'Atendimento de suporte', transport: 'QR' }) })));
  expect(await screen.findByRole('navigation', { name: 'Etapas da configuração guiada' })).toBeVisible();
  for (const label of ['Empresa e destino', 'WhatsApp', 'Caixa e atendentes', 'Robô e vínculos', 'Conferência e teste'])
    expect(screen.getByRole('button', { name: label })).toBeVisible();
  expect(screen.getByText('Empresa A', { exact: true })).toBeVisible();
});
it('selects Meta by the transport accessible role and sends the selected transport', async () => {
  const { GuidedSetupSurface } = await implementation();
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/availability')) return { enabled: true };
    if (init?.method === 'POST') return { ...setup(), selection: { transport: 'META' } };
    return { data: [] };
  });
  render(<MemoryRouter><GuidedSetupSurface client={{ request } as unknown as ApiClient} organizationId={org} organizationName="Empresa B" /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('Nome da configuração'), { target: { value: 'Atendimento Meta' } });
  // Use the same accessible role as the real-browser journey.
  fireEvent.change(screen.getByRole('combobox', { name: 'Conexão WhatsApp', exact: true }), { target: { value: 'META' } });
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar configuração' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/v1/guided-setups', expect.objectContaining({ method: 'POST',
    body: JSON.stringify({ name: 'Atendimento Meta', transport: 'META' }) })));
});
it('allows correcting the form after a known validation rejection', async () => {
  const { GuidedSetupSurface } = await implementation();
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/availability')) return { enabled: true };
    if (init?.method === 'POST') throw new ApiClientError('Confira os dados.', 400);
    return { data: [] };
  });
  render(<MemoryRouter><GuidedSetupSurface client={{ request } as unknown as ApiClient} organizationId={org} organizationName="Empresa A" /></MemoryRouter>);
  const input = await screen.findByLabelText('Nome da configuração');
  fireEvent.change(input, { target: { value: 'Corrigir cadastro' } }); fireEvent.click(screen.getByRole('button', { name: 'Iniciar configuração' }));
  await screen.findByRole('alert'); expect(input).not.toBeDisabled();
});
it('restores an uncertain operation and reconciles without starting another test or activation', async () => {
  const { GuidedSetupSurface } = await implementation();
  const row = { ...setup(), state: 'UNKNOWN', pendingAction: 'TEST', test: { keyword: 'teste-exclusivo', startedAt: timestamp, automationId: id, version: 1 } };
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('/availability')) return { enabled: true };
    if (path === `/v1/guided-setups/${id}`) return row;
    if (path.endsWith('/reconcile')) return { ...row, state: 'TESTING', pendingAction: null, revision: 2 };
    throw new Error('Unexpected request: ' + path);
  });
  render(<MemoryRouter><GuidedSetupSurface client={{ request } as unknown as ApiClient} organizationId={org} organizationName="Empresa A" setupId={id} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Conferir e retomar' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/v1/guided-setups/${id}/reconcile`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 1 }) })));
  expect(request.mock.calls.some(([path]) => path.endsWith('/test') || path.endsWith('/activate'))).toBe(false);
  expect(await screen.findByText('teste-exclusivo', { exact: true })).toBeVisible();
});
it('discards a response from the previous organization before showing the next company', async () => {
  const { GuidedSetupSurface } = await implementation();
  let resolve: (value: unknown) => void = () => {};
  const pending = new Promise(done => { resolve = done; });
  const client = { request: vi.fn(async (path: string) => path.endsWith('/availability') ? { enabled: true } : pending) } as unknown as ApiClient;
  const view = render(<MemoryRouter><GuidedSetupSurface client={client} organizationId={org} organizationName="Empresa A" setupId={id} /></MemoryRouter>);
  await waitFor(() => expect(client.request).toHaveBeenCalledWith(`/v1/guided-setups/${id}`, expect.anything()));
  view.rerender(<MemoryRouter><GuidedSetupSurface client={{ request: vi.fn(async path => path.endsWith('/availability') ? { enabled: true } : { data: [] }) } as unknown as ApiClient}
    organizationId="33333333-3333-4333-8333-333333333333" organizationName="Empresa B" /></MemoryRouter>);
  await act(async () => { resolve(setup()); });
  expect(screen.getByText('Empresa B', { exact: true })).toBeVisible();
  expect(screen.queryByText('Atendimento de suporte', { exact: true })).not.toBeInTheDocument();
});
