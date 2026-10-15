import { describe, expect, it, vi } from 'vitest';
import { simulateConversation } from '../../src/modules/automations/simulation.js';
import type { PublishedAutomation } from '../../src/modules/automations/types.js';
const id = '11111111-2222-4333-8444-555555555555';
const clock = '2026-10-15T12:00:00.000Z';
const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data, label: id, position: { x: 0, y: 0 } });
const edge = (source: string, target: string, port = 'next') => ({ id: source + ':' + port, source, target, port });
const action = { conversationEffectVersion: 2, operation: 'note', channelId: id, target: 'result', timeoutMs: 15000, text: 'Nota privada' };
const root: PublishedAutomation = { automationId: id, version: 1, runtimeStateVersion: 2, graph: {
  nodes: [node('start', 'start'), node('note', 'note', action), node('message', 'message', { text: 'Continuou' }), node('end', 'end')],
  edges: [edge('start', 'note'), ...['success', 'error', 'timeout'].map(port => edge('note', 'message', port)), edge('message', 'end')],
} };

describe('action simulation uses exact deterministic effect waits', () => {
  it('reconstructs the same wait and confirms an action without network or real changes', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const first = await simulateConversation(root, { text: 'Oi', clock }, async () => root);
      const second = await simulateConversation(root, { text: 'Oi', clock }, async () => root);
      expect(first).toMatchObject({ status: 'WAITING', actionWait: { nodeId: 'note', operation: 'note', waitId: first.wait?.waitId } });
      expect(first.wait?.waitId).toMatch(/^[a-f0-9-]{36}$/);
      expect(second.wait?.waitId).toBe(first.wait?.waitId);
      const result = await simulateConversation(root, { text: 'Oi', clock, events: [
        { type: 'ACTION_RESPONSE', nodeId: 'note', waitId: first.wait!.waitId!, outcome: 'success' },
      ] }, async () => root);
      expect(result.status).toBe('COMPLETED');
      expect(result.effects.filter(effect => effect.kind === 'SEND_TEXT').map(effect => effect.payload.text)).toEqual(['Continuou']);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('keeps uncertainty on the exact same wait until a simulated receipt resolves it', async () => {
    const first = await simulateConversation(root, { text: 'Oi', clock }, async () => root);
    const unknown = { type: 'ACTION_RESPONSE' as const, nodeId: 'note', waitId: first.wait!.waitId!, outcome: 'unknown' as const };
    const pending = await simulateConversation(root, { text: 'Oi', clock, events: [unknown] }, async () => root);
    expect(pending).toMatchObject({ status: 'WAITING', actionWait: { waitId: first.wait?.waitId }, state: { waiting: { waitId: first.wait?.waitId } } });
    expect(pending.effects.filter(effect => effect.kind === 'SEND_TEXT')).toEqual([]);
    const complete = await simulateConversation(root, { text: 'Oi', clock, events: [unknown, { ...unknown, outcome: 'success' }] }, async () => root);
    expect(complete.status).toBe('COMPLETED');
    expect(complete.effects.filter(effect => effect.kind === 'IO_CONVERSATION')).toHaveLength(1);
  });
  it('rejects a receipt for an old visit to the same node or for a changed graph', async () => {
    const loop = { ...root, graph: { ...root.graph, edges: [edge('start', 'note'), edge('note', 'note', 'success')] } };
    const first = await simulateConversation(loop, { text: 'Oi', clock }, async () => loop);
    const event = { type: 'ACTION_RESPONSE' as const, nodeId: 'note', waitId: first.wait!.waitId!, outcome: 'success' as const };
    const second = await simulateConversation(loop, { text: 'Oi', clock, events: [event] }, async () => loop);
    expect(second.wait?.waitId).not.toBe(first.wait?.waitId);
    await expect(simulateConversation(loop, { text: 'Oi', clock, events: [event, event] }, async () => loop)).rejects.toThrow('AUTOMATION_SIMULATION_ACTION_WAIT_MISMATCH');
    const changed = { ...loop, graph: { ...loop.graph, nodes: loop.graph.nodes.map(item => item.id === 'note' ? { ...item, data: { ...action, text: 'Outra nota' } } : item) } };
    await expect(simulateConversation(changed, { text: 'Oi', clock, events: [event] }, async () => changed)).rejects.toThrow('AUTOMATION_SIMULATION_ACTION_WAIT_MISMATCH');
  });
  it('resolves the entire cycle inside a child without sending the next parent message', async () => {
    const child: PublishedAutomation = { ...root, automationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', graph: {
      nodes: [node('start', 'start'), node('resolve', 'resolve', { conversationEffectVersion: 2, operation: 'resolve', channelId: id, target: 'result', timeoutMs: 15000, status: 'RESOLVED' })],
      edges: [edge('start', 'resolve')],
    } };
    const parent = { ...root, graph: { nodes: [node('start', 'start'), node('call', 'subflow', { automationId: child.automationId, version: 1 }),
      node('bad', 'message', { text: 'Não enviar' }), node('end', 'end')], edges: [edge('start', 'call'), edge('call', 'bad'), edge('bad', 'end')] } };
    const load = async (id: string) => id === child.automationId ? child : parent;
    const first = await simulateConversation(parent, { text: 'Oi', clock }, load);
    const result = await simulateConversation(parent, { text: 'Oi', clock, events: [{ type: 'ACTION_RESPONSE', nodeId: 'resolve', waitId: first.wait!.waitId!, outcome: 'success' }] }, load);
    expect(result).toMatchObject({ status: 'COMPLETED', state: { nodeId: null, stack: [] } });
    expect(result.effects.some(effect => effect.kind === 'SEND_TEXT')).toBe(false);
  });
  it('simulates a private media outcome without a provider or public URL', async () => {
    const media = { ...root, graph: { ...root.graph, nodes: root.graph.nodes.map(item => item.id === 'note' ? node('note', 'media', {
      mediaEffectVersion: 2, channelId: id, mediaId: id, mediaRevision: 1, caption: '', target: 'media.result', timeoutMs: 15000,
    }) : item) } };
    const first = await simulateConversation(media, { text: 'Oi', clock }, async () => media);
    expect(first).toMatchObject({ actionWait: { operation: 'media', waitId: first.wait?.waitId } });
    const result = await simulateConversation(media, { text: 'Oi', clock, events: [{ type: 'ACTION_RESPONSE', nodeId: 'note', waitId: first.wait!.waitId!, outcome: 'timeout' }] }, async () => media);
    expect(result.status).toBe('COMPLETED');
    expect(result.effects[0]?.payload).not.toHaveProperty('url');
  });
});
