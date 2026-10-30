// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ApiClient, BrowserSession } from '../api/client.js';
import { App } from '../app/App.js';

const org = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const other = '11581139-9d73-4f64-aeba-35c997c5ce34';
const account = '6fd7933a-80b7-4491-b081-a0fa8c2414d2';
const base = { schemaVersion: 1, organizationId: org, transportStatus: 'CONNECTED', providerStatus: 'READY',
  automationStatus: 'UNBOUND', humanStatus: 'UNBOUND', revision: 1, createdAt: '2030-01-01T12:00:00.000Z', updatedAt: '2030-01-01T12:00:00.000Z' };
const qr = { ...base, id, provider: 'QR', identity: { displayName: 'Caixa QR', maskedAddress: null }, providerReference: { providerAccountId: account, instanceId: id } };
const meta = { ...base, id: other, provider: 'META', identity: { displayName: 'Caixa Meta', maskedAddress: null }, providerReference: { providerAccountId: account, connectionId: other } };
const central = { ...base, id: account, provider: 'CENTRAL', identity: { displayName: 'Caixa da central', maskedAddress: null },
  providerReference: { integrationId: other, accountId: 1, inboxId: 9 } };
function client(request: ApiClient['request'], role: BrowserSession['activeOrganization']['role'] = 'OWNER'): ApiClient {
  const organization = { id: org, name: 'JRC', slug: 'jrc', role };
  return { request, restore: vi.fn(async () => ({ user: { id: account, email: 'operator@example.test' }, activeOrganization: organization, organizations: [organization] })),
    login: vi.fn(), selectOrganization: vi.fn(), switchOrganization: vi.fn(), logout: vi.fn(),
    registerTenantPurge: vi.fn(() => () => undefined), subscribeToSessionExpiration: vi.fn(() => () => undefined) } as unknown as ApiClient;
}

it.each(['OWNER', 'ADMIN'] as const)('offers deletion in QR and Meta cards to %s without a second route or CENTRAL deletion', async role => {
  const request = vi.fn(async (path: string) => path === '/v1/flows/status' ? { enabled: true } : { data: [qr, meta, central] }) as ApiClient['request'];
  render(<App client={client(request, role)} initialEntries={['/channels']} />);
  const qrCard = (await screen.findByRole('heading', { name: 'Caixa QR' })).closest('article')!;
  expect(within(qrCard).getByRole('button', { name: 'Excluir conexão' })).toBeVisible();
  const metaCard = screen.getByRole('heading', { name: 'Caixa Meta' }).closest('article')!;
  expect(within(metaCard).getByRole('button', { name: 'Excluir conexão' })).toBeVisible();
  const centralCard = screen.getByRole('heading', { name: 'Caixa da central' }).closest('article')!;
  expect(within(centralCard).queryByRole('button', { name: 'Excluir conexão' })).not.toBeInTheDocument();
});

it.each(['OPERATOR', 'VIEWER'] as const)('does not expose deletion to %s', async role => {
  const request = vi.fn(async () => ({ data: [qr, meta] })) as ApiClient['request'];
  render(<App client={client(request, role)} initialEntries={['/channels']} />);
  await screen.findByRole('heading', { name: 'Caixa QR' });
  expect(screen.queryByRole('button', { name: 'Excluir conexão' })).not.toBeInTheDocument();
});

it('uses the tenant lifecycle path and refreshes the list only after proven completion', async () => {
  let finish!: (value: unknown) => void;
  const receipt = new Promise(resolve => { finish = resolve; });
  let lists = 0;
  const request = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/v1/channels?pageSize=50') return { data: ++lists === 1 ? [qr, meta] : [meta] };
    if (path === `/v1/channels/${id}/deletion-preview`) return { resourceId: id, resourceName: 'Nome atual no servidor', kind: 'CHANNEL', canDelete: true,
      blockers: [], counts: { conversations: 2, messages: 7 }, externalEffects: [], operationId: null, operationStatus: null };
    if (path === `/v1/channels/${id}/deletion` && options?.method === 'POST') return { operationId: 'operation', status: 'REQUESTED' };
    if (path === `/v1/channels/${id}/deletion/operation`) return receipt;
    throw new Error(`Unexpected ${path}`);
  }) as ApiClient['request'];
  render(<App client={client(request)} initialEntries={['/channels']} />);
  const card = (await screen.findByRole('heading', { name: 'Caixa QR' })).closest('article')!;
  fireEvent.click(within(card).getByRole('button', { name: 'Excluir conexão' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirmar exclusão definitiva' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/v1/channels/${id}/deletion`, expect.objectContaining({ method: 'POST',
    body: JSON.stringify({ confirmationName: 'Nome atual no servidor', reason: 'Exclusão da conexão confirmada pelo administrador no painel do Broker.' }) })));
  expect(screen.getByRole('heading', { name: 'Caixa QR' })).toBeVisible();
  expect(lists).toBe(1);
  await act(async () => { finish({ operationId: 'operation', status: 'COMPLETED' }); });
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Caixa QR' })).not.toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'Caixa Meta' })).toBeVisible();
  expect(lists).toBe(2);
});
