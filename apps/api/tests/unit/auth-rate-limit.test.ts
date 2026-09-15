import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryRateLimitStore,
  assertRuntimeRateLimitStore,
} from '../../src/modules/auth/rate-limit/memory-store.js';
import {
  createRateLimitKeys,
  resolveClientIp,
} from '../../src/modules/auth/rate-limit/keys.js';
import { calculateProgressiveDelayMs } from '../../src/modules/auth/delay.js';
import {
  createRuntimeRedisClient,
  createRuntimeRedisClientOptions,
  RedisRateLimitStore,
} from '../../src/modules/auth/rate-limit/redis-store.js';

const IP_SECRET = 'ip-rate-limit-secret-with-at-least-32-bytes';
const IDENTITY_SECRET = 'identity-rate-secret-with-at-least-32-bytes';

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryRateLimitStore', () => {
  it('aplica limite e reinicia atomicamente depois do TTL', async () => {
    let nowMs = 10_000;
    const store = new MemoryRateLimitStore({ now: () => nowMs });

    expect(await store.consume(`ip:${'a'.repeat(64)}`, 2, 1_000)).toMatchObject({
      allowed: true,
      count: 1,
      remaining: 1,
      retryAfterMs: 1_000,
    });
    const concurrent = await Promise.all(Array.from(
      { length: 3 },
      async () => store.consume(`ip:${'a'.repeat(64)}`, 2, 1_000),
    ));
    expect(concurrent.map(({ count }) => count)).toEqual([2, 3, 4]);
    expect(concurrent.map(({ allowed }) => allowed)).toEqual([true, false, false]);

    nowMs += 1_001;
    expect(await store.consume(`ip:${'a'.repeat(64)}`, 2, 1_000)).toMatchObject({
      allowed: true,
      count: 1,
      remaining: 1,
      released: true,
    });

    const boundedKey = `identity:${'b'.repeat(64)}`;
    await store.consume(boundedKey, 1, 1_000);
    await store.consume(boundedKey, 1, 1_000);
    nowMs += 3_001;
    await expect(store.consume(boundedKey, 1, 1_000)).resolves.toMatchObject({
      allowed: true,
      released: false,
    });
  });

  it('é rejeitado fora de testes e nunca aceita chave em texto aberto', async () => {
    const store = new MemoryRateLimitStore();

    expect(() => assertRuntimeRateLimitStore(store, 'development')).toThrow(
      'MemoryRateLimitStore is restricted to tests',
    );
    expect(() => assertRuntimeRateLimitStore(store, 'production')).toThrow(
      'MemoryRateLimitStore is restricted to tests',
    );
    expect(() => assertRuntimeRateLimitStore(store, 'test')).not.toThrow();
    await expect(store.consume('identity:user@example.test', 2, 1_000)).rejects.toThrow(
      'Rate-limit key must contain only a scoped HMAC digest',
    );
  });
});

