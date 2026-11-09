import { expect, it, vi } from 'vitest';
const org = '11111111-1111-4111-8111-111111111111', channel = '22222222-2222-4222-8222-222222222222';
const flow = '33333333-3333-4333-8333-333333333333', integration = '44444444-4444-4444-8444-444444444444';
it('reads only native proof in the selected tenant, channel, version and JRC scope', async () => {
  const mod = await import('../../src/modules/guided-setup/native-proof.js').catch(() => null); expect(mod).not.toBeNull();
  const evidence = { scopeMatches: true, entryReceived: true, selectionsReceived: true, botDelivered: false,
    mirrorConfirmed: false, handoffConfirmed: true, humanPaused: true, unresolvedEffects: false };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('AS "integrationId"')) return { rows: [{ integrationId: integration, destinationRevision: 1, accountId: '7', inboxId: '8',
      connectionStatus: 'READY', accountStatus: 'READY', approvalStatus: 'APPROVED' }] };
    if (sql.includes('WITH selected')) return { rows: [{ executionId: org, ...evidence }] };
    throw new Error('Unexpected query');
  });
  const read = mod!.createNativeSetupProofReader({ transact: async (_org: string, work: any) => work({ query }),
    channels: { get: async () => ({ organizationId: org, messagingChannelId: channel }) } as never });
  const row = { organizationId: org, selection: { channelId: channel, integrationId: integration },
    testContext: { automationId: flow, version: 1, keyword: 'test-exclusive', startedAt: '2026-11-09T12:00:00.000Z', ownerRevision: 4 } } as never;
  const result = await read({ organizationId: org, actorId: org }, row, org);
  expect(result).toEqual({ executionId: org, evidence }); expect(result).not.toHaveProperty('messages');
  const sql = query.mock.calls.find(([value]) => value.includes('WITH selected'))![0];
  expect(sql).toContain('entry.event_key=e.trigger_event_key');
  expect(sql).not.toContain("e.input->>'text'");
  for (const marker of ['automation_outbox', 'messaging_messages', 'chatwoot_messages', 'attendance_handoff_operations', 'attendance_sessions', 'DELIVERED', 'HUMAN_ACTIVE']) expect(sql).toContain(marker);
  expect(query.mock.calls.every(([value]) => /^\s*(SELECT|WITH)/i.test(value))).toBe(true);
  await expect(read({ organizationId: channel, actorId: org }, row, org)).rejects.toMatchObject({ code: 'GUIDED_SETUP_SCOPE_MISMATCH' });
});
