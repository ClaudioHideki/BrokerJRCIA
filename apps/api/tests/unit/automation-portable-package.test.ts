import { describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '@jrc/contracts';

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, data });
const graph = (nodes: ReturnType<typeof node>[]): FlowGraph => ({ nodes: [node('start', 'start'), ...nodes, node('end', 'end')], edges: [] });
const flow = (key: string, nodes: ReturnType<typeof node>[] = []) => ({ key, name: key, graph: graph(nodes) });
const artifact = (flows = [flow('root')]) => ({ format: 'jrc-broker-package/1', rootKey: 'root', flows });
async function implementation() {
  const mod = await import('../../src/modules/automation-integrations/portable-package.js').catch(() => null);
  expect(mod, 'portable package implementation must exist').not.toBeNull();
  return mod!;
}
const allocator = () => { let i = 0; return () => `11111111-1111-4111-8111-${String(++i).padStart(12, '0')}`; };

describe('portable package preparation', () => {
  it('remaps shared dependencies and preserves distinct source versions by logical key', async () => {
    const { preparePortablePackage } = await implementation();
    const input = artifact([flow('root', [node('one', 'subflow', { automationId: 'child-v1', version: 1 }),
      node('two', 'subflow', { automationId: 'child-v1', version: 1 }), node('three', 'subflow', { automationId: 'child-v2', version: 1 })]),
    flow('child-v1', [node('old', 'message', { text: 'First' })]), flow('child-v2', [node('new', 'message', { text: 'Second' })])]);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const result = preparePortablePackage(input, allocator());
      expect(result.flows).toHaveLength(3);
      expect(new Set(result.flows.map(f => f.id)).size).toBe(3);
      const root = result.flows.find(f => f.key === 'root')!, v1 = result.flows.find(f => f.key === 'child-v1')!;
      expect(root.graph.nodes.filter(n => n.type === 'subflow').map(n => n.data.automationId)).toEqual([v1.id, v1.id, result.flows.find(f => f.key === 'child-v2')!.id]);
      expect(result.publicationOrder.at(-1)).toBe('root');
      expect(root.graph.edges).toEqual(input.flows[0]!.graph.edges);
      expect(input.flows[0]!.graph.nodes[1]!.data.automationId).toBe('child-v1');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('requires local references for credentials, handoff, conversation effects, media and domain commands', async () => {
    const { preparePortablePackage } = await implementation();
    const id = '22222222-2222-4222-8222-222222222222';
    const data = { channelId: id, resourceId: id, resourceRevision: 'a'.repeat(64), conversationEffectVersion: 2 };
    const input = artifact([flow('root', [node('http', 'http', { credentialId: id, credentialRevision: 2, url: 'https://example.com' }),
      node('handoff', 'handoff', { handoffVersion: 1, destination: { integrationId: id }, target: { agentId: 7, teamId: null } }),
      node('tag', 'tag', data), node('media', 'media', { mediaEffectVersion: 2, channelId: id, mediaId: id, mediaRevision: 1 }),
      node('domain', 'domain', { conversationEffectVersion: 2, channelId: id, command: 'service_desk_intake', configurationId: 9, configurationRevision: 1, input: { description: id } }),
      node('owner', 'domain', { conversationEffectVersion: 2, channelId: id, command: 'create_task', ownerId: 7 }),
      node('plain', 'variable', { value: { credentialId: id, channelId: id }, variable: 'business' })])]);
    const result = preparePortablePackage(input, allocator()), nodes = result.flows[0]!.graph.nodes;
    for (const name of ['http', 'handoff', 'tag', 'media', 'domain', 'owner']) expect(result.requirements.some(r => r.nodeId === name)).toBe(true);
    expect(nodes.find(n => n.id === 'http')!.data).not.toHaveProperty('credentialId');
    expect(nodes.find(n => n.id === 'handoff')!.data).not.toHaveProperty('destination');
    expect(nodes.find(n => n.id === 'handoff')!.data.handoffVersion).toBe(1);
    expect(nodes.find(n => n.id === 'tag')!.data).not.toHaveProperty('resourceId');
    expect(nodes.find(n => n.id === 'media')!.data).not.toHaveProperty('mediaId');
    expect(nodes.find(n => n.id === 'domain')!.data).not.toHaveProperty('configurationId');
    expect(nodes.find(n => n.id === 'domain')!.data.input).toEqual({ description: id });
    expect(nodes.find(n => n.id === 'owner')!.data).not.toHaveProperty('ownerId');
    expect(nodes.find(n => n.id === 'plain')!.data.value).toEqual({ credentialId: id, channelId: id });
  });

  it.each(['http', 'sql', 'ai-generate', 'ai-classify', 'ai-extract', 'ai-summarize', 'ai-agent'])('requires a local credential for %s even without an origin selection', async type => {
    const { preparePortablePackage } = await implementation();
    const result = preparePortablePackage(artifact([flow('root', [node('action', type)])]), allocator());
    expect(result.requirements).toContainEqual(expect.objectContaining({ nodeId: 'action', kind: 'CREDENTIAL', fields: expect.arrayContaining(['credentialId']) }));
  });

  it('rejects missing dependencies, cycles, duplicate keys, unreachable extras and unknown formats', async () => {
    const { preparePortablePackage } = await implementation();
    for (const input of [artifact([flow('root', [node('call', 'subflow', { automationId: 'missing', version: 1 })])]),
      artifact([flow('root', [node('call', 'subflow', { automationId: 'root', version: 1 })])]),
      artifact([flow('root'), flow('root')]), artifact([flow('root'), flow('orphan')]), { ...artifact(), format: 'unknown' }]) {
      expect(() => preparePortablePackage(input, allocator())).toThrow();
    }
  });

  it('accepts eight child calls and rejects nine', async () => {
    const { preparePortablePackage } = await implementation();
    const chain = (depth: number) => artifact(Array.from({ length: depth + 1 }, (_, at) => flow(at ? `child-${at}` : 'root',
      at < depth ? [node('call', 'subflow', { automationId: `child-${at + 1}`, version: 1 })] : [])));
    expect(preparePortablePackage(chain(8), allocator()).flows).toHaveLength(9);
    expect(() => preparePortablePackage(chain(9), allocator())).toThrow(/DEPTH/);
  });

  it('accepts 32 reachable versions and rejects a 33rd without allocating identities', async () => {
    const { preparePortablePackage } = await implementation();
    const tree = (children: number) => artifact([flow('root', Array.from({ length: children }, (_, at) =>
      node(`call-${at}`, 'subflow', { automationId: `child-${at}`, version: 1 }))),
    ...Array.from({ length: children }, (_, at) => flow(`child-${at}`))]);
    expect(preparePortablePackage(tree(31), allocator()).flows).toHaveLength(32);
    const allocate = vi.fn(allocator());
    expect(() => preparePortablePackage(tree(32), allocate)).toThrow();
    expect(allocate).not.toHaveBeenCalled();
  });

  it('rejects oversized UTF-8 packages before allocating or mutating graphs', async () => {
    const { preparePortablePackage } = await implementation();
    const input = artifact([flow('root', Array.from({ length: 10 }, (_, at) =>
      node(`call-${at}`, 'subflow', { automationId: `child-${at}`, version: 1 }))),
    ...Array.from({ length: 10 }, (_, at) => flow(`child-${at}`, [node('text', 'message', { text: 'á'.repeat(110000) })]))]);
    const allocate = vi.fn(allocator());
    expect(() => preparePortablePackage(input, allocate)).toThrow(/SIZE_LIMIT/);
    expect(allocate).not.toHaveBeenCalled();
  });
});
