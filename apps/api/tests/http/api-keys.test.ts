import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { issueAccessToken } from '@jrc/security';

import { buildApp } from '../../src/app.js';
import type { ApiKeyRouteOptions } from '../../src/http/routes/api-keys.js';

const JWT_SECRET = 'jwt-secret-with-at-least-thirty-two-bytes';
const REQUEST_ID = '85a17103-9f0d-4d86-b55d-4184597e17a8';
const ORGANIZATION_ID = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const USER_ID = 'd8caa763-c0b0-40bd-94c5-dbb558a48729';
const API_KEY_ID = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const RAW_API_KEY = `jrc_${ORGANIZATION_ID.replaceAll('-', '')}-AQEBAQEBAQEB_${'A'.repeat(43)}`;
const CREATED_AT = '2030-01-01T12:00:00.000Z';

async function jwt(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER') {
  return issueAccessToken({ userId: USER_ID, organizationId: ORGANIZATION_ID, role }, JWT_SECRET);
}

function createHarness(overrides: Partial<ApiKeyRouteOptions> = {}, loggerDestination?: Writable) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const apiKeys: ApiKeyRouteOptions = {
    jwtSecret: JWT_SECRET,
    async authenticateApiKey(rawApiKey) {
      if (rawApiKey !== RAW_API_KEY) return null;
      return {
        apiKeyId: API_KEY_ID,
        organizationId: ORGANIZATION_ID,
        scopes: ['api_keys:manage'],
      };
    },
    async issueApiKey(context, input) {
      calls.push({ operation: 'issue', input: { context, input } });
      return {
        id: API_KEY_ID,
        name: input.name,
        prefix: `${ORGANIZATION_ID.replaceAll('-', '')}-AQEBAQEBAQEB`,
        secret: RAW_API_KEY,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        createdAt: CREATED_AT,
      };
    },
    async listApiKeys(context, input) {
      calls.push({ operation: 'list', input: { context, input } });
      return {
        data: [{
          id: API_KEY_ID,
          name: 'automation',
          prefix: `${ORGANIZATION_ID.replaceAll('-', '')}-AQEBAQEBAQEB`,
          scopes: ['instances:read'],
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: CREATED_AT,
        }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    },
    async revokeApiKey(context, id) {
      calls.push({ operation: 'revoke', input: { context, id } });
      return id === API_KEY_ID;
    },
    ...overrides,
  };
  const app = buildApp({
    nodeEnv: 'test',
    ...(loggerDestination ? { loggerDestination } : {}),
    passwordVerifierInitializer: async () => ({
      async verifyPasswordOrDummy() { return false; },
    }),
    apiKeys,
  });
  return { app, calls };
}

describe('rotas HTTP de API keys', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('declara no contrato OpenAPI todas as respostas implementadas', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    await harness.app.ready();
    const document = harness.app.swagger() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };

    expect(document.paths['/v1/api-keys']?.post?.responses).toHaveProperty('415');
    expect(document.paths['/v1/api-keys']?.get?.responses).toHaveProperty('404');
  });

  it.each(['OWNER', 'ADMIN'] as const)('permite que %s emita uma chave e mostra o segredo uma vez', async (role) => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${await jwt(role)}`,
        'x-request-id': REQUEST_ID,
      },
      payload: { name: 'automation', scopes: ['instances:read'], expiresAt: null },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(response.json()).toEqual(expect.objectContaining({ secret: RAW_API_KEY }));
    expect(JSON.stringify(harness.calls)).not.toContain(RAW_API_KEY);
  });

  it('aceita API key com o escopo de gerenciamento como única credencial', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/api-keys?limit=20',
      headers: { 'x-jrc-api-key': RAW_API_KEY, 'x-request-id': REQUEST_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().data[0]).not.toHaveProperty('secret');
    expect(response.json().data[0]).not.toHaveProperty('keyHmac');
    expect(harness.calls[0]).toEqual(expect.objectContaining({
      input: expect.objectContaining({
        context: expect.objectContaining({
          credentialKind: 'API_KEY',
          actorId: null,
          apiKeyId: API_KEY_ID,
        }),
      }),
    }));
  });

  it.each([
    ['JSON malformado', 'application/json', '{"name":', 400],
    ['media type não suportado', 'application/xml', '<name>unsafe</name>', 415],
  ])('preserva e sanitiza o status 4xx de %s', async (_label, contentType, payload, statusCode) => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${await jwt('OWNER')}`,
        'content-type': contentType,
        'x-request-id': REQUEST_ID,
      },
      payload,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      type: 'about:blank',
      title: 'Invalid request',
      status: statusCode,
      code: 'INVALID_REQUEST',
      requestId: REQUEST_ID,
      correlationId: REQUEST_ID,
    });
    expect(response.body).not.toContain('FST_ERR');
    expect(response.body).not.toContain(payload);
  });

  it.each([
    ['sem credencial', {}],
    ['Bearer inválido', { authorization: 'Bearer invalid' }],
    ['API key inválida', { 'x-jrc-api-key': `${RAW_API_KEY}x` }],
    ['duas credenciais', { authorization: 'Bearer invalid', 'x-jrc-api-key': RAW_API_KEY }],
  ])('rejeita %s com a mesma resposta genérica', async (_label, headers) => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { ...headers, 'x-request-id': REQUEST_ID },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      type: 'about:blank',
      title: 'Authentication failed',
      status: 401,
      code: 'INVALID_CREDENTIALS',
      requestId: REQUEST_ID,
      correlationId: REQUEST_ID,
    });
    expect(harness.calls).toEqual([]);
  });

  it.each(['OPERATOR', 'VIEWER'] as const)('nega gerenciamento a %s no backend', async (role) => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${await jwt(role)}`, 'x-request-id': REQUEST_ID },
      payload: { name: 'forbidden', scopes: ['instances:read'], expiresAt: null },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN', requestId: REQUEST_ID });
    expect(harness.calls).toEqual([]);
  });

  it('nega API key sem o escopo exigido', async () => {
    const harness = createHarness({
      async authenticateApiKey() {
        return { apiKeyId: API_KEY_ID, organizationId: ORGANIZATION_ID, scopes: ['instances:read'] };
      },
    });
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { 'x-jrc-api-key': RAW_API_KEY, 'x-request-id': REQUEST_ID },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('retorna 404 ao revogar ID não visível no tenant e não revela propriedade', async () => {
    const harness = createHarness({ async revokeApiKey() { return false; } });
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${API_KEY_ID}`,
      headers: { authorization: `Bearer ${await jwt('OWNER')}`, 'x-request-id': REQUEST_ID },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND', requestId: REQUEST_ID });
  });

  it('normaliza conflito de nome sem expor a constraint PostgreSQL', async () => {
    const harness = createHarness({
      async issueApiKey() {
        throw Object.assign(new Error('database detail must stay private'), {
          code: '23505',
          constraint: 'api_keys_org_name_unique',
        });
      },
    });
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${await jwt('OWNER')}`, 'x-request-id': REQUEST_ID },
      payload: { name: 'duplicate', scopes: ['instances:read'], expiresAt: null },
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).not.toContain('api_keys_org_name_unique');
    expect(response.body).not.toContain('database detail');
    expect(response.json()).toEqual({
      type: 'about:blank',
      title: 'API key already exists',
      status: 409,
      code: 'API_KEY_NAME_CONFLICT',
      requestId: REQUEST_ID,
      correlationId: REQUEST_ID,
    });
  });

  it('trata cursor de outro tenant como recurso opaco ausente e cursor malformado como 400', async () => {
    const harness = createHarness({
      async listApiKeys(_context, input) {
        const { ApiKeyServiceError } = await import('../../src/modules/api-keys/service.js');
        throw new ApiKeyServiceError(input.cursor === 'foreign' ? 'CURSOR_NOT_FOUND' : 'INVALID_CURSOR');
      },
    });
    apps.push(harness.app);

    const foreign = await harness.app.inject({
      method: 'GET',
      url: '/v1/api-keys?cursor=foreign',
      headers: { authorization: `Bearer ${await jwt('OWNER')}`, 'x-request-id': REQUEST_ID },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'NOT_FOUND', requestId: REQUEST_ID });

    const malformed = await harness.app.inject({
      method: 'GET',
      url: '/v1/api-keys?cursor=malformed',
      headers: { authorization: `Bearer ${await jwt('OWNER')}`, 'x-request-id': REQUEST_ID },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'INVALID_REQUEST', requestId: REQUEST_ID });
  });

  it.each([
    ['/v1/api-keys?limit=0', undefined],
    ['/v1/api-keys?limit=101', undefined],
    ['/v1/api-keys?unknown=value', undefined],
    [`/v1/api-keys/not-a-uuid`, 'DELETE'],
    ['/v1/api-keys', { name: '', scopes: ['instances:read'], expiresAt: null }],
    ['/v1/api-keys', { name: 'bad', scopes: ['unknown'], expiresAt: null }],
  ])('rejeita contrato inválido %s', async (url, payload) => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: payload === 'DELETE' ? 'DELETE' : payload ? 'POST' : 'GET',
      url,
      headers: { authorization: `Bearer ${await jwt('OWNER')}`, 'x-request-id': REQUEST_ID },
      ...(payload && payload !== 'DELETE' ? { payload } : {}),
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(harness.calls).toEqual([]);
  });

  it('não registra a API key bruta nem quando a autenticação lança erro', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); },
    });
    const harness = createHarness({
      async authenticateApiKey() { throw new Error(`unexpected ${RAW_API_KEY}`); },
    }, sink);
    apps.push(harness.app);
    await harness.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { 'x-jrc-api-key': RAW_API_KEY, 'x-request-id': REQUEST_ID },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(chunks.join('')).not.toContain(RAW_API_KEY);
  });
});
