import { describe, expect, it } from 'vitest';
import { AutomationGraphV1Schema, automationNodePorts, validateAutomationGraph, type FlowGraph, type FlowNode } from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const node = (type: string, data: Record<string, unknown>): FlowNode => ({ id: 'action', type, data,
  label: type, position: { x: 0, y: 0 } });
function graphFor(action: FlowNode): FlowGraph {
  const ports = automationNodePorts(action);
  return { nodes: [{ ...action, id: 'start', type: 'start', data: {} }, action,
    ...(ports.length ? [{ ...action, id: 'end', type: 'end', data: {} }] : [])],
  edges: [{ id: 'entry', source: 'start', target: 'action', port: 'next' },
    ...ports.map(port => ({ id: port, source: 'action', target: 'end', port }))] };
}

describe('explicit action version before publishing', () => {
  it.each([
    node('tag', { tag: 'Cliente' }), node('attribute', { name: 'active', value: false }),
    node('note', { text: 'Nota anterior' }), node('resolve', {}),
    node('media', { url: 'https://example.test/old.png', mediaType: 'image' }),
    node('note', { conversationEffectVersion: 1, channelId: id, target: 'result', timeoutMs: 10000, operation: 'note', text: 'Nota v1' }),
  ])('reads historical $type graphs but requires explicit reconfiguration before publishing', action => {
    const graph = graphFor(action);
    expect(AutomationGraphV1Schema.parse(graph)).toEqual(graph);
    expect(validateAutomationGraph(graph)).toContainEqual(expect.objectContaining({
      nodeId: 'action', code: 'ACTION_RECONFIGURATION_REQUIRED',
    }));
  });

  it('validates a configured resolve as terminal and rejects a next message edge', () => {
    const graph = graphFor(node('resolve', { conversationEffectVersion: 2, channelId: id, target: 'result',
      timeoutMs: 10000, operation: 'resolve', status: 'RESOLVED' }));
    expect(validateAutomationGraph(graph)).toEqual([]);
    graph.nodes.push({ ...node('message', { text: 'Não enviar' }), id: 'message' });
    graph.edges.push({ id: 'after-resolve', source: 'action', target: 'message', port: 'success' });
    expect(validateAutomationGraph(graph)).toContainEqual(expect.objectContaining({ nodeId: 'action', code: 'INVALID_PORT' }));
  });
});
