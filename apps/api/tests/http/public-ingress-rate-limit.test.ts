import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerPublicIngressRateLimit } from '../../src/http/plugins/public-ingress-rate-limit.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture(store = new MemoryRateLimitStore(), trustedProxyCidrs: string[] = []) {
  const app = Fastify(); apps.push(app);
  registerPublicIngressRateLimit(app, { store, secret: 'test-ingress-secret-at-least-32-bytes', trustedProxyCidrs, ipLimit: 2, resourceLimit: 2 });
  const receive = vi.fn(() => ({ accepted: true }));
  app.post('/hooks/:token', receive);
  app.post('/v1/integrations/chatwoot/:id/events', receive);
  app.get('/health', () => ({ ok: true }));
  return { app, receive };
}

it('blocks before parsing or database work and returns a retry interval', async () => {
  const { app, receive } = fixture();
  for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'POST', url: '/hooks/private-token' })).statusCode).toBe(200);
  const response = await app.inject({ method: 'POST', url: '/hooks/private-token', headers: { 'content-type': 'application/json' }, payload: '{broken' });
  expect(response.statusCode).toBe(429);
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  expect(receive).toHaveBeenCalledTimes(2);
  expect(response.body).not.toContain('private-token');
});

it('hashes tokens and addresses before sending keys to Redis-compatible storage', async () => {
  const store = new MemoryRateLimitStore(); const consume = vi.spyOn(store, 'consume');
  const { app } = fixture(store);
  await app.inject({ method: 'POST', url: '/hooks/private-token' });
  expect(consume).toHaveBeenCalledTimes(2);
  for (const [key] of consume.mock.calls) expect(key).toMatch(/^(ip|identity):[a-f0-9]{64}$/);
});

it('does not let untrusted forwarded headers bypass the source limit', async () => {
  const { app } = fixture();
  for (let i = 1; i <= 3; i++) {
    const response = await app.inject({ method: 'POST', url: `/hooks/token-${i}`, headers: { 'x-forwarded-for': `8.8.8.${i}` } });
    expect(response.statusCode).toBe(i === 3 ? 429 : 200);
  }
});

it('isolates route families and leaves health probes unaffected', async () => {
  const { app } = fixture();
  for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/hooks/token' });
  expect((await app.inject({ method: 'POST', url: '/v1/integrations/chatwoot/inbox/events' })).statusCode).toBe(200);
  expect((await app.inject('/health')).statusCode).toBe(200);
});

it('fails closed without calling the handler if the distributed store fails', async () => {
  const store = new MemoryRateLimitStore(); vi.spyOn(store, 'consume').mockRejectedValue(new Error('redis unavailable'));
  const { app, receive } = fixture(store);
  const response = await app.inject({ method: 'POST', url: '/hooks/token' });
  expect(response.statusCode).toBe(503); expect(receive).not.toHaveBeenCalled();
  expect(response.headers['retry-after']).toBeDefined();
});

it('shares a destination limit across trusted sources', async () => {
  const { app } = fixture(new MemoryRateLimitStore(), ['127.0.0.1/32']);
  for (let i = 1; i <= 3; i++) {
    const response = await app.inject({ method: 'POST', url: '/hooks/token', headers: { 'x-forwarded-for': `8.8.8.${i}` } });
    expect(response.statusCode).toBe(i === 3 ? 429 : 200);
  }
});
