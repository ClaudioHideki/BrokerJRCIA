// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { welcomeFlow } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { GuidedSetupSurface } from './GuidedSetupPage.js';

const org = '11111111-1111-4111-8111-111111111111', setupId = '22222222-2222-4222-8222-222222222222';
const channel = '33333333-3333-4333-8333-333333333333', canonical = '44444444-4444-4444-8444-444444444444';
const integration = '55555555-5555-4555-8555-555555555555', flow = '66666666-6666-4666-8666-666666666666';
const timestamp = '2026-11-09T12:00:00.000Z';
const channelView = { schemaVersion: 1, id: channel, organizationId: org, messagingChannelId: canonical, provider: 'QR',
  identity: { displayName: 'WhatsApp Suporte', maskedAddress: null }, providerReference: { providerAccountId: org, instanceId: channel },
  transportStatus: 'CONNECTED', providerStatus: 'READY', automationStatus: 'UNBOUND', humanStatus: 'READY', revision: 1, createdAt: timestamp, updatedAt: timestamp };
const catalog = { scope: { organizationId: org, channelId: canonical, integrationId: integration, destinationRevision: 1, accountId: 7, inboxId: 8 },
  observedAt: timestamp, credentialRevision: 1, teams: [], agents: [{ id: 3, name: 'Agente Suporte', inboxMember: false }], labels: [], attributes: [],
  hours: { enabled: false, timezone: null, days: [] }, remoteBot: null, inboxPolicy: { greetingEnabled: false, autoAssignmentEnabled: false },
  capabilities: { teams: 'SUPPORTED', agents: 'SUPPORTED', inboxMembership: 'SUPPORTED', labels: 'SUPPORTED', attributes: 'SUPPORTED', hours: 'SUPPORTED',
    agentBot: 'SUPPORTED', signatures: 'SUPPORTED', controlEvents: 'SUPPORTED', initialPending: 'SUPPORTED' } };
const status = { configured: true, baseUrl: 'https://central.example.test', managedBaseUrl: null, provisioningAvailable: false,
  account: { accountId: 7, status: 'READY', lastError: null, hasCredential: true, credentialVersion: 1 }, jobs: {},
  connections: [{ id: integration, channelId: canonical, inboxId: 8, name: 'Caixa Suporte', status: 'READY', lastError: null, webhookUrl: 'https://broker.example.test/webhook' }] };
function fixture(selection: Record<string, unknown> = { transport: 'QR' }) {
  let row = { id: setupId, organizationId: org, actorId: org, name: 'Configuração Suporte', revision: 1, state: 'EDITING',
    selection, readiness: null, proof: null, pendingAction: null, test: null, createdAt: timestamp, updatedAt: timestamp };
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/availability')) return { enabled: true };
    if (path === `/v1/guided-setups/${setupId}`) {
      if (init?.method === 'PUT') row = { ...row, revision: row.revision + 1, selection: JSON.parse(String(init.body)).selection };
      return row;
    }
    if (path.startsWith('/v1/channels?')) return { data: [channelView], nextCursor: null };
    if (path === `/v1/channels/${channel}`) return channelView;
    if (path === '/v1/integrations/chatwoot') return status;
    if (path.endsWith(`/connections/${integration}/attendance-catalog`)) return catalog;
    if (path.endsWith(`/connections/${integration}/agents`) && init?.method === 'POST') { catalog.agents[0]!.inboxMember = true; return { data: [] }; }
    if (path === '/v1/automations') return { data: [{ schemaVersion: 1, id: flow, organizationId: org, name: 'Robô Suporte', lifecycleStatus: 'PUBLISHED',
      draft: { revision: 1, graph: welcomeFlow() }, activeVersion: 1, updatedAt: timestamp }], nextCursor: null };
    if (path === `/v1/automations/${flow}/versions`) return { data: [{ schemaVersion: 1, automationId: flow, organizationId: org, version: 1,
      graph: welcomeFlow(), checksum: 'a'.repeat(64), publishedAt: timestamp }] };
    throw new Error('Unexpected request: ' + path);
  });
  render(<MemoryRouter><GuidedSetupSurface client={{ request } as unknown as ApiClient} organizationId={org} organizationName="Empresa A" setupId={setupId} /></MemoryRouter>);
  return { request };
}
it('selects a WhatsApp connection by name and saves only its local reference', async () => {
  const f = fixture();
  fireEvent.click(await screen.findByRole('button', { name: 'WhatsApp' }));
  fireEvent.change(await screen.findByLabelText('WhatsApp desta empresa'), { target: { value: channel } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar conexão' }));
  await waitFor(() => expect(f.request).toHaveBeenCalledWith(`/v1/guided-setups/${setupId}`, expect.objectContaining({ method: 'PUT',
    body: JSON.stringify({ revision: 1, selection: { transport: 'QR', channelId: channel } }) })));
});
it('links selected named agents to the selected JRC inbox and saves the human destination', async () => {
  catalog.agents[0]!.inboxMember = false;
  const f = fixture({ transport: 'QR', channelId: channel, integrationId: integration });
  fireEvent.click(await screen.findByRole('button', { name: 'Caixa e atendentes' }));
  fireEvent.click(await screen.findByLabelText('Agente Suporte'));
  fireEvent.change(screen.getByLabelText('Destino do atendimento humano'), { target: { value: 'agent:3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar caixa e atendentes' }));
  await waitFor(() => expect(f.request).toHaveBeenCalledWith(`/v1/integrations/chatwoot/connections/${integration}/agents`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ userIds: [3] }) })));
  await waitFor(() => expect(f.request).toHaveBeenCalledWith(`/v1/guided-setups/${setupId}`, expect.objectContaining({ method: 'PUT',
    body: JSON.stringify({ revision: 1, selection: { transport: 'QR', channelId: channel, integrationId: integration, agentIds: [3], humanTarget: { agentId: 3, teamId: null } } }) })));
});
it('chooses an exact published bot version without activating it', async () => {
  const f = fixture({ transport: 'QR', channelId: channel });
  fireEvent.click(await screen.findByRole('button', { name: 'Robô e vínculos' }));
  fireEvent.change(await screen.findByLabelText('Robô desta empresa'), { target: { value: flow } });
  await screen.findByRole('option', { name: 'Versão 1' });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar robô selecionado' }));
  await waitFor(() => expect(f.request).toHaveBeenCalledWith(`/v1/guided-setups/${setupId}`, expect.objectContaining({ method: 'PUT',
    body: JSON.stringify({ revision: 1, selection: { transport: 'QR', channelId: channel, automationId: flow, version: 1 } }) })));
  expect(f.request.mock.calls.some(([path]) => path.endsWith('/activate') || path.endsWith('/bindings'))).toBe(false);
});
