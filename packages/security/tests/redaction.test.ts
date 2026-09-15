import { describe, expect, it } from 'vitest';

import { redactSensitive } from '../src/index.js';

describe('redaction estrutural', () => {
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
