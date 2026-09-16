import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import {
  createOpenApiDocument,
  serializeOpenApiDocument,
} from '../../src/http/openapi.js';

const EXPECTED_OPERATIONS = [
  'GET /v1/integrations/chatwoot/control/context', 'POST /v1/integrations/chatwoot/control-credentials',
  'PUT /v1/integrations/chatwoot/connections/{id}/operator-grants',
  'GET /v1/integrations/chatwoot/destination', 'PUT /v1/integrations/chatwoot/destination',
  'POST /v1/platform/organizations/{id}/chatwoot/destination/approve',
  'GET /v1/integrations/chatwoot', 'POST /v1/integrations/chatwoot/{id}/events',
  'PUT /v1/integrations/chatwoot/account', 'POST /v1/integrations/chatwoot/connections', 'PATCH /v1/integrations/chatwoot/connections/{id}',
  'GET /v1/integrations/chatwoot/connections/{id}/agents','POST /v1/integrations/chatwoot/connections/{id}/agents',
  'POST /v1/integrations/chatwoot/connections/{id}/reconcile','POST /v1/integrations/chatwoot/connections/{id}/retry',
  'GET /v1/integrations/chatwoot/inboxes','GET /v1/integrations/chatwoot/jobs','GET /v1/integrations/chatwoot/sources',
  'POST /v1/integrations/chatwoot/jobs/{id}/reconcile','POST /v1/integrations/chatwoot/jobs/{id}/retry',
  'POST /v1/messaging/channels/{id}/text','POST /v1/messaging/instances/{id}/activate','GET /v1/messaging/media/{id}','POST /v1/messaging/messages/{id}/retry',
  'GET /v1/platform/organizations/{id}/chatwoot','PUT /v1/platform/organizations/{id}/chatwoot/account',
  'POST /v1/platform/organizations/{id}/chatwoot/connections','PATCH /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}',
  'GET /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents','POST /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/agents',
  'POST /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/reconcile','POST /v1/platform/organizations/{id}/chatwoot/connections/{resourceId}/retry',
  'GET /v1/platform/organizations/{id}/chatwoot/inboxes','GET /v1/platform/organizations/{id}/chatwoot/jobs','GET /v1/platform/organizations/{id}/chatwoot/sources',
  'POST /v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/reconcile','POST /v1/platform/organizations/{id}/chatwoot/jobs/{resourceId}/retry',
  'POST /v1/platform/organizations/{id}/chatwoot/provision','POST /v1/platform/organizations/{id}/chatwoot/provision/reconcile','POST /v1/platform/organizations/{id}/chatwoot/provision/resume',
  'GET /v1/platform/auth/config', 'GET /v1/instances/{id}/workspace', 'PUT /v1/instances/{id}/settings',
  'POST /v1/platform/auth/login', 'GET /v1/platform/auth/session', 'POST /v1/platform/auth/logout',
  'GET /v1/platform/organizations', 'POST /v1/platform/organizations', 'PATCH /v1/platform/organizations/{id}',
  'GET /v1/platform/organizations/{id}/memberships', 'PUT /v1/platform/organizations/{id}/memberships',
  'GET /v1/platform/organizations/{id}/monitor', 'POST /v1/platform/organizations/{id}/support-acknowledgment',
  'GET /v1/meta-onboarding', 'POST /v1/meta-onboarding/start', 'POST /v1/meta-onboarding/complete',
  'POST /v1/meta-onboarding/{id}/refresh', 'POST /v1/meta-onboarding/{id}/register', 'POST /v1/meta-onboarding/{id}/revoke',
  'GET /v1/organization/operations',
  'GET /v1/organization/overview',
  'POST /v1/auth/login',
  'POST /v1/auth/select-organization',
  'POST /v1/auth/refresh',
  'POST /v1/auth/logout',
  'POST /v1/console/auth/select-organization',
  'POST /v1/console/auth/restore',
  'POST /v1/console/auth/switch-organization',
  'POST /v1/console/auth/logout',
  'POST /v1/api-keys',
  'GET /v1/api-keys',
  'DELETE /v1/api-keys/{id}',
  'GET /v1/provider-accounts',
  'POST /v1/instances',
  'GET /v1/instances',
  'GET /v1/instances/{id}',
  'POST /v1/instances/{id}/connect',
  'GET /v1/instances/{id}/status',
  'POST /v1/instances/{id}/disconnect',
  'GET /v1/messaging/channels',
  'GET /v1/messaging/channels/{id}/templates',
  'GET /v1/messaging/channels/{id}/conversations',
  'GET /v1/messaging/conversations/{id}/messages',
  'POST /v1/messaging/channels/{id}/messages',
  'PATCH /v1/messaging/conversations/{id}/mode',
  'PATCH /v1/messaging/channels/{id}/automation',
  'GET /v1/webhooks/meta',
  'POST /v1/webhooks/meta',
] as const;

