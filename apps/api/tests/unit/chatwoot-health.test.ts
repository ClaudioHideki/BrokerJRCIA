import { expect, it } from 'vitest';
import { deriveTransportStatus, connectionIdentityFields, type HealthRow } from '../../src/modules/integrations/chatwoot-health.js';
const confirmed = { integrationReady: true, connected: true, callbackVerified: true, recentInbound: true, recentOutbound: true, activeFailure: false };
it('requires all evidence and makes active failure prevail over old success', () => {
  expect(deriveTransportStatus(confirmed)).toBe('OPERATIONAL');
  for (const key of ['integrationReady', 'connected', 'callbackVerified', 'recentInbound', 'recentOutbound'])
    expect(deriveTransportStatus({ ...confirmed, [key]: false })).toBe('UNVERIFIED');
  expect(deriveTransportStatus({ ...confirmed, activeFailure: true })).toBe('DEGRADED');
});

it('exposes a live confirmed number only for the same identity revision, never a suffix or stale observation', () => {
  const row = { identity_revision: 4, approved_fingerprint: 'approved', observed_fingerprint: 'approved', observed_connected: true, identity_error: null } as HealthRow;
  expect(connectionIdentityFields(row, { revision: 4, phone: '5521988882000' })).toEqual({ phoneNumber: '+5521988882000', connectedAt: null });
  expect(connectionIdentityFields(row, { revision: 3, phone: '5521988882000' }).phoneNumber).toBeNull();
  expect(connectionIdentityFields({ ...row, observed_fingerprint: 'different' }, { revision: 4, phone: '5521988882000' }).phoneNumber).toBeNull();
  expect(connectionIdentityFields(row, undefined).phoneNumber).toBeNull();
  expect(connectionIdentityFields(row, { revision: 4, phone: '2000' }).phoneNumber).toBeNull();
});
