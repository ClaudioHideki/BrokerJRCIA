import { createHash, randomUUID } from 'node:crypto';

import { EvolutionProviderAdapter, type ProviderContext } from '@jrc/providers';
import { expect, it } from 'vitest';

import { loadEvolutionSmokeEnvironment } from './helpers/evolution-env.js';

const environment = loadEvolutionSmokeEnvironment(process.env);
const smoke = environment.enabled ? it : it.skip;

smoke('executa o ciclo Evolution/Baileys e remove a instância em finally', async () => {
  if (!environment.enabled) return;

  const cleanupTimeoutMs = Math.max(30_000, environment.timeoutMs);
  const runId = randomUUID();
  const upstreamInstanceKey = `jrc_smoke_${createHash('sha256').update(runId).digest('hex').slice(0, 32)}`;
  const adapter = new EvolutionProviderAdapter({
    baseUrl: environment.baseUrl,
    apiKey: environment.apiKey,
    deprovisionPollIntervalMs: 250,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), environment.timeoutMs);
  const context: ProviderContext = {
    organizationId: randomUUID(),
    requestId: randomUUID(),
    deadline: new Date(Date.now() + environment.timeoutMs),
    signal: controller.signal,
  };
  const reference = { id: upstreamInstanceKey };

  try {
    const provisioned = await adapter.provisionInstance(context, {
      upstreamInstanceKey,
      providerAccountId: randomUUID(),
    });
    expect(provisioned.reference).toEqual(reference);

    const connection = await adapter.beginConnection(context, { reference });
    expect(['QR_CODE', 'PAIRING_CODE', 'NONE']).toContain(connection.type);
    expect(await adapter.getStatus(context, reference)).toMatch(
      /^(CREATED|CONNECTING|AWAITING_ACTION|CONNECTED|DISCONNECTED|ERROR)$/,
    );
    await adapter.disconnect(context, reference);
  } finally {
    try {
      clearTimeout(timer);
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), cleanupTimeoutMs);
      const cleanupContext: ProviderContext = {
        ...context,
        requestId: randomUUID(),
        deadline: new Date(Date.now() + cleanupTimeoutMs),
        signal: cleanupController.signal,
      };
      try {
        await adapter.deprovisionInstance(cleanupContext, reference);
        await expect(adapter.lookupInstance(cleanupContext, reference)).resolves.toEqual({ exists: false });
      } finally {
        clearTimeout(cleanupTimer);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}, environment.enabled ? environment.timeoutMs + Math.max(30_000, environment.timeoutMs) + 5_000 : 5_000);