function operations(document: Record<string, unknown>): string[] {
  const paths = document.paths as Record<string, Record<string, unknown>>;
  return Object.entries(paths)
    .flatMap(([path, methods]) => Object.keys(methods)
      .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
}

describe('OpenAPI público da JRC', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('documenta tenant e administração JRC sem expor operações internas do motor', async () => {
    const document = await createOpenApiDocument();
    const serialized = JSON.stringify(document);

    expect(operations(document as unknown as Record<string, unknown>)).toEqual(
      [...EXPECTED_OPERATIONS].sort(),
    );
    expect(document.paths).not.toHaveProperty('/v1/instances/{id}/deprovision');
    expect(serialized).not.toMatch(/Evolution|reconcileProvisioning|deprovisionInstance|lookupInstance/i);
  });

  it('declara autenticação, paginação, request id e respostas problem+json', async () => {
    const document = await createOpenApiDocument();
    const components = document.components as {
      securitySchemes?: Record<string, unknown>;
      schemas?: Record<string, unknown>;
    };
    const listInstances = document.paths['/v1/instances']?.get as {
      parameters?: Array<{ name?: string; schema?: { default?: number; maximum?: number } }>;
      responses?: Record<string, {
        content?: Record<string, unknown>;
        headers?: Record<string, unknown>;
      }>;
      security?: Array<Record<string, unknown>>;
    };

    expect(components.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      csrfHeaderAuth: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      jrcApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-JRC-API-Key' },
      refreshCookieAuth: { type: 'apiKey', in: 'cookie', name: '__Host-jrc_refresh' },
    });
    expect(listInstances.security).toEqual([{ bearerAuth: [] }, { jrcApiKeyAuth: [] }]);
    expect(listInstances.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'limit', schema: expect.objectContaining({ default: 20, maximum: 100 }) }),
      expect.objectContaining({ name: 'cursor' }),
    ]));
    expect(listInstances.responses?.['400']?.content).toHaveProperty('application/problem+json');
    expect(listInstances.responses?.['200']?.headers).toMatchObject({
      'Cache-Control': { $ref: '#/components/headers/CacheControl' },
      Pragma: { $ref: '#/components/headers/Pragma' },
    });
    expect(components.schemas).toHaveProperty('ProblemDetails');
    expect(listInstances.responses?.['400']?.content?.['application/problem+json'])
      .toMatchObject({ schema: { $ref: '#/components/schemas/ProblemDetails' } });
    expect(document.components?.headers).toHaveProperty('XRequestId');
    expect(document.paths['/v1/console/auth/select-organization']?.post?.security).toEqual([]);
    expect(document.paths['/v1/console/auth/restore']?.post?.security).toEqual([
      { refreshCookieAuth: [], csrfHeaderAuth: [] },
    ]);
    expect(document.paths['/v1/console/auth/switch-organization']?.post?.security).toEqual([
      { bearerAuth: [], refreshCookieAuth: [], csrfHeaderAuth: [] },
    ]);
    expect(document.paths['/v1/console/auth/logout']?.post?.security).toEqual([
      { refreshCookieAuth: [], csrfHeaderAuth: [] },
      {},
    ]);
    expect(document.paths['/v1/console/auth/switch-organization']?.post?.responses)
      .toHaveProperty('409');
    expect(
      document.paths['/v1/console/auth/switch-organization']?.post?.responses?.['409']
        ?.content?.['application/problem+json'],
    ).toMatchObject({
      schema: { $ref: '#/components/schemas/ConsoleOrganizationSwitchRejectedProblem' },
    });
  });

  it('documenta a fronteira de origem e os cookies seguros da sessão web', async () => {
    const document = await createOpenApiDocument();
    const components = document.components as {
      headers?: Record<string, unknown>;
      securitySchemes?: Record<string, { description?: string }>;
    };
    const consoleOperations = [
      document.paths['/v1/console/auth/select-organization']?.post,
      document.paths['/v1/console/auth/restore']?.post,
      document.paths['/v1/console/auth/switch-organization']?.post,
      document.paths['/v1/console/auth/logout']?.post,
    ] as Array<{
      parameters?: Array<{ $ref?: string }>;
      responses?: Record<string, { headers?: Record<string, unknown> }>;
    }>;

    expect(components.securitySchemes?.refreshCookieAuth?.description).toContain(
      'HttpOnly, Secure, SameSite=Strict, Path=/',
    );
    expect(components.securitySchemes?.csrfHeaderAuth?.description).toContain(
      'cookie __Host-jrc_csrf',
    );
    expect(components.headers).toHaveProperty('SetCookie');
    for (const operation of consoleOperations) {
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/ConsoleOrigin' });
    }
    for (const operation of consoleOperations.slice(0, 3)) {
      expect(operation.responses?.['200']?.headers).toMatchObject({
        'Set-Cookie': { $ref: '#/components/headers/SetCookie' },
      });
    }
    expect(consoleOperations[3]?.responses?.['204']?.headers).toMatchObject({
      'Set-Cookie': { $ref: '#/components/headers/SetCookie' },
    });
  });

  it('gera JSON ordenado e idêntico ao artefato versionado', async () => {
    const first = serializeOpenApiDocument(await createOpenApiDocument());
    const second = serializeOpenApiDocument(await createOpenApiDocument());
    const committed = await readFile(resolve('docs/api/openapi.json'), 'utf8');

    expect(second).toBe(first);
    expect(committed).toBe(first);
  });
  it('documents the scoped control key without broadening legacy integration authentication', async () => {
    const document = await createOpenApiDocument();
    expect(document.paths['/v1/integrations/chatwoot/control/context']?.get?.security).toEqual([{ bearerAuth: [] }, { jrcApiKeyAuth: [] }]);
    expect(document.paths['/v1/integrations/chatwoot/control-credentials']?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/v1/integrations/chatwoot']?.get?.security).toEqual([{ bearerAuth: [] }]);
  });

  it('mantém a Swagger UI desabilitada por padrão', async () => {
    const app = buildApp({ nodeEnv: 'test' });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/documentation' });

    expect(response.statusCode).toBe(404);
  });
});
