import { it, expect } from 'vitest';
import { evaluateChatwootCapabilities } from '../../src/modules/integrations/chatwoot-compatibility.js';
it('distinguishes proven incompatibility from missing evidence and never promotes a profile response to signed transport', () => {
  const basic = { adminAccount: true, apiAccess: true, apiInbox: true, webhookSecret: true, signedCallback: false };
  expect(evaluateChatwootCapabilities(basic).state).toBe('UNVERIFIED');
  expect(evaluateChatwootCapabilities({ ...basic, webhookSecret: false }).state).toBe('UNSUPPORTED');
  expect(evaluateChatwootCapabilities({ ...basic, signedCallback: true }).state).toBe('READY');
  expect(evaluateChatwootCapabilities({ adminAccount: true, apiAccess: true }).state).toBe('UNVERIFIED');
  expect(evaluateChatwootCapabilities({ ...basic, apiAccess: false }).state).toBe('UNSUPPORTED');
});
