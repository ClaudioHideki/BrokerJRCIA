import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  META_WEBHOOK_MAX_BODY_BYTES,
  verifyMetaWebhookChallenge,
  verifyMetaWebhookSignature,
} from '@jrc/providers';

export interface MetaWebhookPayload extends Record<string, unknown> {
  object: 'whatsapp_business_account';
}

export interface MetaWebhookRouteOptions {
  appSecret: string;
  verifyToken: string;
  ingest(payload: MetaWebhookPayload): Promise<void>;
}

function isValidServerSecret(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isMetaPayload(value: unknown): value is MetaWebhookPayload {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'object' in value
    && value.object === 'whatsapp_business_account';
}

function genericError(reply: FastifyReply, status: 400 | 401 | 403 | 415 | 503, code: string) {
  return reply.code(status).type('application/json').send({ code });
}

function decodeJson(rawBody: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  return JSON.parse(text) as unknown;
}

export async function registerMetaWebhookRoutes(
  app: FastifyInstance,
  options: MetaWebhookRouteOptions,
): Promise<void> {
  if (
    !isValidServerSecret(options.appSecret)
    || !isValidServerSecret(options.verifyToken)
    || typeof options.ingest !== 'function'
  ) {
    throw new Error('INVALID_META_WEBHOOK_CONFIGURATION');
  }

  // The raw parser is encapsulated with these routes so authenticated JSON APIs
  // continue receiving Fastify's ordinary parsed JSON bodies.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: META_WEBHOOK_MAX_BODY_BYTES },
      (_request, body, done) => done(null, body),
    );

    scope.get('/v1/webhooks/meta', async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const challenge = verifyMetaWebhookChallenge({
        expectedVerifyToken: options.verifyToken,
        mode: query['hub.mode'],
        verifyToken: query['hub.verify_token'],
        challenge: query['hub.challenge'],
      });
      if (challenge === null) {
        return genericError(reply, 403, 'WEBHOOK_VERIFICATION_FAILED');
      }
      return reply.code(200).type('text/plain; charset=utf-8').send(challenge);
    });

    scope.post<{ Body: Buffer }>('/v1/webhooks/meta', async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return genericError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE');
      }
      const signature = request.headers['x-hub-signature-256'];
      if (!verifyMetaWebhookSignature({
        appSecret: options.appSecret,
        rawBody: request.body,
        signature: typeof signature === 'string' ? signature : undefined,
      })) {
        return genericError(reply, 401, 'INVALID_WEBHOOK_SIGNATURE');
      }

      let payload: unknown;
      try {
        payload = decodeJson(request.body);
      } catch {
        return genericError(reply, 400, 'INVALID_WEBHOOK_PAYLOAD');
      }
      if (!isMetaPayload(payload)) {
        return genericError(reply, 400, 'INVALID_WEBHOOK_PAYLOAD');
      }

      try {
        await options.ingest(payload);
      } catch {
        return genericError(reply, 503, 'WEBHOOK_INGESTION_UNAVAILABLE');
      }
      return reply.code(200).send({ status: 'accepted' });
    });
  });
}
