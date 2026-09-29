import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveClientIp } from '../../modules/auth/rate-limit/keys.js';
import type { RateLimitStore } from '../../modules/auth/rate-limit/store.js';

export interface PublicIngressRateLimitOptions {
  store: RateLimitStore;
  secret: string;
  trustedProxyCidrs: readonly string[];
  ipLimit: number;
  resourceLimit: number;
}

const PUBLIC_INGRESS_ROUTES = new Set([
  '/hooks/:token',
  '/v1/webhooks/whatsapp/:id',
  '/v1/webhooks/meta',
  '/v1/integrations/chatwoot/:id/events',
  '/v1/flows/chatwoot/:id/events',
]);

// Route templates avoid encoded-path bypasses. All stored identifiers are HMACs;
// the hook runs before body parsing and any credential or tenant database lookup.
export function registerPublicIngressRateLimit<Logger extends FastifyBaseLogger>(app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>, options: PublicIngressRateLimitOptions): void {
  if (Buffer.byteLength(options.secret) < 32) throw new Error('INGRESS_HMAC_SECRET_REQUIRED');
  const key = (scope: 'ip' | 'identity', family: string, value: string) =>
    `${scope}:${createHmac('sha256', options.secret).update(JSON.stringify(['public-ingress', family, value])).digest('hex')}`;
  app.addHook('onRequest', async (request, reply) => {
    const family = request.routeOptions.url;
    if (request.method !== 'POST' || !family || !PUBLIC_INGRESS_ROUTES.has(family)) return;
    let address: string;
    try {
      address = resolveClientIp({ remoteAddress: request.socket.remoteAddress ?? request.ip,
        ...(request.headers['x-forwarded-for'] ? { forwardedFor: request.headers['x-forwarded-for'] } : {}),
        trustedProxyCidrs: options.trustedProxyCidrs });
    } catch {
      return reply.code(400).send({ code: 'INVALID_SOURCE_ADDRESS', requestId: request.id });
    }
    const params = request.params as Record<string, string>;
    const resource = params.token ?? params.id;
    const limits: ReadonlyArray<readonly [string, number]> = [[key('ip', family, address), options.ipLimit],
      ...(resource ? [[key('identity', family, resource), options.resourceLimit] as const] : [])] as const;
    try {
      for (const [identifier, limit] of limits) {
        const decision = await options.store.consume(identifier, limit, 60_000);
        if (!decision.allowed) return reply.code(429)
          .header('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))))
          .send({ code: 'INGRESS_RATE_LIMITED', requestId: request.id });
      }
    } catch {
      request.log.warn({ code: 'INGRESS_RATE_LIMIT_UNAVAILABLE' }, 'Ingress rate-limit store unavailable');
      return reply.code(503).header('Retry-After', '5')
        .send({ code: 'INGRESS_RATE_LIMIT_UNAVAILABLE', requestId: request.id });
    }
  });
}
