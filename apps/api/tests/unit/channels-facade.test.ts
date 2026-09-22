import { describe, expect, it, vi } from 'vitest';
import type { InstanceService } from '../../src/modules/instances/service.js';
import { ChannelFacadeError, channelView, createChannelFacade } from '../../src/modules/channels/facade.js';

const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const account = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const now = '2030-01-01T12:00:00.000Z';

describe('channel facade', () => {
  it('keeps transport, provider, automation and human service states independent', () => {
    expect(channelView({ id, organization_id: org, provider: 'BAILEYS', provider_account_id: account,
      instance_id: id, connection_id: null, name: 'Atendimento', instance_status: 'CONNECTED', meta_status: null,
      bot_public_id: '519b77a6-a4e5-409a-85c8-d78fc155c525', bot_origin_reference: 'jrc-flows-native',
      flow_published_version: 2, flow_enabled: true, human_status: 'FAILED', created_at: now, updated_at: now })).toMatchObject({
      id, provider: 'QR', transportStatus: 'CONNECTED', providerStatus: 'READY', automationStatus: 'ACTIVE', humanStatus: 'DEGRADED',
    });
  });

  it('delegates QR creation and pairing without creating another transport identity', async () => {
    const instance = { id, organizationId: org, providerAccountId: account, name: 'Atendimento', provider: 'BAILEYS' as const,
      status: 'CREATED' as const, createdAt: now, updatedAt: now };
    const createInstance = vi.fn().mockResolvedValue({ instance, operationId: null, replayed: false, pending: false, reconciliationRequired: false });
    const connectInstance = vi.fn().mockResolvedValue({ instance: { ...instance, status: 'AWAITING_ACTION' }, operationId: null,
      replayed: false, pending: true, reconciliationRequired: false, action: { type: 'PAIRING_CODE', code: '12345678', expiresAt: now } });
    const service = createChannelFacade({ instances: { createInstance, connectInstance } as unknown as InstanceService,
      meta: { start: vi.fn() }, transact: async (_org, work) => work({ query: vi.fn().mockResolvedValue({ rows: [{
        id, organization_id: org, provider: 'BAILEYS', provider_account_id: account, instance_id: id, connection_id: null,
        name: 'Atendimento', instance_status: 'CREATED', meta_status: null, bot_public_id: null, bot_origin_reference: null,
        flow_published_version: null, flow_enabled: null, human_status: null, created_at: now, updated_at: now,
      }] }) } as never) });
    const context = { credentialKind: 'JWT' as const, organizationId: org, actorId: account, requestId: 'request' };
    const created = await service.create(context, account, { provider: 'QR', name: 'Atendimento', providerAccountId: account }, 'create-key');
    expect(created.provider).toBe('QR');
    expect(created.channel.id).toBe(id);
    const paired = await service.pair(context, id, 'pair-key');
    expect(paired.action).toMatchObject({ type: 'PAIRING_CODE', code: '12345678' });
    expect(connectInstance).toHaveBeenCalledWith(context, { instanceId: id, idempotencyKey: 'pair-key' });
  });

  it('starts Meta onboarding and rejects QR pairing for a Meta channel', async () => {
    const start = vi.fn().mockResolvedValue({ state: 'x'.repeat(43), expiresAt: now, appId: 'app', configId: 'config', graphVersion: 'v25.0' });
    const transact = async (_org: string, work: (tx: unknown) => Promise<unknown>) => work({ query: vi.fn().mockResolvedValue({ rows: [{
      id, organization_id: org, provider: 'META', provider_account_id: account, instance_id: null, connection_id: id,
      name: 'WhatsApp oficial', instance_status: null, meta_status: 'PENDING', bot_public_id: null, bot_origin_reference: null,
      flow_published_version: null, flow_enabled: null, human_status: null, created_at: now, updated_at: now,
    }] }) });
    const service = createChannelFacade({ instances: {} as InstanceService, meta: { start }, transact: transact as never });
    await expect(service.create({ credentialKind: 'JWT', organizationId: org, actorId: account, requestId: 'request' }, account,
      { provider: 'META' }, 'ignored')).resolves.toMatchObject({ provider: 'META', action: { type: 'EMBEDDED_SIGNUP' } });
    await expect(service.pair({ credentialKind: 'JWT', organizationId: org, actorId: account, requestId: 'request' }, id, 'pair'))
      .rejects.toEqual(new ChannelFacadeError('CHANNEL_PAIR_UNSUPPORTED', 409));
  });
});
