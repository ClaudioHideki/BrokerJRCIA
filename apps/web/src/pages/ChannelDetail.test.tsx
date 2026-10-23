// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { welcomeFlow, type ChannelV1 } from '@jrc/contracts';
import type { ApiClient, BrowserSession } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { ProtectedRoute } from '../auth/guards.js';
import { ChannelDetailPage } from './ChannelDetail.js';

const organizationId = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const instanceId = '66666666-6666-4666-8666-666666666666';
const account = '6fd7933a-80b7-4491-b081-a0fa8c2414d2';
const automationId = '11111111-2222-4333-8444-555555555555';
const timestamp = '2030-01-01T12:00:00.000Z';
const initialSettings = { rejectCall: false, msgCall: 'Ligue para nossa central', groupsIgnore: true, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false };

function setup(provider: ChannelV1['provider'] = 'QR', role: BrowserSession['activeOrganization']['role'] = 'OWNER') {
  const organization = { id: organizationId, name: 'Empresa', slug: 'empresa', role };
  const common = { schemaVersion: 1 as const, id, organizationId, identity: { displayName: 'Conexão da empresa', maskedAddress: '****0100' },
    transportStatus: 'CONNECTED' as const, providerStatus: 'READY' as const, automationStatus: 'UNBOUND' as const, humanStatus: 'UNBOUND' as const,
    revision: 1, ownerRevision: 7, createdAt: timestamp, updatedAt: timestamp };
  const channel: ChannelV1 = provider === 'QR' ? { ...common, provider, providerReference: { providerAccountId: account, instanceId } }
    : provider === 'META' ? { ...common, provider, providerReference: { providerAccountId: account, connectionId: instanceId } }
    : { ...common, provider, providerReference: { integrationId: instanceId, accountId: 1, inboxId: 9 } };
  let settings = { ...initialSettings }, binding: unknown = null;
  const request = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === `/v1/channels/${id}`) return channel;
    if (path === `/v1/instances/${instanceId}/workspace`) return { observedAt: timestamp, providerAvailable: true,
      instance: { id: instanceId, name: 'Conexão da empresa', status: 'CONNECTED', createdAt: timestamp, updatedAt: timestamp },
      profile: { name: 'Perfil da empresa', phone: '15555550100', state: 'open' }, counts: { contacts: 12, chats: 0, messages: null }, settings,
      operations: [{ id: 'operation-1', type: 'CONNECT', status: 'SUCCEEDED', attempts: 1, errorCode: null, updatedAt: timestamp }] };
    if (path === `/v1/instances/${instanceId}/settings` && options?.method === 'PUT') { settings = JSON.parse(String(options.body)); return { ok: true }; }
    if (path === `/v1/channels/${id}/automation`) {
      if (options?.method === 'PUT') binding = { schemaVersion: 1, id: account, organizationId, automationId, version: 1, channelId: id,
        humanDestinationId: null, status: 'ACTIVE', revision: 1, createdAt: timestamp, updatedAt: timestamp };
      return { binding, ownerRevision: binding ? 8 : 7 };
    }
    if (path === '/v1/automations') return { data: [{ schemaVersion: 1, id: automationId, organizationId, name: 'Triagem',
      lifecycleStatus: 'PUBLISHED', draft: { revision: 1, graph: welcomeFlow() }, activeVersion: 1, updatedAt: timestamp }] };
    throw new Error(`Unexpected ${path}`);
  }) as unknown as ApiClient['request'] & ReturnType<typeof vi.fn>;
  const client = { request, restore: vi.fn(async () => ({ user: { id: account, email: 'owner@example.test' }, activeOrganization: organization, organizations: [organization] })),
    registerTenantPurge: vi.fn(() => () => undefined), subscribeToSessionExpiration: vi.fn(() => () => undefined) } as unknown as ApiClient;
  render(<SessionProvider client={client}><MemoryRouter initialEntries={[`/channels/${id}`]}><Routes>
    <Route path="/channels/:id" element={<ProtectedRoute><ChannelDetailPage /></ProtectedRoute>} />
  </Routes></MemoryRouter></SessionProvider>);
  return { request };
}

