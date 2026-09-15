import { describe, expect, it } from 'vitest';

import { assertNoViteClientEnvironment } from './build-security.js';

describe('fronteira de variáveis do build web', () => {
  it.each([
    'VITE_API_KEY',
    'VITE_EVOLUTION_BASE_URL',
    'VITE_JWT_SECRET',
    'VITE_PUBLIC_API_URL',
  ])('rejeita %s porque a console usa somente URLs relativas', (name) => {
    expect(() => assertNoViteClientEnvironment({ [name]: 'canary-value' }))
      .toThrow(`Client-exposed Vite environment variable is forbidden: ${name}`);
  });

  it('aceita somente a configuração server-side do proxy de desenvolvimento', () => {
    expect(() => assertNoViteClientEnvironment({
      JRC_API_PROXY_TARGET: 'http://127.0.0.1:3310',
      NODE_ENV: 'test',
    })).not.toThrow();
  });
});