describe('RedisRateLimitStore fail-closed', () => {
  it('interrompe eval que nunca resolve dentro do deadline configurado', async () => {
    vi.useFakeTimers();
    const store = new RedisRateLimitStore({
      async eval() {
        return await new Promise<never>(() => undefined);
      },
    }, { deadlineMs: 25 });

    const result = expect(store.consume(`ip:${'d'.repeat(64)}`, 2, 1_000))
      .rejects.toThrow('Rate-limit store temporarily unavailable');
    await vi.advanceTimersByTimeAsync(25);

    await result;
  });

  it('normaliza perda de conexão sem propagar detalhes do socket', async () => {
    const store = new RedisRateLimitStore({
      async eval() {
        throw new Error('socket-lost-secret-canary');
      },
    }, { deadlineMs: 25 });

    const result = await store.consume(`identity:${'e'.repeat(64)}`, 2, 1_000)
      .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : 'unknown');

    expect(result).toBe('Rate-limit store temporarily unavailable');
    expect(result).not.toContain('socket-lost-secret-canary');
  });

  it('desabilita offline queue e limita conexão e reconexões no cliente runtime', async () => {
    const options = createRuntimeRedisClientOptions({
      url: 'redis://127.0.0.1:1',
      connectTimeoutMs: 75,
      reconnectMaxAttempts: 2,
      reconnectDelayMs: 10,
    });

    expect(options).toMatchObject({
      url: 'redis://127.0.0.1:1',
      disableOfflineQueue: true,
      socket: { connectTimeout: 75 },
    });
    expect(options.socket.reconnectStrategy(0)).toBe(10);
    expect(options.socket.reconnectStrategy(1)).toBe(10);
    expect(options.socket.reconnectStrategy(2)).toBe(false);

    const client = createRuntimeRedisClient({
      url: 'redis://127.0.0.1:1',
      connectTimeoutMs: 75,
      reconnectMaxAttempts: 0,
      reconnectDelayMs: 0,
    });
    try {
      const store = new RedisRateLimitStore(client, { deadlineMs: 25 });
      await expect(store.consume(`ip:${'f'.repeat(64)}`, 2, 1_000))
        .rejects.toThrow('Rate-limit store temporarily unavailable');
    } finally {
      if (client.isOpen) client.destroy();
    }
  });
});

describe('chaves de rate limit e proxies confiáveis', () => {
  it('persiste somente HMACs distintos de IP e identidade normalizada', () => {
    const keys = createRateLimitKeys({
      email: ' Owner@Example.TEST ',
      ipAddress: '2001:0db8:0:0:0:0:0:1',
      ipSecret: IP_SECRET,
      identitySecret: IDENTITY_SECRET,
    });

    expect(keys.identity).toMatch(/^identity:[a-f0-9]{64}$/);
    expect(keys.ip).toMatch(/^ip:[a-f0-9]{64}$/);
    expect(JSON.stringify(keys)).not.toContain('owner@example.test');
    expect(JSON.stringify(keys)).not.toContain('2001:db8::1');
    expect(keys.identity).not.toBe(keys.ip);
  });

  it('aceita X-Forwarded-For somente do proxy imediato na allowlist CIDR', () => {
    expect(resolveClientIp({
      remoteAddress: '10.0.0.8',
      forwardedFor: '198.51.100.25, 10.0.0.7',
      trustedProxyCidrs: ['10.0.0.0/24'],
    })).toBe('198.51.100.25');

    expect(resolveClientIp({
      remoteAddress: '203.0.113.8',
      forwardedFor: '198.51.100.25',
      trustedProxyCidrs: ['10.0.0.0/24'],
    })).toBe('203.0.113.8');

    expect(resolveClientIp({
      remoteAddress: '2001:db8:abcd::5',
      forwardedFor: '2001:db8:ffff::9',
      trustedProxyCidrs: ['2001:db8:abcd::/48'],
    })).toBe('2001:db8:ffff::9');
  });

  it('rejeita endereços encaminhados e CIDRs inválidos', () => {
    expect(() => resolveClientIp({
      remoteAddress: '10.0.0.8',
      forwardedFor: 'not-an-ip',
      trustedProxyCidrs: ['10.0.0.0/24'],
    })).toThrow('Invalid forwarded IP address');
    expect(() => resolveClientIp({
      remoteAddress: '10.0.0.8',
      trustedProxyCidrs: ['not-a-cidr'],
    })).toThrow('Invalid trusted proxy CIDR');
  });
});

describe('atraso progressivo', () => {
  it('cresce sem espera ativa e respeita o teto', () => {
    expect(calculateProgressiveDelayMs(1, { baseDelayMs: 100, maximumDelayMs: 450 })).toBe(0);
    expect(calculateProgressiveDelayMs(2, { baseDelayMs: 100, maximumDelayMs: 450 })).toBe(100);
    expect(calculateProgressiveDelayMs(4, { baseDelayMs: 100, maximumDelayMs: 450 })).toBe(400);
    expect(calculateProgressiveDelayMs(20, { baseDelayMs: 100, maximumDelayMs: 450 })).toBe(450);
  });
});
