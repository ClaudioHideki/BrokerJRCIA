import { afterEach, describe, expect, it } from 'vitest';

import type { Instance, InstanceStatus, Page } from '@jrc/contracts';
import { FakeProviderAdapter, type ConnectionAction } from '@jrc/providers';
import { issueAccessToken } from '@jrc/security';

import { buildApp } from '../../src/app.js';
import {
  InstanceServiceError,
  type ConnectInstanceCommand,
  type CreateInstanceCommand,
  type DisconnectInstanceCommand,
  type InstanceActorContext,
  type InstanceMutationResult,
  type InstanceService,
} from '../../src/modules/instances/service.js';

const JWT_SECRET = 'jwt-secret-with-at-least-thirty-two-bytes';
const REQUEST_ID = '85a17103-9f0d-4d86-b55d-4184597e17a8';
const ORGANIZATION_A = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const ORGANIZATION_B = '73a0c67d-f719-4796-8769-3abf2aeefbb5';
const USER_ID = 'd8caa763-c0b0-40bd-94c5-dbb558a48729';
const ACCOUNT_ID = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const INSTANCE_ID = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const CREATED_AT = '2030-01-01T12:00:00.000Z';

async function jwt(
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER',
  organizationId = ORGANIZATION_A,
) {
  return issueAccessToken({ userId: USER_ID, organizationId, role }, JWT_SECRET);
}

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: INSTANCE_ID,
    organizationId: ORGANIZATION_A,
    providerAccountId: ACCOUNT_ID,
    name: 'Primary',
    provider: 'BAILEYS',
    status: 'CREATED',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function mutation(value: Instance, replayed = false): InstanceMutationResult {
  return {
    instance: value,
    operationId: 'a92b0b8d-dadb-4bd9-a273-89ed914ffabb',
    replayed,
    pending: false,
    reconciliationRequired: false,
  };
}

function createHarness(options: { beginConnectionResponse?: ConnectionAction } = {}) {
  const provider = new FakeProviderAdapter({
    now: () => new Date(CREATED_AT),
    responses: {
      beginConnection: options.beginConnectionResponse ?? {
        type: 'QR_CODE',
        encoding: 'DATA_URL',
        value: 'data:image/png;base64,challenge-canary',
        expiresAt: '2030-01-01T12:01:00.000Z',
      },
      getStatus: 'CONNECTED',
    },
  });
  const rows = new Map<string, Instance>();
  const idempotency = new Set<string>();
  const contexts: InstanceActorContext[] = [];

  function visible(context: InstanceActorContext, id: string): Instance {
    const row = rows.get(id);
    if (!row || row.organizationId !== context.organizationId) {
      throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
    }
    return row;
  }

  const service: InstanceService = {
    async createInstance(context: InstanceActorContext, command: CreateInstanceCommand) {
      contexts.push(context);
      const key = `${context.organizationId}:create:${command.idempotencyKey}`;
      const replayed = idempotency.has(key);
      idempotency.add(key);
      const row = instance({ name: command.name, provider: command.provider });
      rows.set(row.id, row);
      if (!replayed) {
        await provider.provisionInstance(context, {
          upstreamInstanceKey: 'jrc_519b77a6a4e5409a85c8d78fc155c525',
          providerAccountId: command.providerAccountId,
        });
      }
      return mutation(row, replayed);
    },
    async listInstances(context, input): Promise<Page<Instance>> {
      contexts.push(context);
      const data = [...rows.values()]
        .filter((row) => row.organizationId === context.organizationId)
        .slice(0, input.limit);
      return { data, pageInfo: { hasNextPage: false, nextCursor: null } };
    },
    async getInstance(context, id) {
      contexts.push(context);
      return visible(context, id);
    },
    async connectInstance(context: InstanceActorContext, command: ConnectInstanceCommand) {
      contexts.push(context);
      const row = visible(context, command.instanceId);
      const key = `${context.organizationId}:connect:${command.idempotencyKey}`;
      if (idempotency.has(key)) {
        return {
          ...mutation({ ...row, status: 'AWAITING_ACTION' }, true),
          pending: true,
          action: { type: 'NONE', reason: 'CONNECTION_PENDING' } as ConnectionAction,
        };
      }
      idempotency.add(key);
      const action = await provider.beginConnection(context, { reference: { id: row.id } });
      const updated = { ...row, status: 'AWAITING_ACTION' as InstanceStatus };
      rows.set(row.id, updated);
      return { ...mutation(updated), pending: true, action };
    },
    async getInstanceStatus(context, id) {
      contexts.push(context);
      const row = visible(context, id);
      const status = await provider.getStatus(context, { id: row.id });
      const updated = { ...row, status };
      rows.set(row.id, updated);
      return updated;
    },
    async disconnectInstance(context: InstanceActorContext, command: DisconnectInstanceCommand) {
      contexts.push(context);
      const row = visible(context, command.instanceId);
      await provider.disconnect(context, { id: row.id });
      const updated = { ...row, status: 'DISCONNECTED' as InstanceStatus };
      rows.set(row.id, updated);
      return mutation(updated);
    },
  };

  const app = buildApp({
    nodeEnv: 'test',
    passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    instances: {
      jwtSecret: JWT_SECRET,
      async authenticateApiKey() { return null; },
      service,
      now: () => new Date(CREATED_AT),
    },
  });
  return { app, contexts, provider, rows };
}

