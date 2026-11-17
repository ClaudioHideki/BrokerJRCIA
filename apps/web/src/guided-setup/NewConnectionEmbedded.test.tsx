// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SessionProvider } from '../auth/SessionProvider.js';
import type { ApiClient } from '../api/client.js';
import { NewConnectionPage } from '../pages/NewConnection.js';
it('returns a newly created QR channel to the guide without navigating away', async () => {
  const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222', timestamp = '2026-11-09T12:00:00.000Z';
  const request = vi.fn(async (path: string) => {
    if (path.startsWith('/v1/provider-accounts?')) return { data: [{ id: org, name: 'QR Account', provider: 'BAILEYS', createdAt: timestamp }], pageInfo: { hasNextPage: false, nextCursor: null } };
    if (path === '/v1/channels') return { provider: 'QR', operationId: null, replayed: false, pending: false, reconciliationRequired: false,
      channel: { schemaVersion: 1, id, organizationId: org, provider: 'QR', identity: { displayName: 'Support', maskedAddress: null },
        providerReference: { providerAccountId: org, instanceId: id }, transportStatus: 'CREATED', providerStatus: 'READY', automationStatus: 'UNBOUND', humanStatus: 'UNBOUND', revision: 1, createdAt: timestamp, updatedAt: timestamp } };
    throw new Error(path);
  });
  const activeOrganization = { id: org, name: 'Example', slug: 'example', role: 'OWNER' as const };
  const client = { request, restore: async () => ({ activeOrganization, organizations: [activeOrganization], user: { id: org, email: 'owner@example.test' } }),
    registerTenantPurge: () => () => {}, subscribeToSessionExpiration: () => () => {} } as unknown as ApiClient;
  const onCreated = vi.fn();
  render(<MemoryRouter><SessionProvider client={client}><NewConnectionPage canonical onCreated={onCreated} /></SessionProvider></MemoryRouter>);
  await screen.findByRole('option', { name: /QR Account/ });
  fireEvent.change(screen.getByLabelText('Nome da conexão'), { target: { value: 'Support' } });
  fireEvent.click(screen.getByRole('button', { name: 'Criar conexão' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(id));
});

it('does not load provider accounts before the tenant session is restored', async () => {
  let restore!: (value: unknown) => void;
  const request = vi.fn(async () => ({ data: [], pageInfo: { hasNextPage: false, nextCursor: null } }));
  const client = { request, restore: () => new Promise(resolve => { restore = resolve; }),
    registerTenantPurge: () => () => {}, subscribeToSessionExpiration: () => () => {} } as unknown as ApiClient;
  render(<MemoryRouter><SessionProvider client={client}><NewConnectionPage canonical /></SessionProvider></MemoryRouter>);
  expect(request).not.toHaveBeenCalled();
  const activeOrganization = { id: '11111111-1111-4111-8111-111111111111', name: 'Example', slug: 'example', role: 'OWNER' as const };
  await act(async () => restore({ activeOrganization, organizations: [activeOrganization], user: { id: activeOrganization.id, email: 'owner@example.test' } }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
});
