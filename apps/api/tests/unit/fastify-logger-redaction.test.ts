import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

describe('logger Fastify', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('constrói internamente o logger seguro e remove dados sensíveis de requests e erros', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const app = buildApp({ loggerDestination: sink, nodeEnv: 'test' });
    apps.push(app);

    app.get('/logger-canary', async (request) => {
      request.log.info({
        requestId: 'safe-request-id',
        nested: {
          authorization: 'authorization-canary',
          cookie: 'cookie-canary',
          'set-cookie': 'set-cookie-canary',
          'x-csrf-token': 'csrf-token-canary',
          'x-jrc-api-key': 'jrc-api-key-canary',
          apikey: 'provider-api-key-canary',
          deeper: {
            password: 'password-canary',
            jwtSecret: 'jwt-secret-canary',
            accessToken: 'access-token-canary',
            refreshToken: 'refresh-token-canary',
            refreshTokenHashSecret: 'refresh-hash-canary',
            selectionToken: 'selection-token-canary',
            selectionTokenHashSecret: 'selection-hash-canary',
            evolutionApiKey: 'evolution-key-canary',
            providerCredential: 'provider-credential-canary',
            qrCode: 'qr-code-canary',
            pairingCode: 'pairing-code-canary',
            phone: 'phone-canary',
            telephone: 'telephone-canary',
          },
        },
        auth: { body: 'auth-body-canary' },
        apiKey: { body: 'api-key-body-canary' },
        challenge: { body: 'challenge-body-canary' },
        upstream: {
          body: 'upstream-body-canary',
          response: { payload: 'upstream-response-canary' },
        },
      }, 'safe-log-event');

      throw Object.assign(new Error('external-error-canary'), {
        code: 'SAFE_EXTERNAL_ERROR',
        stack: 'external-stack-canary',
      });
    });

    await app.inject({
      method: 'GET',
      url: '/logger-canary?token=query-string-canary',
      headers: {
        authorization: 'Bearer request-authorization-canary',
        cookie: 'session=request-cookie-canary',
        'x-csrf-token': 'request-csrf-token-canary',
        'x-jrc-api-key': 'request-api-key-canary',
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const output = chunks.join('');
    for (const canary of [
      'authorization-canary',
      'cookie-canary',
      'set-cookie-canary',
      'csrf-token-canary',
      'jrc-api-key-canary',
      'provider-api-key-canary',
      'password-canary',
      'jwt-secret-canary',
      'access-token-canary',
      'refresh-token-canary',
      'refresh-hash-canary',
      'selection-token-canary',
      'selection-hash-canary',
      'evolution-key-canary',
      'provider-credential-canary',
      'qr-code-canary',
      'pairing-code-canary',
      'phone-canary',
      'telephone-canary',
      'auth-body-canary',
      'api-key-body-canary',
      'challenge-body-canary',
      'upstream-body-canary',
      'upstream-response-canary',
      'query-string-canary',
      'request-authorization-canary',
      'request-cookie-canary',
      'request-csrf-token-canary',
      'request-api-key-canary',
      'external-error-canary',
      'external-stack-canary',
    ]) {
      expect(output).not.toContain(canary);
    }
    expect(output).toContain('safe-request-id');
    expect(output).toContain('safe-log-event');
    expect(output).toContain('/logger-canary');
    expect(output).toContain('SAFE_EXTERNAL_ERROR');
    expect(output).toContain('[REDACTED]');
  });
});
