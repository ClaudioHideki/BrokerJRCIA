import { expect, it, vi } from 'vitest';
import { createInstanceService, type InstanceServiceDependencies, type InstanceActorContext } from '../../src/modules/instances/service.js';
import { IntegrationError } from '../../src/modules/integrations/integration-error.js';

it('revalidates delegated control before any instance operation without pretending to be a JWT', async () => {
  const lookup = vi.fn();
  const authorize = vi.fn().mockRejectedValue(new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403));
  const service = createInstanceService({ repository: new Proxy({}, { get: () => lookup }), providers: { getProvider: lookup },
    runInOrganizationTransaction: async (_org: string, run: (tx: unknown) => unknown) => run({}), writeAudit: lookup } as unknown as InstanceServiceDependencies);
  const context: InstanceActorContext = { credentialKind: 'CHATWOOT_CONTROL', organizationId: 'org', actorId: null, apiKeyId: 'key',
    authorize, requestId: 'request', deadline: new Date(Date.now() + 10000), signal: new AbortController().signal };
  const calls = [() => service.createInstance(context, { provider: 'BAILEYS', providerAccountId: 'p', name: 'Fixture', idempotencyKey: 'fixture-001' }),
    () => service.connectInstance(context, { instanceId: 'i', idempotencyKey: 'fixture-001' }),
    () => service.disconnectInstance(context, { instanceId: 'i', idempotencyKey: 'fixture-001' }),
    () => service.getInstanceStatus(context, 'i'), () => service.getInstance(context, 'i'), () => service.listInstances(context, { limit: 10 })];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'CHATWOOT_CONTROL_FORBIDDEN' });
  expect(authorize.mock.calls.map(c => c[1])).toEqual(['create', 'pair', 'disconnect', 'status', 'status', 'list']);
  expect(lookup).not.toHaveBeenCalled();
});
