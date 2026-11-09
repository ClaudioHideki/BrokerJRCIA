import { expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
const org = '11111111-1111-4111-8111-111111111111', channel = '22222222-2222-4222-8222-222222222222';
const integration = '33333333-3333-4333-8333-333333333333', canonical = '44444444-4444-4444-8444-444444444444', flow = '55555555-5555-4555-8555-555555555555';
it('reads live QR identity, exact JRC scope and published graph without issuing writes', async () => {
  const mod = await import('../../src/modules/guided-setup/native-snapshot.js').catch(() => null);
  expect(mod).not.toBeNull();
  const queries: string[] = [], scope = { organizationId: org, channelId: canonical, integrationId: integration, destinationRevision: 1, accountId: 7, inboxId: 8 };
  const catalog = { scope, credentialRevision: 1, agents: [{ id: 3, inboxMember: true }], teams: [] };
  const control = { status: vi.fn(async () => ({ instanceStatus: 'CONNECTED', identityStatus: 'CONFIRMED', identityApproved: true, identityRevision: 2 })) };
  const version = { automationId: flow, organizationId: org, version: 1, graph: welcomeFlow(), checksum: 'a'.repeat(64), runtimeStateVersion: 2 };
  const inspect = mod!.createNativeSetupInspector({
    transact: async (_org: string, work: any) => work({ query: async (sql: string) => { queries.push(sql);
      if (/chatwoot_connection_health/.test(sql)) return { rows: [{ approved_fingerprint: 'hash-one', observed_fingerprint: 'hash-one', identity_revision: 2, observed_connected: true, identity_error: null }] };
      if (/attendance_owners/.test(sql)) return { rows: [{ revision: 4, executor: 'NONE', automationId: null, version: null }] };
      throw new Error('Unexpected query: ' + sql);
    } }),
    channels: { get: async () => ({ id: channel, organizationId: org, provider: 'QR', messagingChannelId: canonical, ownerRevision: 4 }) } as never,
    automations: {} as never,
    chatwoot: { attendanceCatalog: async () => catalog, validateHumanDestination: async () => ({ scope, credentialRevision: 1 }),
      status: async () => ({ baseUrl: 'https://central.example.test', account: { accountId: 7, credentialVersion: 1, status: 'READY' },
        destination: { revision: 1 }, connections: [{ id: integration, channelId: canonical, inboxId: 8, status: 'READY' }] }) } as never,
    controlAuth: { authorize: async () => ({ organizationId: org }) } as never, control: control as never,
    repository: { getDefinition: async () => ({ id: flow, organizationId: org, lifecycleStatus: 'PUBLISHED' }), getVersion: async () => version } as never,
  });
  const result = await inspect({ organizationId: org, actorId: org }, { transport: 'QR', channelId: channel, integrationId: integration,
    automationId: flow, version: 1, agentIds: [3], humanTarget: { agentId: 3, teamId: null } });
  expect(control.status).toHaveBeenCalledTimes(1); expect(result.connected).toBe(true);
  expect(result.destination?.inboxId).toBe(8); expect(result.identity?.fingerprint).toBe('hash-one');
  expect(result.flow?.valid).toBe(true); expect(result.agents.targetValid).toBe(true);
  expect(queries.every(sql => /^\s*select/i.test(sql))).toBe(true);
});
it('refreshes Meta readiness while pinning stable authorized assets rather than a read-driven counter', async () => {
  const { createNativeSetupInspector } = await import('../../src/modules/guided-setup/native-snapshot.js');
  const refresh = vi.fn(async () => ({}));
  const inspect = createNativeSetupInspector({
    transact: async (_org, work) => work({ query: async (sql: string) => ({ rows: /attendance_owners/u.test(sql) ? []
      : [{ status: 'READY', live: true, fingerprint: 'authorized-meta-asset-hash', graphVersion: 'v24.0' }] }) } as never),
    channels: { get: async () => ({ organizationId: org, provider: 'META', messagingChannelId: canonical, providerReference: { connectionId: channel } }) } as never,
    automations: {} as never, meta: { refresh } as never,
  });
  const selection = { transport: 'META' as const, channelId: channel };
  const first = await inspect({ organizationId: org, actorId: org }, selection), second = await inspect({ organizationId: org, actorId: org }, selection);
  expect(refresh).toHaveBeenCalledTimes(2); expect(first.connected).toBe(true); expect(first.identity).toEqual(second.identity);
  expect(first.identity).toEqual({ fingerprint: 'authorized-meta-asset-hash', revision: 'v24.0', confirmed: true });
});
