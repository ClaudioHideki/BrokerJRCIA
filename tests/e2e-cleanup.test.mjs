import { describe, expect, it, vi } from 'vitest';

import { runE2eCleanupSteps } from '../apps/web/tests/e2e/cleanup.ts';

describe('cleanup isolado do E2E', () => {
  it('tenta todas as etapas e falha agregando qualquer recurso que não foi limpo', async () => {
    const calls = [];
    const firstFailure = new Error('database still exists');
    const lastFailure = new Error('redis keys remain');

    await expect(runE2eCleanupSteps([
      { name: 'api', run: vi.fn(async () => { calls.push('api'); throw firstFailure; }) },
      { name: 'pool', run: vi.fn(async () => { calls.push('pool'); }) },
      { name: 'redis', run: vi.fn(async () => { calls.push('redis'); throw lastFailure; }) },
    ])).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: expect.stringContaining('api') }),
        expect.objectContaining({ message: expect.stringContaining('redis') }),
      ],
    });
    expect(calls).toEqual(['api', 'pool', 'redis']);
  });

  it('conclui somente quando todas as etapas terminam', async () => {
    await expect(runE2eCleanupSteps([
      { name: 'api', run: async () => undefined },
      { name: 'database', run: async () => undefined },
    ])).resolves.toBeUndefined();
  });
});
