import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    operationDeadline: Date;
    operationSignal: AbortSignal;
  }
}

export interface RequestContextOptions {
  now?: () => Date;
  timeoutMs?: number;
}

export async function registerRequestContext(
  app: FastifyInstance,
  options: RequestContextOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Request context timeout must be a positive integer');
  }

  app.decorateRequest('operationDeadline');
  app.decorateRequest('operationSignal');
  app.addHook('onRequest', async (request, reply) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    request.operationDeadline = new Date(now().getTime() + timeoutMs);
    request.operationSignal = controller.signal;
    request.raw.once('aborted', () => controller.abort());
    reply.header('X-Request-Id', request.id);
    reply.raw.once('close', () => clearTimeout(timer));
  });
}
