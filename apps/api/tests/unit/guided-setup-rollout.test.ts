import { expect, it } from 'vitest';
it('requires explicit generic rollout or an exact tenant allowlist', async () => {
  const mod = await import('../../src/modules/guided-setup/rollout.js').catch(() => null);
  expect(mod).not.toBeNull();
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  expect(mod!.guidedSetupRollout(undefined)(first)).toBe(false);
  expect(mod!.guidedSetupRollout(first)(first)).toBe(true);
  expect(mod!.guidedSetupRollout(first)(second)).toBe(false);
  expect(mod!.guidedSetupRollout('all')(second)).toBe(true);
  expect(() => mod!.guidedSetupRollout('true')).toThrow();
});
