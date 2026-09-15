import { createHmac } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { META_WEBHOOK_MAX_BODY_BYTES } from '@jrc/providers';

import { registerMetaWebhookRoutes } from '../../src/http/routes/meta-webhooks.js';

const appSecret = 'server-app-secret';
const verifyToken = 'server-verify-token';

function signature(rawBody: string | Buffer): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

async function createHarness(
  ingest: (payload: unknown) => Promise<void> = async () => undefined,
) {
  const app = Fastify({ logger: false });
  await registerMetaWebhookRoutes(app, { appSecret, verifyToken, ingest });
  return app;
}

describe('Meta webhook routes', () => {
  it('returns the exact challenge for a valid subscription verification', async () => {
    const app = await createHarness();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=123456`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('123456');
    expect(response.headers['content-type']).toContain('text/plain');
    await app.close();
  });

  it.each([
    `hub.mode=unsubscribe&hub.verify_token=${verifyToken}&hub.challenge=123`,
    'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123',
    `hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=`,
  ])('rejects an invalid subscription verification without leaking tokens: %s', async (query) => {
    const app = await createHarness();

    const response = await app.inject({ method: 'GET', url: `/v1/webhooks/meta?${query}` });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(verifyToken);
    expect(response.body).not.toContain('wrong');
    await app.close();
  });

  it('verifies exact raw bytes before parsing and passes the object to ingestion', async () => {
    const ingested: unknown[] = [];
    const app = await createHarness(async (payload) => { ingested.push(payload); });
    const rawBody = '{"object":"whatsapp_business_account", "entry":[]}';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-hub-signature-256': signature(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(ingested).toEqual([{ object: 'whatsapp_business_account', entry: [] }]);
    await app.close();
  });

  it('rejects a signature over reserialized JSON before ingestion', async () => {
    const ingest = vi.fn(async () => undefined);
    const app = await createHarness(ingest);
    const rawBody = '{"object":"whatsapp_business_account", "entry":[]}';
    const changedBytes = '{"object":"whatsapp_business_account","entry":[]}';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(changedBytes),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects correctly signed malformed JSON before ingestion', async () => {
    const ingest = vi.fn(async () => undefined);
    const app = await createHarness(ingest);
    const rawBody = '{"object":"whatsapp_business_account"';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a non-JSON content type before signature verification or ingestion', async () => {
    const ingest = vi.fn(async () => undefined);
    const app = await createHarness(ingest);
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'text/plain',
        'x-hub-signature-256': signature(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(415);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a correctly signed non-WhatsApp object at the boundary', async () => {
    const ingest = vi.fn(async () => undefined);
    const app = await createHarness(ingest);
    const rawBody = JSON.stringify({ object: 'page', entry: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it('waits for successful ingestion before acknowledging the webhook', async () => {
    let release: (() => void) | undefined;
    let ingestionStarted = false;
    const app = await createHarness(() => new Promise<void>((resolve) => {
      ingestionStarted = true;
      release = resolve;
    }));
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    let acknowledged = false;

    const responsePromise = app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(rawBody),
      },
      payload: rawBody,
    }).then((response) => {
      acknowledged = true;
      return response;
    });

    await vi.waitFor(() => expect(ingestionStarted).toBe(true));
    expect(acknowledged).toBe(false);
    release?.();
    expect((await responsePromise).statusCode).toBe(200);
    await app.close();
  });

  it('returns a generic 503 when durable ingestion fails', async () => {
    const app = await createHarness(async () => {
      throw new Error(`database error containing ${appSecret}`);
    });
    const rawBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { secretPayload: 'payload-canary' } }] }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(appSecret);
    expect(response.body).not.toContain('payload-canary');
    expect(response.body).not.toContain('database error');
    await app.close();
  });

  it('enforces the one-megabyte raw body limit before ingestion', async () => {
    const ingest = vi.fn(async () => undefined);
    const app = await createHarness(ingest);
    const rawBody = Buffer.alloc(META_WEBHOOK_MAX_BODY_BYTES + 1, 0x20);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(413);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the raw JSON parser scoped to the webhook routes', async () => {
    const app = await createHarness();
    app.post('/ordinary-json', async (request) => ({
      isBuffer: Buffer.isBuffer(request.body),
      body: request.body,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/ordinary-json',
      payload: { ordinary: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ isBuffer: false, body: { ordinary: true } });
    await app.close();
  });
});
