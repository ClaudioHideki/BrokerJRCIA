import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { createPairActionStore } from '../../src/modules/integrations/chatwoot-pair-action-store.js';

describe('ephemeral pair challenge with Redis', () => {
  let client: RedisClientType;
  const keys = new Set<string>();
  const encryptionKey = Buffer.alloc(32, 33).toString('base64');
  const binding = { organizationId: randomUUID(), integrationId: randomUUID(), operationId: randomUUID() };

  beforeAll(async () => {
    client = createClient({ url: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379' });
    await client.connect();
  });
  afterAll(async () => {
    if (client?.isOpen) {
      if (keys.size) await client.del([...keys]);
      await client.quit();
    }
  });

  function store() {
    return createPairActionStore({ encryptionKey, client: {
      async set(key, value, options) { keys.add(key); return client.set(key, value, options); },
      async getDel(key) { return client.getDel(key); },
    } });
  }

  it('consumes one encrypted QR atomically across concurrent readers and isolates every binding', async () => {
    const cache = store();
    const action = { type: 'QR_CODE' as const, encoding: 'BASE64' as const,
      value: 'synthetic-real-redis-qr', expiresAt: new Date(Date.now() + 10_000).toISOString() };
    await cache.save({ ...binding, action });
    const key = [...keys][0]!;
    expect(key).not.toContain(binding.organizationId);
    expect(await client.get(key)).not.toContain(action.value);
    expect(await client.pTTL(key)).toBeGreaterThan(0);
    expect(await client.pTTL(key)).toBeLessThanOrEqual(10_000);
    expect(await cache.take({ ...binding, organizationId: randomUUID() })).toBeNull();
    expect(await cache.take({ ...binding, integrationId: randomUUID() })).toBeNull();
    expect(await cache.take({ ...binding, operationId: randomUUID() })).toBeNull();
    const received = await Promise.all([cache.take(binding), cache.take(binding)]);
    expect(received.filter(Boolean)).toEqual([action]);
    expect(received.filter(value => value === null)).toHaveLength(1);
    expect(await client.get(key)).toBeNull();
  });

  it('expires a challenge before the provider expiry when Redis TTL elapses', async () => {
    const cache = store();
    const scoped = { ...binding, operationId: randomUUID() };
    const action = { type: 'PAIRING_CODE' as const, code: 'SYNTHETIC',
      expiresAt: new Date(Date.now() + 1_000).toISOString() };
    await cache.save({ ...scoped, action });
    const key = [...keys].at(-1)!;
    expect(await client.pTTL(key)).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(await cache.take(scoped)).toBeNull();
    expect(await client.get(key)).toBeNull();
  });
});
