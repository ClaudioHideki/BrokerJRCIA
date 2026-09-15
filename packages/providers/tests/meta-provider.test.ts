import { describe, expect, it } from 'vitest';

import { MetaProviderAdapter } from '../src/index.js';
import { providerContractFixtures } from './provider-contract.js';

describe('MetaProviderAdapter', () => {
  it('identifica o provider Meta sem implementar contrato administrativo', () => {
    const meta = new MetaProviderAdapter();

    expect(meta.kind).toBe('META');
    expect('lookupInstance' in meta).toBe(false);
    expect('reconcileProvisioning' in meta).toBe(false);
    expect('deprovisionInstance' in meta).toBe(false);
  });

  it.each([
    ['provisionInstance', () => new MetaProviderAdapter().provisionInstance(
      providerContractFixtures.context,
      providerContractFixtures.provisionInput,
    )],
    ['beginConnection', () => new MetaProviderAdapter().beginConnection(
      providerContractFixtures.context,
      providerContractFixtures.connectionInput,
    )],
    ['getStatus', () => new MetaProviderAdapter().getStatus(
      providerContractFixtures.context,
      providerContractFixtures.reference,
    )],
    ['disconnect', () => new MetaProviderAdapter().disconnect(
      providerContractFixtures.context,
      providerContractFixtures.reference,
    )],
  ])('retorna PROVIDER_NOT_AVAILABLE em %s', async (_operation, invoke) => {
    await expect(invoke()).rejects.toMatchObject({
      code: 'PROVIDER_NOT_AVAILABLE',
    });
  });
});
