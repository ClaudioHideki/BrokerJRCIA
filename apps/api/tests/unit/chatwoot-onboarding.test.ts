import { expect, it } from 'vitest';
import { OnboardingInputSchema } from '@jrc/contracts';
const existing = { name: 'Comercial', source: { kind: 'EXISTING', instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, agentIds: [1], replaceExistingWebhook: false };
it('requires a provider account for a new instance and rejects arbitrary tenant/account/role fields', () => {
  expect(OnboardingInputSchema.safeParse(existing).success).toBe(true);
  expect(OnboardingInputSchema.safeParse({ ...existing, source: { kind: 'NEW', instanceName: 'Comercial' } }).success).toBe(false);
  for (const extra of [{ organizationId: 'other' }, { accountId: 9 }, { role: 'OWNER' }, { token: 'synthetic' }])
    expect(OnboardingInputSchema.safeParse({ ...existing, ...extra }).success).toBe(false);
});
it('requires explicit webhook replacement and uses bounded unique agent IDs', () => {
  expect(OnboardingInputSchema.safeParse({ ...existing, replaceExistingWebhook: undefined }).success).toBe(false);
  expect(OnboardingInputSchema.safeParse({ ...existing, agentIds: [1, 1] }).success).toBe(false);
  expect(OnboardingInputSchema.safeParse({ ...existing, agentIds: [-1] }).success).toBe(false);
});
