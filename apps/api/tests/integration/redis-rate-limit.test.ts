import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';

import { RedisRateLimitStore } from '../../src/modules/auth/rate-limit/redis-store.js';

describe('RedisRateLimitStore com Redis real', () => {
  let client: RedisClientType;
  let prefix: string;

  beforeAll(async () => {
    client = createClient({ url: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379' });
    await client.connect();
    prefix = `jrc:test:auth-rate:${randomUUID()}:`;
  });

  afterAll(async () => {
    if (client?.isOpen) {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length > 0) await client.del(keys);
      await client.quit();
    }
  });

  it('incrementa concorrentemente sem perder contagens e fixa TTL no primeiro consumo', async () => {
    const store = new RedisRateLimitStore(client, { prefix });
    const key = `identity:${'b'.repeat(64)}`;

    const decisions = await Promise.all(Array.from(
      { length: 20 },
      async () => store.consume(key, 5, 5_000),
    ));

    expect(decisions.map(({ count }) => count).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 20 }, (_unused, index) => index + 1));
    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(5);
    const persistedTtl = await client.pTTL(`${prefix}${key}`);
    expect(persistedTtl).toBeGreaterThan(0);
    expect(persistedTtl).toBeLessThanOrEqual(5_000);
  });

  it('reinicia a janela depois do TTL real', async () => {
    const store = new RedisRateLimitStore(client, { prefix });
    const key = `ip:${'c'.repeat(64)}`;

    await expect(store.consume(key, 1, 100)).resolves.toMatchObject({ allowed: true, count: 1, released: false });
    await expect(store.consume(key, 1, 100)).resolves.toMatchObject({ allowed: false, count: 2 });
    const markerTtl = await client.pTTL(`${prefix}${key}:blocked`);
    expect(markerTtl).toBeGreaterThan(150);
    expect(markerTtl).toBeLessThanOrEqual(300);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(store.consume(key, 1, 100)).resolves.toMatchObject({ allowed: true, count: 1, released: true });
    await expect(client.exists(`${prefix}${key}:blocked`)).resolves.toBe(0);
  });
});
