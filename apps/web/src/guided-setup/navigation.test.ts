import { expect, it } from 'vitest';
it('retains only a safe guide return path and a bounded node identifier', async () => {
  const mod = await import('./navigation.js').catch(() => null);
  expect(mod).not.toBeNull();
  const id = '11111111-1111-4111-8111-111111111111';
  expect(mod!.guidedSetupNavigation(`?setup=${id}&node=handoff-1`)).toEqual({ returnPath: `/configuracao-guiada/${id}`, nodeId: 'handoff-1' });
  expect(mod!.guidedSetupNavigation('?setup=https://evil.test&node=' + 'a'.repeat(201))).toEqual({ returnPath: null, nodeId: null });
});
