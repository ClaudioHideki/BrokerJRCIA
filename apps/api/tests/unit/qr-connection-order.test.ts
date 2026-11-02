import { describe, expect, it } from 'vitest';
import { shouldAcceptConnectionFact } from '../../src/modules/messaging/qr-connection-order.js';
import { createQrMessagingService } from '../../src/modules/messaging/qr-service.js';
import { instances, providerAccounts } from '../../src/db/schema.js';

const time = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
describe('QR connection source watermark', () => {
  it('declares the watermark on instances, matching the additive migration', () => {
    expect(instances).toHaveProperty('connectionObservedAt');
    expect(providerAccounts).not.toHaveProperty('connectionObservedAt');
  });
  it('locks the connection instance before fleet authority can acquire an instance SHARE lock', async () => {
    let exclusive = false;
    const tx = { query: async (sql: string) => {
      if (/FROM instances[\s\S]*FOR UPDATE/iu.test(sql)) exclusive = true;
      return { rows: [{ upstream_instance_key: 'synthetic-engine' }], rowCount: 1 };
    } };
    const service = createQrMessagingService({ baseUrl: 'https://engine.example.test', apiKey: 'synthetic',
      webhookOrigin: 'https://broker.example.test', signingKey: 'synthetic-signing-key'.repeat(3),
      resolveChannel: async () => ({ organizationId: 'synthetic-org', instanceId: 'synthetic-instance' }),
      transact: async (_org, work) => work(tx as never),
      fleet: { capture: async () => ({}), webhook: async () => ({ token: 'synthetic-webhook', assert: async () => {
        if (!exclusive) throw new Error('INSTANCE_SHARE_UPGRADE_RISK');
        throw new Error('AUTHORITY_AFTER_EXCLUSIVE_LOCK');
      } }) } as never,
    });
    await expect(service.ingest('synthetic-channel', 'Bearer synthetic-webhook', {
      event: 'connection.update', instance: 'synthetic-engine', data: { state: 'close' },
    })).rejects.toThrow('AUTHORITY_AFTER_EXCLUSIVE_LOCK');
  });
  it('refuses old and equal timestamps before status or identity can change', () => {
    for (const timestamp of [time(9), time(10), undefined]) {
      expect(shouldAcceptConnectionFact({ observedAt: time(10), fingerprint: 'current' }, { observedAt: timestamp, fingerprint: 'current' })).toBe(false);
    }
  });
  it('allows newer source facts and initial timestamped facts', () => {
    expect(shouldAcceptConnectionFact({ observedAt: time(10), fingerprint: 'current' }, { observedAt: time(11), fingerprint: 'current' })).toBe(true);
    expect(shouldAcceptConnectionFact({ observedAt: null, fingerprint: 'current' }, { observedAt: time(1), fingerprint: 'current' })).toBe(true);
  });
  it('preserves legacy arrival order only before a watermark exists', () => {
    expect(shouldAcceptConnectionFact({ observedAt: null, fingerprint: null }, { fingerprint: 'current' })).toBe(true);
    expect(shouldAcceptConnectionFact({ observedAt: null, fingerprint: 'current' }, { fingerprint: 'current' })).toBe(true);
  });
  it('starts a new clock domain only for a newly authenticated binding', () => {
    expect(shouldAcceptConnectionFact({ observedAt: time(10), fingerprint: 'old-engine' }, { observedAt: time(1), fingerprint: 'current' })).toBe(true);
  });
});
