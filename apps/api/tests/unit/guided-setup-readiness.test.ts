import { expect, it } from 'vitest';

const snapshot = () => ({
  organizationId: '11111111-1111-4111-8111-111111111111', provider: 'QR' as const,
  channelId: '22222222-2222-4222-8222-222222222222', publicChannelId: '33333333-3333-4333-8333-333333333333',
  connected: true, identity: { fingerprint: 'number-hash', revision: 2, confirmed: true },
  destination: { origin: 'https://central.example.test', accountId: 7, inboxId: 8, integrationId: '44444444-4444-4444-8444-444444444444',
    destinationRevision: 1, credentialRevision: 1, ready: true },
  agents: { selected: [3], eligible: [3], targetValid: true },
  flow: { id: '55555555-5555-4555-8555-555555555555', version: 1, checksum: 'a'.repeat(64),
    published: true, valid: true, dependencies: [{ id: '66666666-6666-4666-8666-666666666666', version: 2, checksum: 'b'.repeat(64) }] },
  owner: { revision: 4, automationId: null, version: null },
});
async function implementation() {
  const mod = await import('../../src/modules/guided-setup/readiness.js').catch(() => null);
  expect(mod, 'authoritative readiness evaluation must exist').not.toBeNull(); return mod!;
}
it('separates connection, destination, agents and published flow from physical proof', async () => {
  const { evaluateSetupReadiness } = await implementation(), ready = evaluateSetupReadiness(snapshot());
  expect(ready.readyForTest).toBe(true); expect(ready.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(ready).not.toHaveProperty('physicalTestPassed');
  for (const changed of [
    { ...snapshot(), connected: false }, { ...snapshot(), destination: null },
    { ...snapshot(), agents: { selected: [3], eligible: [9], targetValid: false } },
    { ...snapshot(), flow: { ...snapshot().flow, valid: false } },
  ]) expect(evaluateSetupReadiness(changed).readyForTest).toBe(false);
});
it('fingerprints every identity and destination revision, even when account IDs collide', async () => {
  const { evaluateSetupReadiness } = await implementation(), original = snapshot();
  const hash = evaluateSetupReadiness(original).fingerprint;
  for (const changed of [
    { ...original, organizationId: '77777777-7777-4777-8777-777777777777' },
    { ...original, identity: { ...original.identity, fingerprint: 'other-number-same-last-four' } },
    { ...original, identity: { ...original.identity, revision: 3 } },
    { ...original, provider: 'META' as const },
    { ...original, destination: { ...original.destination, origin: 'https://other.example.test' } },
    { ...original, destination: { ...original.destination, credentialRevision: 2 } },
    { ...original, destination: { ...original.destination, destinationRevision: 2 } },
    { ...original, destination: { ...original.destination, inboxId: 9 } },
    { ...original, flow: { ...original.flow, version: 2 } },
    { ...original, flow: { ...original.flow, dependencies: [{ ...original.flow.dependencies[0]!, checksum: 'c'.repeat(64) }] } },
  ]) expect(evaluateSetupReadiness(changed).fingerprint).not.toBe(hash);
});
it('tracks executor revision separately so the authorized test binding does not pretend configuration changed', async () => {
  const { evaluateSetupReadiness } = await implementation(), original = snapshot();
  const changed = evaluateSetupReadiness({ ...original, owner: { revision: 5, automationId: original.flow.id, version: 1 } });
  expect(changed.owner.revision).toBe(5);
  expect(changed.fingerprint)
    .toBe(evaluateSetupReadiness(original).fingerprint);
});
