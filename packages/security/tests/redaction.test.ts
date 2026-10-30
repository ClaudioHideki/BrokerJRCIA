import { describe, expect, it } from 'vitest';

import { redactSensitive } from '../src/index.js';

describe('redaction estrutural', () => {
  it('removes raw Evolution and message envelopes while keeping operational counters', () => {
    expect(redactSensitive({ event: 'messages.upsert', attempts: 3, data: { text: 'synthetic-payload' },
      sender: 'synthetic-sender', remoteJid: 'synthetic-jid', content: { text: 'synthetic-body' },
      message: 'synthetic-content', mediaBase64: 'synthetic-bytes', 'x-jrc-signature': 'synthetic-signature' }))
      .toEqual({ event: 'messages.upsert', attempts: 3, data: '[REDACTED]', sender: '[REDACTED]',
        remoteJid: '[REDACTED]', content: '[REDACTED]', message: '[REDACTED]', mediaBase64: '[REDACTED]',
        'x-jrc-signature': '[REDACTED]' });
  });
  it('does not turn arbitrary provider error strings into safe metadata', () => {
    expect(redactSensitive(Object.assign(new Error('synthetic-secret'), { name: 'synthetic-secret-name', code: 'Bearer synthetic-secret', statusCode: 9999 })))
      .toEqual({ type: 'Error' });
  });
  it('bounds circular array traversal in structured logs', () => {
    const values: unknown[] = []; values.push(values);
    expect(redactSensitive(values)).toEqual(['[Circular]']);
  });
  it('redacts password reset fields even outside a request body',()=>{
    expect(redactSensitive({password:'secret',passwordHash:'hash',confirmationToken:'proof',newPassword:'new',confirmPassword:'repeat'})).toEqual({password:'[REDACTED]',passwordHash:'[REDACTED]',confirmationToken:'[REDACTED]',newPassword:'[REDACTED]',confirmPassword:'[REDACTED]'});
  });
  it('remove o token do webhook presente na URL',()=>{expect(redactSensitive({req:{method:'POST',url:'/hooks/super-secret-token?debug=true'}})).toEqual({req:{method:'POST',url:'/hooks/[REDACTED]'}});});
  it('remove campos sensíveis recursivamente e preserva metadados seguros', () => {
    const redacted = redactSensitive({
      requestId: 'safe-request-id',
      password: 'password-canary',
      headers: {
        authorization: 'jwt-canary',
        cookie: 'cookie-canary',
        'set-cookie': 'set-cookie-canary',
        'x-csrf-token': 'csrf-canary',
        'x-jrc-api-key': 'api-key-canary',
      },
      nested: {
        pairingCode: 'pairing-canary',
        status: 'CONNECTED',
      },
    });

    expect(redacted).toEqual({
      requestId: 'safe-request-id',
      password: '[REDACTED]',
      headers: {
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        'set-cookie': '[REDACTED]',
        'x-csrf-token': '[REDACTED]',
        'x-jrc-api-key': '[REDACTED]',
      },
      nested: {
        pairingCode: '[REDACTED]',
        status: 'CONNECTED',
      },
    });
  });
});