describe('canonical connection workspace areas', () => {
  it('opens a compact overview using the provider instance ID without loading setup forms', async () => {
    const { request } = setup();
    expect(await screen.findByRole('tab', { name: 'Visão geral', selected: true })).toBeVisible();
    expect(await screen.findByText('Perfil da empresa')).toBeVisible();
    expect(screen.getAllByRole('tablist', { name: 'Áreas da conexão' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Abrir conversas' })).toHaveAttribute('href', '/mensagens');
    expect(screen.getByRole('button', { name: 'Reconectar' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Próximo passo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Vincular automação' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar nome' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir conexão' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(`/v1/instances/${instanceId}/workspace`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(request.mock.calls.some(([path]) => String(path).includes(`/instances/${id}/`) || /automation|history-import|whatsapp-groups/.test(String(path)))).toBe(false);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Visão geral' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Configurações WhatsApp', selected: true })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Configurações WhatsApp' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Visão geral', selected: true })).toHaveFocus();
  });

  it('keeps all six WhatsApp settings and an unsaved draft across areas, then persists only an explicit save', async () => {
    const { request } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Configurações WhatsApp' }));
    expect(await screen.findAllByRole('checkbox')).toHaveLength(6);
    fireEvent.click(screen.getByRole('checkbox', { name: /Manter online/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Eventos' }));
    expect(await screen.findByRole('heading', { name: 'Histórico operacional' })).toBeVisible();
    expect(screen.getByText('Concluída')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Salvar configurações' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Configurações WhatsApp' }));
    expect(screen.getByRole('checkbox', { name: /Manter online/ })).toBeChecked();
    expect(request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configurações' }));
    expect(await screen.findByText('Configurações salvas.')).toBeVisible();
    expect(request).toHaveBeenCalledWith(`/v1/instances/${instanceId}/settings`, expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ...initialSettings, alwaysOnline: true }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar painel' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Manter online/ })).toBeChecked());
    expect(screen.getByRole('button', { name: 'Salvar configurações' })).toBeDisabled();
  });

  it.each(['OPERATOR', 'VIEWER'] as const)('keeps WhatsApp settings read only for %s', async role => {
    const { request } = setup('QR', role);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configurações WhatsApp' }));
    expect(await screen.findByRole('checkbox', { name: /Rejeitar chamadas/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Salvar configurações' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir conexão' })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it.each(['META', 'CENTRAL'] as const)('keeps %s away from QR workspace and settings endpoints', async provider => {
    const { request } = setup(provider);
    await screen.findByRole('tab', { name: 'Visão geral' });
    expect(screen.queryByRole('tab', { name: 'Configurações WhatsApp' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Eventos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Histórico e grupos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconectar' })).not.toBeInTheDocument();
    if (provider === 'META') {
      fireEvent.click(screen.getByRole('tab', { name: 'Configurações' }));
      expect(screen.getByRole('link', { name: 'Abrir configuração oficial' })).toHaveAttribute('href', '/channels/meta/connect');
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Atendimento' }));
    expect(await screen.findByRole('heading', { name: 'Escolher onde a equipe atende' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Flow' }));
    await screen.findByRole('option', { name: 'Triagem · v1' });
    expect(request.mock.calls.some(([path]) => String(path).startsWith('/v1/instances/'))).toBe(false);
  });

  it('loads Flow only on request and binds only the selected published version with the current owner revision', async () => {
    const { request } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Flow' }));
    await screen.findByRole('option', { name: 'Triagem · v1' });
    expect(screen.getByLabelText('Automação publicada')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Vincular automação' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Automação publicada'), { target: { value: automationId } });
    fireEvent.click(screen.getByRole('tab', { name: 'Visão geral' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Flow' }));
    expect(screen.getByLabelText('Automação publicada')).toHaveValue(automationId);
    fireEvent.click(screen.getByRole('button', { name: 'Vincular automação' }));
    expect(await screen.findByText('Automação vinculada. Novas mensagens usarão esta versão.')).toBeVisible();
    expect(request).toHaveBeenCalledWith(`/v1/channels/${id}/automation`, expect.objectContaining({ method: 'PUT', body: JSON.stringify({ automationId, expectedOwnerRevision: 7 }) }));
  });
});
