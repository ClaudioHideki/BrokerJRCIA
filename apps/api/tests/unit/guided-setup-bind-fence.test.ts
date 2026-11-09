import { expect, it, vi } from 'vitest';
import { createAutomationService } from '../../src/modules/automations/service.js';
it('runs the internal setup fence before channel lookup or owner mutation', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const graph = { nodes: [{ id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 }, data: {} },
    { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 }, data: {} }],
    edges: [{ id: 'edge', source: 'start', target: 'end', port: 'next' }] };
  const findChannel = vi.fn(async () => null), assertScope = vi.fn(async () => { throw new Error('GUIDED_SCOPE_CHANGED'); });
  const service = createAutomationService({ transact: async (_org, work) => work({ query: async () => ({ rows: [{ active: true, status: 'ACTIVE', moduleEnabled: true }], rowCount: 1 }) } as never),
    repository: { getDefinition: async () => ({ id, organizationId: id, lifecycleStatus: 'PUBLISHED', activeVersion: 1 }),
      getVersion: async () => ({ automationId: id, version: 1, runtimeStateVersion: 2, graph }) } as never,
    messaging: { findChannel } as never });
  await expect(service.bind(id, id, { channelId: id, version: 1, expectedOwnerRevision: 0, assertScope } as never)).rejects.toThrow('GUIDED_SCOPE_CHANGED');
  expect(assertScope).toHaveBeenCalledOnce(); expect(findChannel).not.toHaveBeenCalled();
});
