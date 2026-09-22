import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { bindChannelAutomation, disconnectChannel, getChannelAutomation, patchChannel,
  reconnectChannel, refreshChannelStatus } from './api.js';

const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const account = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const timestamp = '2030-01-01T12:00:00.000Z';
const channel = { schemaVersion: 1, id, organizationId: org, provider: 'QR',
  identity: { displayName: 'Atendimento', maskedAddress: null },
  providerReference: { providerAccountId: account, instanceId: id }, transportStatus: 'CONNECTED',
  providerStatus: 'READY', automationStatus: 'ACTIVE', humanStatus: 'UNBOUND', revision: 1,
  createdAt: timestamp, updatedAt: timestamp };
const binding = { schemaVersion: 1, id: account, organizationId: org, automationId: id, version: 2,
  channelId: id, humanDestinationId: null, status: 'ACTIVE', revision: 1, createdAt: timestamp, updatedAt: timestamp };

describe('canonical channel browser API', () => {
  it('uses the canonical lifecycle and automation endpoints', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/automation')) return { binding };
      if (path.endsWith('/reconnect')) return { provider: 'QR', channel, operationId: null, replayed: false,
        pending: false, reconciliationRequired: false, action: { type: 'NONE', reason: 'ALREADY_CONNECTED' } };
      if (path.endsWith('/disconnect')) return { provider: 'QR', channel: { ...channel, transportStatus: 'DISCONNECTED' },
        operationId: null, replayed: false, pending: false, reconciliationRequired: false };
      if (path.endsWith('/status') || (path.endsWith(`/${id}`) && init?.method === 'PATCH')) return channel;
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    const client = { request } as ApiClient;
    await expect(refreshChannelStatus(client, id)).resolves.toMatchObject({ id });
    await expect(patchChannel(client, id, { displayName: 'Comercial' })).resolves.toMatchObject({ id });
    await expect(reconnectChannel(client, id, 'retry-key')).resolves.toMatchObject({ action: { type: 'NONE' } });
    await expect(disconnectChannel(client, id, 'stop-key')).resolves.toMatchObject({ channel: { transportStatus: 'DISCONNECTED' } });
    await expect(getChannelAutomation(client, id)).resolves.toMatchObject({ binding: { version: 2 } });
    await expect(bindChannelAutomation(client, id, { automationId: id, version: 2 })).resolves.toMatchObject({ binding: { automationId: id } });
    expect(request).toHaveBeenCalledWith(`/v1/channels/${id}/reconnect`, expect.objectContaining({ method: 'POST' }));
    expect(request).toHaveBeenCalledWith(`/v1/channels/${id}/automation`, expect.objectContaining({ method: 'PUT' }));
  });
});
