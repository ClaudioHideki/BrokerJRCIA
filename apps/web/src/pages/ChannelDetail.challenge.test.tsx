// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ChannelV1, ConnectionAction } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { ProtectedRoute } from '../auth/guards.js';
import { ChannelDetailPage } from './ChannelDetail.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const channelId = '22222222-2222-4222-8222-222222222222';
const instanceId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3aQAAAAASUVORK5CYII=';
const qr = (value = `data:image/png;base64,${png}`): ConnectionAction => ({
  type: 'QR_CODE', encoding: 'DATA_URL', value, expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

function setup(action: ConnectionAction, deferPair = false) {
  const timestamp = new Date().toISOString();
  const organization = { id: organizationId, name: 'Empresa de teste', slug: 'teste', role: 'OWNER' as const };
  const channel: ChannelV1 = {
    schemaVersion: 1, id: channelId, organizationId, provider: 'QR',
    providerReference: { providerAccountId: userId, instanceId },
    identity: { displayName: 'Conexão de teste', maskedAddress: null },
    transportStatus: 'DISCONNECTED', providerStatus: 'READY', automationStatus: 'UNBOUND', humanStatus: 'UNBOUND',
    revision: 1, createdAt: timestamp, updatedAt: timestamp,
  };
  let statusError: ApiClientError | null = null;
  let releasePair: () => void = () => undefined;
  const pairReady = deferPair ? new Promise<void>(resolve => { releasePair = resolve; }) : Promise.resolve();
  const request = vi.fn(async (path: string) => {
    if (path === `/v1/channels/${channelId}`) return channel;
    if (path === `/v1/channels/${channelId}/pair`) {
      channel.transportStatus = 'PAIRING';
      await pairReady;
      return { provider: 'QR', channel, action, operationId: null, replayed: false, pending: false, reconciliationRequired: false };
    }
    if (path === `/v1/channels/${channelId}/status`) {
      if (statusError) throw statusError;
      return channel;
    }
    if (path === `/v1/instances/${instanceId}/workspace`) return {
      observedAt: timestamp, providerAvailable: true,
      instance: { id: instanceId, name: 'Conexão de teste', status: 'DISCONNECTED', createdAt: timestamp, updatedAt: timestamp },
      profile: { name: 'Perfil de teste', state: 'close' }, counts: { contacts: null, chats: null, messages: null },
      settings: { rejectCall: false, msgCall: '', groupsIgnore: true, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false }, operations: [],
    };
    throw new Error(`Unexpected test request: ${path}`);
  });
  const client = {
    request, restore: vi.fn(async () => ({
      user: { id: userId, email: 'owner@example.test' }, activeOrganization: organization, organizations: [organization],
    })), registerTenantPurge: vi.fn(() => () => undefined), subscribeToSessionExpiration: vi.fn(() => () => undefined),
  } as unknown as ApiClient;
  render(<SessionProvider client={client}><MemoryRouter initialEntries={[`/channels/${channelId}`]}><Routes>
    <Route path="/channels/:id" element={<ProtectedRoute><ChannelDetailPage /></ProtectedRoute>} />
  </Routes></MemoryRouter></SessionProvider>);
  return { request, releasePair, setTransport(value: ChannelV1['transportStatus']) { channel.transportStatus = value; },
    denyStatus() { statusError = new ApiClientError('Acesso revogado.', 403); } };
}

async function requestQr() {
  fireEvent.click(await screen.findByRole('button', { name: 'Gerar QR Code' }));
}

describe('canonical channel ephemeral challenge', () => {
  it.each([
    'https://outside.example.test/qr.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
  ])('rejects a QR value outside the existing PNG boundary: %s', async value => {
    setup(qr(value));
    await requestQr();
    await screen.findByText('QR Code inválido ou inseguro. Solicite um novo desafio.');
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).not.toBeInTheDocument();
  });

  it('renders a validated PNG only after the explicit pair action', async () => {
    setup(qr());
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).not.toBeInTheDocument();
    await requestQr();
    expect(await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toHaveAttribute('src', `data:image/png;base64,${png}`);
  });

  it('removes the QR when the document leaves and does not request a replacement', async () => {
    const { request } = setup(qr());
    await requestQr();
    await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' });
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/pair'))).toHaveLength(1);
  });

  it('removes a pairing code on pagehide as well', async () => {
    setup({ type: 'PAIRING_CODE', code: 'PAIRING-CANARY', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await requestQr();
    await screen.findByText('PAIRING-CANARY');
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(screen.queryByText('PAIRING-CANARY')).not.toBeInTheDocument();
  });

  it('does not restore a challenge whose request finishes after pagehide', async () => {
    const { request, releasePair } = setup(qr(), true);
    await requestQr();
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith('/pair'))).toHaveLength(1));
    act(() => window.dispatchEvent(new Event('pagehide')));
    await act(async () => releasePair());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gerar QR Code' })).toBeEnabled());
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).not.toBeInTheDocument();
  });

  it('clears the old challenge after a manual refresh rejects current access', async () => {
    const { denyStatus } = setup(qr());
    await requestQr();
    await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' });
    denyStatus();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar status' }));
    await waitFor(() => expect(screen.getByRole('alert', { name: 'Erro da caixa' })).toBeVisible());
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).not.toBeInTheDocument();
  });

  it('does not restore an old challenge after a terminal manual refresh followed by PAIRING', async () => {
    const { setTransport } = setup(qr());
    await requestQr();
    await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' });
    setTransport('CONNECTED');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar status' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Gerar QR Code' })).not.toBeInTheDocument());
    setTransport('PAIRING');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar status' }));
    await screen.findByRole('button', { name: 'Gerar QR Code' });
    expect(screen.queryByRole('img', { name: 'QR Code para conectar o WhatsApp' })).not.toBeInTheDocument();
  });
});
