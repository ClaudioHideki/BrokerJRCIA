import { expect, it } from 'vitest';
const scope = { executionId: '11111111-1111-4111-8111-111111111111', fingerprint: 'a'.repeat(64), provider: 'QR' as const };
const evidence = () => ({ scopeMatches: true, entryReceived: true, selectionsReceived: true, botDelivered: true,
  mirrorConfirmed: true, handoffConfirmed: true, humanPaused: true, unresolvedEffects: false });
async function implementation() {
  const mod = await import('../../src/modules/guided-setup/proof.js').catch(() => null);
  expect(mod, 'native execution proof must exist').not.toBeNull(); return mod!;
}
it('requires delivery, JRC mirror, confirmed handoff and human pause, rather than a queued send', async () => {
  const { evaluateSetupProof } = await implementation();
  expect(evaluateSetupProof(scope, evidence()).passed).toBe(true);
  for (const field of ['scopeMatches', 'entryReceived', 'selectionsReceived', 'botDelivered', 'mirrorConfirmed', 'handoffConfirmed', 'humanPaused'] as const)
    expect(evaluateSetupProof(scope, { ...evidence(), [field]: false }).passed).toBe(false);
  expect(evaluateSetupProof(scope, { ...evidence(), unresolvedEffects: true }).passed).toBe(false);
});
it('keeps Meta and QR proofs separate and exposes no conversation content', async () => {
  const { evaluateSetupProof } = await implementation();
  const result = evaluateSetupProof({ ...scope, provider: 'META' }, evidence());
  expect(result.provider).toBe('META'); expect(result.source).toBe('NATIVE_RUNTIME');
  expect(result).not.toHaveProperty('messages'); expect(result).not.toHaveProperty('phone');
});
