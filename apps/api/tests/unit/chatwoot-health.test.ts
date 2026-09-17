import { expect, it } from 'vitest';
import { deriveTransportStatus } from '../../src/modules/integrations/chatwoot-health.js';
const confirmed = { integrationReady: true, connected: true, callbackVerified: true, recentInbound: true, recentOutbound: true, activeFailure: false };
it('requires all evidence and makes active failure prevail over old success', () => {
  expect(deriveTransportStatus(confirmed)).toBe('OPERATIONAL');
  for (const key of ['integrationReady', 'connected', 'callbackVerified', 'recentInbound', 'recentOutbound'])
    expect(deriveTransportStatus({ ...confirmed, [key]: false })).toBe('UNVERIFIED');
  expect(deriveTransportStatus({ ...confirmed, activeFailure: true })).toBe('DEGRADED');
});
