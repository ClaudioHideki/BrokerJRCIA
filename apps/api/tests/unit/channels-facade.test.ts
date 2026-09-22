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
    await expect(service.reconnect({ credentialKind: 'JWT', organizationId: org, actorId: account, requestId: 'request' }, id, 'retry'))
      .rejects.toEqual(new ChannelFacadeError('CHANNEL_RECONNECT_UNSUPPORTED', 409));
    await expect(service.disconnect({ credentialKind: 'JWT', organizationId: org, actorId: account, requestId: 'request' }, id, 'stop'))
      .rejects.toEqual(new ChannelFacadeError('CHANNEL_DISCONNECT_UNSUPPORTED', 409));
    await expect(service.patch(org, id, { displayName: 'Novo nome' }))
      .rejects.toEqual(new ChannelFacadeError('CHANNEL_PATCH_UNSUPPORTED', 409));
  });

  it('refreshes, reconnects, disconnects and renames QR through the canonical identity', async () => {
    const instance = { id, organizationId: org, providerAccountId: account, name: 'Atendimento', provider: 'BAILEYS' as const,
      status: 'CONNECTED' as const, createdAt: now, updatedAt: now };
    const getInstanceStatus = vi.fn().mockResolvedValue(instance);
    const connectInstance = vi.fn().mockResolvedValue({ instance, operationId: null, replayed: false, pending: false,
      reconciliationRequired: false, action: { type: 'NONE', reason: 'ALREADY_CONNECTED' } });
    const disconnectInstance = vi.fn().mockResolvedValue({ instance: { ...instance, status: 'DISCONNECTED' }, operationId: null,
      replayed: false, pending: false, reconciliationRequired: false });
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('UPDATE instances') ? [{ id }] : [{
      id, organization_id: org, provider: 'BAILEYS', provider_account_id: account, instance_id: id, connection_id: null,
      name: 'Atendimento', instance_status: 'CONNECTED', meta_status: null, bot_public_id: null, bot_origin_reference: null,
      flow_published_version: null, flow_enabled: null, human_status: null, created_at: now, updated_at: now,
    }] }));
    const service = createChannelFacade({ instances: { getInstanceStatus, connectInstance, disconnectInstance } as unknown as InstanceService,
      meta: { start: vi.fn() }, transact: async (_org, work) => work({ query } as never) });
    const context = { credentialKind: 'JWT' as const, organizationId: org, actorId: account, requestId: 'request' };
    await expect(service.status(context, id)).resolves.toMatchObject({ id, transportStatus: 'CONNECTED' });
    await expect(service.reconnect(context, id, 'retry')).resolves.toMatchObject({ action: { type: 'NONE' } });
    await expect(service.disconnect(context, id, 'stop')).resolves.toMatchObject({ channel: { transportStatus: 'DISCONNECTED' } });
    await expect(service.patch(org, id, { displayName: 'Comercial' })).resolves.toMatchObject({ id });
    expect(getInstanceStatus).toHaveBeenCalledWith(context, id);
    expect(connectInstance).toHaveBeenCalledWith(context, { instanceId: id, idempotencyKey: 'retry' });
    expect(disconnectInstance).toHaveBeenCalledWith(context, { instanceId: id, idempotencyKey: 'stop' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE instances SET name'))).toBe(true);
  });

  it('binds the published automation to the organization channel and replaces the prior binding', async () => {
    const bindingId = 'b756303c-0f2d-4898-9a75-8a56ef66d120';
    const sql: string[] = [];
    const query = vi.fn(async (statement: string) => {
      sql.push(statement);
      if (statement.includes('UNION ALL')) return { rows: [{
        id, organization_id: org, provider: 'BAILEYS', provider_account_id: account, instance_id: id, connection_id: null,
        name: 'Atendimento', instance_status: 'CONNECTED', meta_status: null, bot_public_id: null, bot_origin_reference: null,
        flow_published_version: null, flow_enabled: null, human_status: null, created_at: now, updated_at: now,
      }] };
      if (statement.includes('SELECT id FROM messaging_channels')) return { rows: [{ id }] };
      if (statement.includes('FROM automation_definitions')) return { rows: [{ activeVersion: 2 }] };
      if (statement.includes('FROM automation_versions')) return { rows: [{ version: 2 }] };
      if (statement.includes('INSERT INTO automation_bindings')) return { rows: [{ id: bindingId, organizationId: org,
        automationId: account, version: 2, channelId: id, humanDestinationId: null, status: 'ACTIVE', revision: 1,
        createdAt: now, updatedAt: now }] };
      if (statement.includes('FROM automation_bindings')) return { rows: [{ id: bindingId, organizationId: org,
        automationId: account, version: 2, channelId: id, humanDestinationId: null, status: 'ACTIVE', revision: 1,
        createdAt: now, updatedAt: now }] };
      return { rows: [] };
    });
    const service = createChannelFacade({ instances: {} as InstanceService, meta: { start: vi.fn() },
      transact: async (_org, work) => work({ query } as never) });
    await expect(service.bindAutomation(org, id, { automationId: account })).resolves.toMatchObject({
      binding: { id: bindingId, automationId: account, version: 2, channelId: id },
    });
    await expect(service.getAutomation(org, id)).resolves.toMatchObject({ binding: { id: bindingId } });
    expect(sql.some(statement => statement.includes("status='DISABLED'"))).toBe(true);
    expect(sql.some(statement => statement.includes('bot_origin_reference'))).toBe(true);
  });
});
