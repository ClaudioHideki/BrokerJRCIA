import { expect, it, vi } from 'vitest';

const org = '11111111-1111-4111-8111-111111111111', channelId = '22222222-2222-4222-8222-222222222222';
const integrationId = '33333333-3333-4333-8333-333333333333', messagingId = '44444444-4444-4444-8444-444444444444';
async function fixture() {
  const mod = await import('../../src/modules/guided-setup/native-reader.js').catch(() => null);
  expect(mod, 'native selection reader must exist').not.toBeNull();
  const catalog = { scope: { organizationId: org, channelId: messagingId, integrationId, accountId: 7, inboxId: 8 }, agents: [{ id: 3, inboxMember: true }] };
  const get = vi.fn(async (tenant: string) => {
    if (tenant !== org) throw new Error('CHANNEL_NOT_FOUND');
    return { id: channelId, organizationId: org, provider: 'QR', messagingChannelId: messagingId };
  });
  const reader = mod!.createNativeSetupReader({ transact: async () => { throw new Error('No store needed'); },
    channels: { get } as never, automations: { get: vi.fn() } as never,
    chatwoot: { attendanceCatalog: async () => catalog } as never });
  return { reader, catalog, get };
}
it('validates selected channel provider and the full tenant/channel/integration scope', async () => {
  const f = await fixture(), principal = { organizationId: org, actorId: org };
  await f.reader.validateSelection(principal, { transport: 'QR', channelId, integrationId, agentIds: [3] });
  await expect(f.reader.validateSelection(principal, { transport: 'META', channelId })).rejects.toThrow();
  f.catalog.scope.accountId = 9; // ID collision alone cannot compensate for a channel scope mismatch.
  f.catalog.scope.channelId = '55555555-5555-4555-8555-555555555555';
  await expect(f.reader.validateSelection(principal, { transport: 'QR', channelId, integrationId })).rejects.toThrow();
});
it('never accepts a channel or an agent absent from this tenant catalog', async () => {
  const f = await fixture();
  await expect(f.reader.validateSelection({ organizationId: '66666666-6666-4666-8666-666666666666', actorId: org }, { transport: 'QR', channelId }))
    .rejects.toThrow('CHANNEL_NOT_FOUND');
  await expect(f.reader.validateSelection({ organizationId: org, actorId: org }, { transport: 'QR', channelId, integrationId, agentIds: [99] }))
    .rejects.toThrow();
});
