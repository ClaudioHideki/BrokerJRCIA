import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ownership from '../../src/modules/attendance/transition.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { AUTOMATION_ORIGIN } from '@jrc/contracts';
import type { InstanceService } from '../../src/modules/instances/service.js';
import { ChannelFacadeError, channelView, createChannelFacade } from '../../src/modules/channels/facade.js';

const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const account = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const now = '2030-01-01T12:00:00.000Z';

afterEach(() => vi.restoreAllMocks());

describe('channel facade', () => {
  it('represents the central inbox and refuses physical pairing or destination replacement',async()=>{
    const row={id,organization_id:org,provider:'CENTRAL' as const,provider_account_id:null,instance_id:null,connection_id:null,name:'Central synthetic',instance_status:null,meta_status:'READY' as const,
      bot_public_id:null,bot_origin_reference:null,flow_published_version:null,flow_enabled:null,human_status:'READY',created_at:now,updated_at:now,
      messaging_channel_id:id,integration_id:account,inbox_id:9,account_id:7};
    const service=createChannelFacade({instances:{} as InstanceService,meta:{start:vi.fn()},chatwoot:{connect:vi.fn()},transact:async(_org,work)=>work({query:vi.fn(async()=>({rows:[row]}))} as never)});
    expect(await service.get(org,id)).toMatchObject({provider:'CENTRAL',providerReference:{integrationId:account,accountId:7,inboxId:9},messagingChannelId:id});
    await expect(service.pair({credentialKind:'JWT',organizationId:org,actorId:account} as never,id,'synthetic')).rejects.toMatchObject({code:'CHANNEL_PAIR_UNSUPPORTED'});
    await expect(service.bindDestination(org,id,{name:'Changed',replaceExistingWebhook:true})).rejects.toMatchObject({code:'CENTRAL_DESTINATION_CUTOVER_REQUIRED'});
  });
  it.each(['AUTOMATION_RUNTIME_DISABLED','AUTOMATION_MODULE_DISABLED','AUTOMATION_DEPENDENCY_UNAVAILABLE'])('does not bypass %s when binding from a channel',async code=>{
    const transact=vi.fn(async()=>{throw new Error('BINDING_MUST_NOT_MUTATE');});
    const service=createChannelFacade({instances:{} as InstanceService,meta:{start:vi.fn()},transact,
      automationStatus:async()=>({canPublish:false,reasons:[code]})});
    await expect(service.bindAutomation(org,id,{automationId:account})).rejects.toMatchObject({code});
    expect(transact).not.toHaveBeenCalled();
  });
  it('selects a channel by ID in PostgreSQL instead of scanning every channel in the organization', async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({ rows: params[1] === id ? [{
      id, organization_id: org, provider: 'BAILEYS', provider_account_id: account, instance_id: id,
      connection_id: null, name: 'Atendimento', instance_status: 'CONNECTED', meta_status: null,
      bot_public_id: null, bot_origin_reference: null, flow_published_version: null, flow_enabled: null,
      human_status: null, created_at: now, updated_at: now,
    }] : [] }));
    const service = createChannelFacade({ instances: {} as InstanceService, meta: { start: vi.fn() },
      transact: async (_org, work) => work({ query } as never) });

    await expect(service.get(org, id)).resolves.toMatchObject({ id, provider: 'QR' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([org, id]);
    expect(query.mock.calls[0]?.[0]).toMatch(/WHERE i\.organization_id=\$1 AND i\.id=\$2/);
    expect(query.mock.calls[0]?.[0]).toMatch(/WHERE m\.organization_id=\$1 AND m\.id=\$2/);
  });
  it('pages inboxes in PostgreSQL with a bounded keyset cursor, including archived filtering', async () => {
    const older = 'f1654439-24f2-4cde-927a-e11754028789';
    const oldest = 'fb3b1266-8e55-46d8-9d61-f3aba8931086';
    const row = (channelId: string, updatedAt: string) => ({
      id: channelId, organization_id: org, provider: 'BAILEYS', provider_account_id: account,
      instance_id: channelId, connection_id: null, name: 'Atendimento', instance_status: 'CONNECTED', meta_status: null,
      bot_public_id: null, bot_origin_reference: null, flow_published_version: null, flow_enabled: null,
      human_status: null, created_at: now, updated_at: updatedAt,
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row(id, '2030-01-03T12:00:00.000Z'), row(older, '2030-01-02T12:00:00.000Z'), row(oldest, now)] })
      .mockResolvedValueOnce({ rows: [row(oldest, now)] });
    const service = createChannelFacade({ instances: {} as InstanceService, meta: { start: vi.fn() },
      transact: async (_org, work) => work({ query } as never) });

    const first = await service.list(org, false, { pageSize: 2 });
    expect(first.data.map(channel => channel.id)).toEqual([id, older]);
    expect(first.nextCursor).toBeTruthy();
    expect(query.mock.calls[0]?.[0]).toMatch(/WHERE channel_rows\.archived_at IS NULL/);
    expect(query.mock.calls[0]?.[0]).toMatch(/LIMIT \$2/);
    expect(query.mock.calls[0]?.[1]).toEqual([org, 3]);

    const second = await service.list(org, false, { pageSize: 2, cursor: first.nextCursor });
    expect(second.data.map(channel => channel.id)).toEqual([oldest]);
    expect(second.nextCursor).toBeNull();
    expect(query.mock.calls[1]?.[0]).toMatch(/date_trunc\('milliseconds', channel_rows\.updated_at\) < \$2/);
    expect(query.mock.calls[1]?.[1]).toEqual([org, '2030-01-02T12:00:00.000Z', older, 3]);
  });
  it('shows the actual paused binding, inbox and masked observed identity', () => {
    expect(channelView({id,organization_id:org,provider:'BAILEYS',provider_account_id:account,
      instance_id:id,connection_id:null,name:'Comercial',instance_status:'CONNECTED',meta_status:null,
      bot_public_id:account,bot_origin_reference:AUTOMATION_ORIGIN,flow_published_version:null,flow_enabled:true,
      automation_binding_status:'PAUSED',automation_name:'Triagem',human_status:'READY',inbox_id:7,
      integration_id:account,inbox_name:'Comercial JRC',observed_last4:'1234',messaging_channel_id:id,
      created_at:now,updated_at:now})).toMatchObject({automationStatus:'PAUSED',automationName:'Triagem',
        identity:{maskedAddress:'****1234'},destination:{integrationId:account,inboxId:7,name:'Comercial JRC'}});
  });
  it('keeps transport, provider, automation and human service states independent', () => {
    expect(channelView({ id, organization_id: org, provider: 'BAILEYS', provider_account_id: account,
      instance_id: id, connection_id: null, messaging_channel_id:id, name: 'Atendimento', instance_status: 'CONNECTED', meta_status: null,
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
        messaging_channel_id:id, name: 'Atendimento', instance_status: 'CREATED', meta_status: null, bot_public_id: null, bot_origin_reference: null,
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
      messaging_channel_id:id, name: 'Atendimento', instance_status: 'CONNECTED', meta_status: null, bot_public_id: null, bot_origin_reference: null,
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

  function bindingFixture(access: { status: string; moduleEnabled: boolean } | null = { status: 'ACTIVE', moduleEnabled: true }) {
    const channelId = '3b5f2c8b-0b7b-47e0-bdc1-972f28ad16b3';
    const bindingId = 'b756303c-0f2d-4898-9a75-8a56ef66d120';
    const binding = { id: bindingId, organizationId: org, automationId: account, version: 2,
      channelId, humanDestinationId: null, status: 'ACTIVE' as const, revision: 1,
      createdAt: new Date(now), updatedAt: new Date(now) };
    const query = vi.fn(async (statement: string, params: readonly unknown[] = []) => {
      const sql = statement.replace(/\s+/g, ' ').trim();
      expect(params[0]).toBe(org);
      if (sql.includes('UNION ALL')) return { rows: [{
        id, organization_id: org, provider: 'BAILEYS', provider_account_id: account, instance_id: id,
        connection_id: null, messaging_channel_id: channelId, name: 'Atendimento', instance_status: 'CONNECTED',
        meta_status: null, bot_public_id: null, bot_origin_reference: null, flow_published_version: null,
        flow_enabled: true, human_status: null, created_at: now, updated_at: now,
      }] };
      if (/^SELECT id FROM messaging_channels WHERE organization_id=\$1 AND instance_id=\$2$/i.test(sql)) {
        expect(params).toEqual([org, id]); return { rows: [{ id: channelId }] };
      }
      if (/^select pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
      if (/^select tenant_is_active\(/i.test(sql)) return { rows: [{ active: access?.status === 'ACTIVE' }] };
      if (/^select o.status,coalesce\(f.enabled,false\)/i.test(sql)) return { rows: access ? [access] : [] };
      if (/^SELECT id FROM messaging_channels WHERE organization_id=\$1 AND id=\$2 FOR SHARE$/i.test(sql)) {
        expect(params).toEqual([org, channelId]); return { rows: [{ id: channelId }] };
      }
      if (/^select /i.test(sql) && /FROM automation_bindings/i.test(sql)) {
        expect(params).toEqual([org, channelId]); return { rows: [binding] };
      }
      if (/^select revision from attendance_owners/i.test(sql)) {
        expect(params).toEqual([org, channelId]); return { rows: [{ revision: 8 }] };
      }
      throw new Error(`Unexpected facade query: ${sql}`);
    });
    const transaction = { query } as unknown as TenantTransaction;
    const service = createChannelFacade({ instances: {} as InstanceService, meta: { start: vi.fn() },
      transact: async (_org, work) => { expect(_org).toBe(org); return work(transaction); } });
    return { service, query, transaction, binding, channelId };
  }

  it('delegates binding to the canonical owner authority with the exact channel and revision', async () => {
    const f = bindingFixture();
    const transition = vi.spyOn(ownership, 'transitionChannelOwner')
      .mockResolvedValue({ binding: f.binding, ownerRevision: 8, changed: true });
    await expect(f.service.bindAutomation(org, id, { automationId: account, version: 2, expectedOwnerRevision: 7 }))
      .resolves.toMatchObject({ binding: { id: f.binding.id, automationId: account, version: 2, channelId: f.channelId }, ownerRevision: 8 });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(f.transaction, org, {
      automationId: account, version: 2, expectedOwnerRevision: 7, channelId: f.channelId,
      botPublicId: account, botOriginReference: AUTOMATION_ORIGIN,
    });
    await expect(f.service.getAutomation(org, id)).resolves.toMatchObject({ binding: { id: f.binding.id }, ownerRevision: 8 });
    // The facade must not implement a competing binding writer itself.
    expect(f.query.mock.calls.some(([sql]) => /^\s*(insert|update|delete)\b/i.test(sql))).toBe(false);
  });

  it.each([
    { access: null, code: 'ORGANIZATION_NOT_ACTIVE' },
    { access: { status: 'DISABLED', moduleEnabled: true }, code: 'ORGANIZATION_NOT_ACTIVE' },
    { access: { status: 'ACTIVE', moduleEnabled: false }, code: 'AUTOMATION_MODULE_DISABLED' },
  ])('denies $code inside the transaction before ownership mutation', async ({ access, code }) => {
    const f = bindingFixture(access);
    const transition = vi.spyOn(ownership, 'transitionChannelOwner');
    await expect(f.service.bindAutomation(org, id, { automationId: account, expectedOwnerRevision: 7 }))
      .rejects.toMatchObject({ code, status: 403 });
    expect(transition).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => /^\s*(insert|update|delete)\b/i.test(sql))).toBe(false);
  });

  it('propagates an owner revision conflict instead of replacing a competing binding', async () => {
    const f = bindingFixture();
    const conflict = new ChannelFacadeError('ATTENDANCE_OWNER_CHANGED', 409);
    const transition = vi.spyOn(ownership, 'transitionChannelOwner').mockRejectedValue(conflict);
    await expect(f.service.bindAutomation(org, id, { automationId: account, expectedOwnerRevision: 7 })).rejects.toBe(conflict);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.some(([sql]) => /^\s*(insert|update|delete)\b/i.test(sql))).toBe(false);
  });
});