describe('rotas HTTP de instâncias', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('executa os seis endpoints JRC e propaga o request id ao provider', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const authorization = `Bearer ${await jwt('OWNER')}`;

    const created = await harness.app.inject({
      method: 'POST', url: '/v1/instances',
      headers: { authorization, 'idempotency-key': 'create-1', 'x-request-id': REQUEST_ID },
      payload: { name: 'Primary', provider: 'BAILEYS', providerAccountId: ACCOUNT_ID },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-request-id']).toBe(REQUEST_ID);

    const listed = await harness.app.inject({
      method: 'GET', url: '/v1/instances', headers: { authorization, 'x-request-id': REQUEST_ID },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ data: [{ id: INSTANCE_ID }] });

    const detail = await harness.app.inject({
      method: 'GET', url: `/v1/instances/${INSTANCE_ID}`,
      headers: { authorization, 'x-request-id': REQUEST_ID },
    });
    expect(detail.statusCode).toBe(200);

    const connected = await harness.app.inject({
      method: 'POST', url: `/v1/instances/${INSTANCE_ID}/connect`,
      headers: { authorization, 'idempotency-key': 'connect-1', 'x-request-id': REQUEST_ID },
      payload: {},
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.headers['cache-control']).toBe('no-store');
    expect(connected.headers.pragma).toBe('no-cache');
    expect(connected.json()).toMatchObject({ action: { type: 'QR_CODE' } });

    const status = await harness.app.inject({
      method: 'GET', url: `/v1/instances/${INSTANCE_ID}/status`,
      headers: { authorization, 'x-request-id': REQUEST_ID },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: 'CONNECTED' });

    const disconnected = await harness.app.inject({
      method: 'POST', url: `/v1/instances/${INSTANCE_ID}/disconnect`,
      headers: { authorization, 'idempotency-key': 'disconnect-1', 'x-request-id': REQUEST_ID },
      payload: {},
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({ instance: { status: 'DISCONNECTED' } });
    expect(harness.provider.calls.provisionInstance[0]?.context.requestId).toBe(REQUEST_ID);
    expect(harness.contexts.every(({ deadline, signal }) => (
      deadline.toISOString() === '2030-01-01T12:00:30.000Z' && !signal.aborted
    ))).toBe(true);
  });

  it('aplica paginação 20/100 e rejeita limites fora do contrato', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const authorization = `Bearer ${await jwt('VIEWER')}`;

    await harness.app.inject({ method: 'GET', url: '/v1/instances', headers: { authorization } });
    await harness.app.inject({ method: 'GET', url: '/v1/instances?limit=100', headers: { authorization } });
    const invalid = await harness.app.inject({
      method: 'GET', url: '/v1/instances?limit=101', headers: { authorization },
    });

    expect(harness.contexts.slice(-2).map((context) => context.organizationId)).toEqual([
      ORGANIZATION_A, ORGANIZATION_A,
    ]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['content-type']).toContain('application/problem+json');
    expect(invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('gera novo UUID para request id inválido e responde erros como problem+json', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'GET', url: `/v1/instances/${INSTANCE_ID}`,
      headers: { authorization: `Bearer ${await jwt('OWNER')}`, 'x-request-id': 'unsafe\nvalue' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).not.toBe('unsafe\nvalue');
  });

  it.each(['OWNER', 'ADMIN', 'OPERATOR'] as const)('permite mutações a %s', async (role) => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST', url: '/v1/instances',
      headers: { authorization: `Bearer ${await jwt(role)}`, 'idempotency-key': `create-${role}` },
      payload: { name: role, provider: 'BAILEYS', providerAccountId: ACCOUNT_ID },
    });
    expect(response.statusCode).toBe(201);
  });

  it('nega mutações a VIEWER antes de chamar o serviço', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST', url: '/v1/instances',
      headers: { authorization: `Bearer ${await jwt('VIEWER')}`, 'idempotency-key': 'forbidden' },
      payload: { name: 'Forbidden', provider: 'BAILEYS', providerAccountId: ACCOUNT_ID },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(harness.provider.calls.provisionInstance).toHaveLength(0);
  });

  it('retorna 404 cross-organization sem chamar o provider', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    harness.rows.set(INSTANCE_ID, instance());
    const before = harness.provider.calls.beginConnection.length;
    const response = await harness.app.inject({
      method: 'POST', url: `/v1/instances/${INSTANCE_ID}/connect`,
      headers: {
        authorization: `Bearer ${await jwt('OWNER', ORGANIZATION_B)}`,
        'idempotency-key': 'foreign',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(harness.provider.calls.beginConnection).toHaveLength(before);
  });

  it('responde replay de connect com 202/NONE sem repetir ou serializar desafio', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    harness.rows.set(INSTANCE_ID, instance());
    const headers = {
      authorization: `Bearer ${await jwt('OWNER')}`,
      'idempotency-key': 'connect-replay',
      'x-request-id': REQUEST_ID,
    };
    const first = await harness.app.inject({
      method: 'POST', url: `/v1/instances/${INSTANCE_ID}/connect`, headers, payload: {},
    });
    const replay = await harness.app.inject({
      method: 'POST', url: `/v1/instances/${INSTANCE_ID}/connect`, headers, payload: {},
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ replayed: true, action: { type: 'NONE' } });
    expect(replay.body).not.toContain('challenge-canary');
    expect(harness.provider.calls.beginConnection).toHaveLength(1);
  });

  it('responde 202 para CONNECTION_PENDING mesmo quando a chave é nova', async () => {
    const harness = createHarness({
      beginConnectionResponse: { type: 'NONE', reason: 'CONNECTION_PENDING' },
    });
    apps.push(harness.app);
    harness.rows.set(INSTANCE_ID, instance());
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/instances/${INSTANCE_ID}/connect`,
      headers: {
        authorization: `Bearer ${await jwt('OPERATOR')}`,
        'idempotency-key': 'new-pending',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      replayed: false,
      pending: true,
      action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
    });
  });

  it('não transforma replay concluído de criação em operação pendente', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const headers = {
      authorization: `Bearer ${await jwt('OWNER')}`,
      'idempotency-key': 'create-replay-completed',
    };
    const payload = { name: 'Replay', provider: 'BAILEYS', providerAccountId: ACCOUNT_ID };

    const first = await harness.app.inject({ method: 'POST', url: '/v1/instances', headers, payload });
    const second = await harness.app.inject({ method: 'POST', url: '/v1/instances', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ replayed: true, pending: false });
  });
});
