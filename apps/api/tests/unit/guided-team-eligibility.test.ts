import { expect, it } from 'vitest';
it('accepts only team members who also belong to the selected inbox', async () => {
  const mod = await import('../../src/modules/guided-setup/team-eligibility.js').catch(() => null); expect(mod).not.toBeNull();
  expect(mod!.eligibleTeamAgentIds([{ id: 3 }, { id: 4 }, { id: 3 }], [{ id: 3, inboxMember: true }, { id: 4, inboxMember: false }])).toEqual([3]);
  expect(mod!.eligibleTeamAgentIds([], [{ id: 3, inboxMember: true }])).toEqual([]);
  expect(mod!.eligibleTeamAgentIds([{ id: 9 }], [{ id: 3, inboxMember: true }])).toEqual([]);
});
