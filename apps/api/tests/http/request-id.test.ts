import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

const VALID_REQUEST_ID = '2cbb143f-7ee3-448b-8041-9be6bcb94aac';

describe('X-Request-Id', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('preserva UUID válido em qualquer resposta', async () => {
    const app = buildApp({ nodeEnv: 'test' });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': VALID_REQUEST_ID.toUpperCase() },
    });

    expect(response.headers['x-request-id']).toBe(VALID_REQUEST_ID);
  });

  it('substitui valor inválido por UUID gerado pelo servidor', async () => {
    const app = buildApp({ nodeEnv: 'test' });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: { 'x-request-id': 'tenant@example.test' },
    });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(response.headers['x-request-id']).not.toBe('tenant@example.test');
  });

  it('usa o mesmo UUID como requestId e correlationId em respostas de erro', async () => {
    const app = buildApp({ nodeEnv: 'test' });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: { 'x-request-id': VALID_REQUEST_ID },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      requestId: VALID_REQUEST_ID,
      correlationId: VALID_REQUEST_ID,
    });
  });
});
