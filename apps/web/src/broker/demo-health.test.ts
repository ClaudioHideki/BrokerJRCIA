import { expect, it } from 'vitest';
import { createDemoClient } from './demo.js';
import { parseHealthSnapshot } from '../operations/health-model.js';
it('supplies a valid read-only synthetic health snapshot for the local pilot', async () => {
  const client = createDemoClient();
  const result = parseHealthSnapshot(await client.request('/v1/operations/health'));
  expect(result.components.length).toBe(18);
  await expect(client.request('/v1/operations/health', { method: 'POST' })).rejects.toThrow();
});
