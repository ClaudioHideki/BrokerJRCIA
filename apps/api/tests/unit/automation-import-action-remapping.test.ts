import { describe, expect, it } from 'vitest';
import { automationNodePorts, validateAutomationGraph, type FlowGraph, type FlowNode } from '@jrc/contracts';
import { convertAutomationArtifact } from '../../src/modules/automation-integrations/importer.js';

const id = '11111111-1111-4111-8111-111111111111';
const node = (name: string, type: string, data: Record<string, unknown> = {}): FlowNode => ({
  id: name, type, label: name, position: { x: 100, y: 120 }, data,
});
function source(type: string, version = 2): FlowGraph {
  const data: Record<string, unknown> = { channelId: id, target: 'action.result', timeoutMs: 15000 };
  if (type === 'media') Object.assign(data, { mediaEffectVersion: version, mediaId: id, mediaRevision: 7, caption: 'Arquivo' });
  else Object.assign(data, { conversationEffectVersion: version, operation: type,
    ...(type === 'tag' || type === 'attribute' ? { resourceId: id, resourceRevision: 'a'.repeat(64) } : {}),
    ...(type === 'attribute' ? { valueSource: { kind: 'LITERAL', value: false } } : {}),
    ...(type === 'note' ? { text: `Nota ${id}` } : {}), ...(type === 'resolve' ? { status: 'RESOLVED' } : {}) });
  const action = node('action', type, data), terminal = type === 'resolve' && version === 2;
  return { nodes: [node('start', 'start'), action, ...(terminal ? [] : [node('end', 'end')])], edges: [
    { id: 'entry', source: 'start', target: 'action', port: 'next' },
    ...automationNodePorts(action).map(port => ({ id: port, source: 'action', target: 'end', port })),
  ] };
}
const convert = (graph: FlowGraph) => convertAutomationArtifact('AUTO', JSON.stringify({
  format: 'jrc-broker-flows/1', flow: { name: 'Ações importadas', graph },
}));

describe('local action and private-media selections after import', () => {
  it.each(['tag', 'attribute', 'note', 'resolve', 'media'])('requires a local box and resource selection for %s', type => {
    const original = source(type), result = convert(original), action = result.graph.nodes.find(item => item.id === 'action')!;
    for (const key of ['channelId', 'resourceId', 'resourceRevision', 'mediaId', 'mediaRevision']) {
      expect(action.data).not.toHaveProperty(key);
    }
    expect(action.data).toMatchObject({ target: 'action.result', timeoutMs: 15000,
      ...(type === 'media' ? { mediaEffectVersion: 2, caption: 'Arquivo' } : { conversationEffectVersion: 2, operation: type }),
      ...(type === 'attribute' ? { valueSource: { kind: 'LITERAL', value: false } } : {}),
      ...(type === 'note' ? { text: `Nota ${id}` } : {}) });
    expect(result.graph.edges).toEqual(original.edges);
    expect(result.graph.nodes.map(item => item.id)).toEqual(original.nodes.map(item => item.id));
    expect(result.report.summary).toMatchObject({ autoPublished: false, manualReviewRequired: true,
      credentialsRemoved: false, partial: 1, unsupported: 0 });
    expect(result.report.nodes.find(item => item.sourceId === 'action')!.notes.join(' ')).toMatch(/caixa.*local/i);
    expect(validateAutomationGraph(result.graph)).toContainEqual(expect.objectContaining({ nodeId: 'action', code: 'INVALID_CONFIG' }));
    expect(original.nodes[1]!.data.channelId).toBe(id);
  });

  it('preserves a historical marker instead of making an imported v1 action executable as v2', () => {
    const result = convert(source('tag', 1));
    expect(result.graph.nodes[1]!.data).toMatchObject({ conversationEffectVersion: 1 });
    expect(result.graph.nodes[1]!.data).not.toHaveProperty('resourceId');
    expect(result.graph.edges.map(edge => edge.port)).toContain('unknown');
  });

  it('does not remove similarly named business values from other node types', () => {
    const graph = { nodes: [node('start', 'start'), node('end', 'end', { channelId: id, mediaId: id })],
      edges: [{ id: 'next', source: 'start', target: 'end', port: 'next' }] };
    expect(convert(graph).graph).toEqual(graph);
  });

  it('retains every node and edge at the 150-node limit while requiring local selections', () => {
    const graph = source('note');
    const messages = Array.from({ length: 147 }, (_, index) => node(`text-${index}`, 'message', { text: 'Texto' }));
    graph.nodes.splice(1, 0, ...messages);
    graph.edges[0]!.target = 'text-0';
    for (const [index, message] of messages.entries()) graph.edges.push({ id: `text-edge-${index}`, source: message.id,
      target: messages[index + 1]?.id ?? 'action', port: 'next' });
    const result = convert(graph);
    expect(result.graph.nodes.map(item => ({ ...item, data: undefined }))).toEqual(graph.nodes.map(item => ({ ...item, data: undefined })));
    expect(result.graph.edges).toEqual(graph.edges);
    expect(result.report.summary).toMatchObject({ manualReviewRequired: true, partial: 1, unsupported: 0 });
  });
});
