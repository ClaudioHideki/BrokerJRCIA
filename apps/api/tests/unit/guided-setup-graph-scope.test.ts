import { expect, it } from 'vitest';
import { matchesSetupGraphScope } from '../../src/modules/guided-setup/graph-scope.js';
it('requires domain commands to use the selected channel even without a conversation effect marker', () => {
  const graph: any = { nodes: [{ id: 'intake', type: 'domain', data: { command: 'service_desk_intake', channelId: 'other-channel' } }], edges: [] };
  const scope: any = { channelId: 'selected-channel' };
  expect(matchesSetupGraphScope(graph, scope)).toBe(false);
  graph.nodes[0].data.channelId = 'selected-channel'; expect(matchesSetupGraphScope(graph, scope)).toBe(true);
});
