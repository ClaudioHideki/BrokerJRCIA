import { describe, expect, it } from 'vitest';

import type { ProviderContext } from '@jrc/providers';

import { BrowserE2eFakeProvider } from '../e2e/global-setup.js';
import { SYNTHETIC_PAIRING_HINT } from '../e2e/artifact-policy.js';

function providerContext(): ProviderContext {
  return {
    organizationId: '92776cb0-bcba-45c0-98a3-2937fefdfdaf',
    requestId: '85a17103-9f0d-4d86-b55d-4184597e17a8',
    deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
  };
}

describe('BrowserE2eFakeProvider', () => {
  it('mantém o desafio observável no primeiro status antes de concluir a conexão', async () => {
    const provider = new BrowserE2eFakeProvider();
    const context = providerContext();
    const reference = { id: 'e2e-pairing-instance' };

    await expect(provider.beginConnection(context, {
      reference,
      pairingHint: SYNTHETIC_PAIRING_HINT,
    })).resolves.toMatchObject({ type: 'PAIRING_CODE' });

    await expect(provider.getStatus(context, reference)).resolves.toBe('AWAITING_ACTION');
    await expect(provider.getStatus(context, reference)).resolves.toBe('CONNECTED');
  });
});
