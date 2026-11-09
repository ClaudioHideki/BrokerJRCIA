// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import type { ApiClient } from '../api/client.js';
it('offers the guide from the channel list only when this tenant is enabled', async () => {
  const org = '11111111-1111-4111-8111-111111111111', activeOrganization = { id: org, name: 'Empresa Piloto', slug: 'pilot', role: 'OWNER' as const };
  const request = vi.fn(async (path: string) => {
    if (path === '/v1/guided-setups/availability') return { enabled: true };
    if (path === '/v1/guided-setups') return { data: [] };
    if (path.startsWith('/v1/channels?')) return { data: [], nextCursor: null };
    if (path === '/v1/flows/status') return { enabled: true };
    throw new Error(path);
  });
  const client = { request, restore: async () => ({ activeOrganization, organizations: [activeOrganization], user: { id: org, email: 'owner@example.test' } }),
    registerTenantPurge: () => () => {}, subscribeToSessionExpiration: () => () => {} } as unknown as ApiClient;
  render(<App client={client} initialEntries={['/channels']} />);
  fireEvent.click(await screen.findByRole('link', { name: 'Configurar atendimento guiado' }));
  expect(await screen.findByRole('heading', { name: 'Configuração guiada' })).toBeVisible();
});
