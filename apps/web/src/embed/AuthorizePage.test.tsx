// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import { ApiClientError, type ApiClient, type BrowserSession } from '../api/client.js';

const id = '00000000-0000-4000-8000-000000000001';
const session: BrowserSession = { user: { id, email: 'synthetic@example.test' },
  activeOrganization: { id, name: 'Empresa sintética', slug: 'synthetic', role: 'OWNER' },
  organizations: [{ id, name: 'Empresa sintética', slug: 'synthetic', role: 'OWNER' }] };
function fixture({ anonymous = false, denied = false } = {}) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (denied) throw new ApiClientError('Acesso negado', 403);
    if (init?.method === 'POST') return { ok: true };
    return { requestId: id, expiresAt: new Date(Date.now() + 120000).toISOString(), accountId: 1, chatwootOrigin: 'https://chatwoot.example.test',
      connections: [{ integrationId: id, inboxId: 31, name: 'Atendimento sintético', canPair: true }] };
  });
  const client: ApiClient = { request: request as ApiClient['request'],
    restore: async () => { if (anonymous) throw new ApiClientError('Sem sessão', 401); return session; },
    login: async () => ({ organizations: session.organizations, selectionToken: 's'.repeat(43), expiresAt: new Date(Date.now() + 120000).toISOString() }),
    selectOrganization: async () => session, switchOrganization: async () => session, logout: async () => undefined,
    registerTenantPurge: () => () => undefined, subscribeToSessionExpiration: () => () => undefined };
  return { client, request };
}
it('requires an explicit selection and consent after showing user, account and actions', async () => {
  const h = fixture(); render(<App client={h.client} initialEntries={[`/embed/authorize?requestId=${id}`]} />);
  expect(await screen.findByRole('heading', { name: 'Autorizar painel do Chatwoot' })).toBeVisible();
  expect(screen.getByText('synthetic@example.test')).toBeVisible();
  expect(screen.getByText(/Empresa sintética/)).toBeVisible();
  const approve = await screen.findByRole('button', { name: 'Autorizar por 5 minutos' });
  expect(approve).toBeDisabled(); expect(h.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /Atendimento sintético/ })); fireEvent.click(approve);
  expect(await screen.findByText(/Autorização concedida/)).toBeVisible();
  expect(h.request).toHaveBeenCalledWith(`/v1/embed/authorizations/${id}/approve`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ integrationIds: [id] }) }));
});
it('keeps the public request through the existing login and organization selection', async () => {
  const h = fixture({ anonymous: true }); render(<App client={h.client} initialEntries={[`/embed/authorize?requestId=${id}`]} />);
  await screen.findByRole('heading', { name: 'Acesse sua console' });
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'synthetic@example.test' } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'synthetic-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Acessar Empresa sintética' }));
  expect(await screen.findByRole('heading', { name: 'Autorizar painel do Chatwoot' })).toBeVisible();
  await waitFor(() => expect(h.request).toHaveBeenCalledWith(`/v1/embed/authorizations/${id}`));
});
it('does not offer approval when the current organization cannot read the request', async () => {
  const h = fixture({ denied: true }); render(<App client={h.client} initialEntries={[`/embed/authorize?requestId=${id}`]} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/Solicitação indisponível/);
  expect(screen.queryByRole('button', { name: 'Autorizar por 5 minutos' })).not.toBeInTheDocument();
});
