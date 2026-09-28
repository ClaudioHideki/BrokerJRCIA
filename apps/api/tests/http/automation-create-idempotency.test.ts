import { afterEach, describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import { IdempotencyConflictError } from '../../src/modules/instances/idempotency.js';
import type { AutomationService, createExecutionService } from '../../src/modules/automations/service.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const secret = 'automation-create-idempotency-http-secret';

describe('POST /v1/automations idempotency', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

  it('passes the required key to the service and returns a safe 409 for another payload', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ id: '33333333-3333-4333-8333-333333333333' })
      .mockRejectedValueOnce(new IdempotencyConflictError());
    const app = buildApp({
      nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
      automations: {
        jwtSecret: secret, authenticateApiKey: async () => null,
        resolveCurrentRole: async () => 'OWNER' as const,
        service: { create } as unknown as AutomationService,
        executions: {} as ReturnType<typeof createExecutionService>,
      },
    });
    apps.push(app);
    const authorization = `Bearer ${await issueAccessToken({ userId, organizationId, role: 'OWNER' }, secret)}`;
    const headers = { authorization, 'idempotency-key': 'same-create-key' };
    const first = await app.inject({ method: 'POST', url: '/v1/automations', headers,
      payload: { name: 'Atendimento', graph: welcomeFlow() } });
    expect(first.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith(organizationId, { name: 'Atendimento', graph: welcomeFlow() }, 'same-create-key');

    const conflict = await app.inject({ method: 'POST', url: '/v1/automations', headers,
      payload: { name: 'Outro', graph: welcomeFlow() } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(conflict.body).not.toContain('another request');
  });
});
