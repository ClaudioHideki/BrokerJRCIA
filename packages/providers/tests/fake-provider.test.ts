import { describe, expect, it } from 'vitest';

import {
  FakeProviderAdapter,
  type ProviderContext,
} from '../src/index.js';
import { providerContractFixtures, runProviderContractTests } from './provider-contract.js';

runProviderContractTests(() => new FakeProviderAdapter({
  now: () => new Date('2029-01-01T00:00:00.000Z'),
}));

describe('FakeProviderAdapter', () => {
  const now = new Date('2029-01-01T00:00:00.000Z');

  function createFake() {
    return new FakeProviderAdapter({ now: () => now });
  }

  it('registra os argumentos de todas as operações comuns e administrativas', async () => {
    const fake = createFake();
    const { context, provisionInput, reference, connectionInput } = providerContractFixtures;

    await fake.provisionInstance(context, provisionInput);
    await fake.beginConnection(context, connectionInput);
    await fake.getStatus(context, reference);
    await fake.disconnect(context, reference);
    await fake.lookupInstance(context, reference);
    await fake.reconcileProvisioning(context, provisionInput);
    await fake.deprovisionInstance(context, reference);

    expect(fake.calls).toEqual({
      provisionInstance: [{ context, input: provisionInput }],
      beginConnection: [{ context, input: connectionInput }],
      getStatus: [{ context, reference }],
      disconnect: [{ context, reference }],
      lookupInstance: [{ context, reference }],
      reconcileProvisioning: [{ context, input: provisionInput }],
      deprovisionInstance: [{ context, reference }],
    });
  });

  it('permite respostas determinísticas por operação', async () => {
    const fake = new FakeProviderAdapter({
      now: () => now,
      responses: {
        provisionInstance: {
          reference: { id: 'configured-instance' },
          status: 'CONNECTED',
        },
        beginConnection: {
          type: 'PAIRING_CODE',
          code: '82716490',
          expiresAt: '2029-01-01T00:01:00.000Z',
        },
        getStatus: 'CONNECTED',
        lookupInstance: {
          exists: true,
          reference: { id: 'configured-instance' },
          status: 'CONNECTED',
        },
        reconcileProvisioning: {
          outcome: 'FOUND',
          instance: {
            reference: { id: 'configured-instance' },
            status: 'CONNECTED',
          },
        },
      },
    });

    const { context, provisionInput, reference, connectionInput } = providerContractFixtures;
    await expect(fake.provisionInstance(context, provisionInput)).resolves.toEqual(fake.responses.provisionInstance);
    await expect(fake.beginConnection(context, connectionInput)).resolves.toEqual(fake.responses.beginConnection);
    await expect(fake.getStatus(context, reference)).resolves.toBe('CONNECTED');
    await expect(fake.lookupInstance(context, reference)).resolves.toEqual(fake.responses.lookupInstance);
    await expect(fake.reconcileProvisioning(context, provisionInput)).resolves.toEqual(fake.responses.reconcileProvisioning);
  });

  it('propaga o erro configurado de forma determinística e ainda registra a chamada', async () => {
    const unavailable = Object.assign(new Error('configured failure'), { code: 'TEST_PROVIDER_FAILURE' });
    const fake = new FakeProviderAdapter({
      now: () => now,
      errors: { beginConnection: unavailable },
    });

    await expect(fake.beginConnection(
      providerContractFixtures.context,
      providerContractFixtures.connectionInput,
    )).rejects.toBe(unavailable);
    expect(fake.calls.beginConnection).toHaveLength(1);
  });

  it('rejeita contexto já cancelado com erro canônico', async () => {
    const controller = new AbortController();
    controller.abort(new Error('sensitive abort reason'));
    const context: ProviderContext = {
      ...providerContractFixtures.context,
      signal: controller.signal,
    };

    const fake = createFake();
    await expect(fake.getStatus(context, providerContractFixtures.reference)).rejects.toMatchObject({
      code: 'PROVIDER_ABORTED',
    });
    expect(fake.calls.getStatus).toHaveLength(1);
  });

  it('rejeita deadline expirado e deadline inválido', async () => {
    const fake = createFake();
    const expiredContext: ProviderContext = {
      ...providerContractFixtures.context,
      deadline: new Date('2028-12-31T23:59:59.999Z'),
    };
    const invalidContext: ProviderContext = {
      ...providerContractFixtures.context,
      deadline: new Date(Number.NaN),
    };

    await expect(fake.getStatus(expiredContext, providerContractFixtures.reference)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    await expect(fake.getStatus(invalidContext, providerContractFixtures.reference)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_CONTEXT',
    });
  });
});
