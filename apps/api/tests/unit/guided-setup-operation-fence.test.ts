import { expect, it, vi } from 'vitest';
const org = '11111111-1111-4111-8111-111111111111';
it('rejects an abandoned or expired guide lease before an owner mutation', async () => {
  const mod = await import('../../src/modules/guided-setup/native-owner.js').catch(() => null);
  expect(mod, 'native owner actions must fence the saved operation').not.toBeNull();
  for (const operation of [null, { leaseToken: 'other', leaseExpiresAt: Date.now() + 60000 }, { leaseToken: 'mine', leaseExpiresAt: 1 }]) {
    const query = vi.fn(async () => ({ rows: [{ data: { organizationId: org, operation } }] }));
    await expect(mod!.assertSetupOperation({ query } as never, org, org, 'mine')).rejects.toMatchObject({ code: 'GUIDED_SETUP_LEASE_LOST' });
    expect(query.mock.calls[0]?.[0]).toMatch(/FOR UPDATE/i);
  }
});
it('accepts only the matching current operation in the same organization', async () => {
  const { assertSetupOperation } = await import('../../src/modules/guided-setup/native-owner.js');
  await expect(assertSetupOperation({ query: async () => ({ rows: [{ data: { organizationId: org,
    operation: { leaseToken: 'mine', leaseExpiresAt: Date.now() + 60000 } } }] }) } as never, org, org, 'mine')).resolves.toBeUndefined();
});
