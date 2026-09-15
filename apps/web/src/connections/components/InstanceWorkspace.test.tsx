// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client.js';
import { App } from '../../app/App.js';

const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const org = { id: '92776cb0-bcba-45c0-98a3-2937fefdfdaf', name: 'Empresa', slug: 'empresa', role: 'OWNER' };
const now = '2030-01-01T12:00:00.000Z';
const instance = { id, organizationId: org.id, providerAccountId: '6fd7933a-80b7-4491-b081-a0fa8c2414d2', provider: 'BAILEYS', name: 'Atendimento', status: 'CONNECTED', createdAt: now, updatedAt: now };
const settings = { rejectCall: false, msgCall: 'Ligue para nossa central', groupsIgnore: true, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false };
const workspace = { instance, observedAt: now, providerAvailable: true, profile: { name: 'Empresa WhatsApp', phone: '5511999999999', state: 'open' }, counts: { contacts: 12, chats: 0, messages: null }, settings, operations: [{ id: 'op-1', type: 'CONNECT', status: 'SUCCEEDED', attempts: 1, errorCode: null, updatedAt: now }] };
function setup(options: { role?: string; response?: unknown; request?: ApiClient['request'] } = {}) {
  const purges = new Set<() => void>();
  const request = options.request ?? vi.fn(async (path: string) => path.endsWith('/workspace') ? options.response ?? workspace : instance) as ApiClient['request'];
  const client = { request, restore: vi.fn(async () => ({ user: { id: 'u', email: 'a@example.test' }, activeOrganization: { ...org, role: options.role ?? 'OWNER' }, organizations: [org] })), registerTenantPurge: (fn: () => void) => { purges.add(fn); return () => purges.delete(fn); }, subscribeToSessionExpiration: () => () => undefined } as unknown as ApiClient;
  render(<App client={client} initialEntries={[`/conexoes/${id}`]} />);
  return { request, purges };
}
describe('instance workspace', () => {
  it('shows real profile and distinguishes zero from unknown counts', async () => {
    setup();
    expect(await screen.findByText('Empresa WhatsApp')).toBeVisible();
    expect(within(screen.getByLabelText('Contatos sincronizados')).getByText('12')).toBeVisible();
    expect(within(screen.getByLabelText('Conversas sincronizadas')).getByText('0')).toBeVisible();
    expect(within(screen.getByLabelText('Mensagens sincronizadas')).getByText('—')).toBeVisible();
  });
  it('saves only explicit settings changes and preserves the rejection message', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => init?.method === 'PUT' ? { ok: true } : path.endsWith('/workspace') ? workspace : instance) as ApiClient['request'];
    setup({ request });
    fireEvent.click(await screen.findByRole('button', { name: 'Configurações' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Rejeitar chamadas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configurações' }));
    expect(await screen.findByText('Configurações salvas.')).toBeVisible();
    expect(request).toHaveBeenCalledWith(`/v1/instances/${id}/settings`, expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ...settings, rejectCall: true }) }));
  });
  it('keeps settings read only for operators', async () => {
    setup({ role: 'OPERATOR' });
    fireEvent.click(await screen.findByRole('button', { name: 'Configurações' }));
    expect(await screen.findByRole('checkbox', { name: /Rejeitar chamadas/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Salvar configurações' })).not.toBeInTheDocument();
  });
  it('does not claim a failed save succeeded or change the stored configuration', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') throw new Error('network unavailable');
      return path.endsWith('/workspace') ? workspace : instance;
    }) as ApiClient['request'];
    setup({ request });
    fireEvent.click(await screen.findByRole('button', { name: 'Configurações' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Rejeitar chamadas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configurações' }));
    expect(await screen.findByText(/Não foi possível confirmar a alteração/)).toBeVisible();
    expect(screen.queryByText('Configurações salvas.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar painel' }));
    expect(await screen.findByRole('checkbox', { name: /Rejeitar chamadas/ })).not.toBeChecked();
  });
  it('clears profile on tenant purge and rejects a late response', async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn(async (path: string) => path.endsWith('/workspace') ? new Promise((done) => { resolve = done; }) : instance) as ApiClient['request'];
    const { purges } = setup({ request });
    await screen.findByRole('button', { name: 'Visão geral' });
    act(() => { for (const purge of [...purges]) purge(); });
    await act(async () => resolve(workspace));
    expect(screen.queryByText('Empresa WhatsApp')).not.toBeInTheDocument();
  });
  it('handles unavailable workspace without breaking connection controls', async () => {
    setup({ response: instance });
    expect(await screen.findByText('Painel temporariamente indisponível.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Desconectar' })).toBeVisible();
  });
  it('shows real operations and truthful existing integration links', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Eventos' }));
    expect(await screen.findByText('Conectar')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Integrações' }));
    expect(screen.getByRole('link', { name: 'Abrir mensagens e automações' })).toHaveAttribute('href', '/mensagens');
    expect(screen.getByText(/Typebot está disponível nos canais Meta/)).toBeVisible();
  });
});
