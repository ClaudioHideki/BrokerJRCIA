import { describe, expect, it } from 'vitest';

import type {
  BeginConnectionInput,
  ProviderContext,
  ProviderInstanceReference,
  ProvisionInstanceInput,
  WhatsAppProvider,
} from '../src/index.js';

const context: ProviderContext = {
  organizationId: 'ed3ca47c-4f7e-4ce4-a3c7-32b1e3bc446d',
  requestId: 'req-provider-contract',
  deadline: new Date('2030-01-01T00:00:00.000Z'),
  signal: new AbortController().signal,
};

const provisionInput: ProvisionInstanceInput = {
  upstreamInstanceKey: 'jrc_018f17dd-c346-7fb0-9a3c-97f9cb3ba243',
  providerAccountId: '7c0766da-2524-443a-a45b-ab3de2a49b1f',
};

const reference: ProviderInstanceReference = { id: 'provider-instance-1' };
const connectionInput: BeginConnectionInput = { reference };

export function runProviderContractTests(factory: () => WhatsAppProvider): void {
  describe('contrato comum WhatsAppProvider', () => {
    it('provisiona e devolve somente referência e status canônicos', async () => {
      await expect(factory().provisionInstance(context, provisionInput)).resolves.toEqual({
        reference: { id: 'fake-instance' },
        status: 'CREATED',
      });
    });

    it('inicia conexão com uma ação canônica discriminada', async () => {
      await expect(factory().beginConnection(context, connectionInput)).resolves.toEqual({
        type: 'NONE',
        reason: 'NO_USER_ACTION_REQUIRED',
      });
    });

    it('consulta status e desconecta sem expor detalhes upstream', async () => {
      const provider = factory();

      await expect(provider.getStatus(context, reference)).resolves.toBe('CREATED');
      await expect(provider.disconnect(context, reference)).resolves.toBeUndefined();
    });
  });
}

export const providerContractFixtures = {
  context,
  provisionInput,
  reference,
  connectionInput,
} as const;
