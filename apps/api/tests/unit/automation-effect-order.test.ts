import { describe, expect, it } from 'vitest';
import type { FlowNode } from '@jrc/contracts';
import { executeAutomation } from '../../src/modules/automations/engine.js';
import type { PublishedAutomation } from '../../src/modules/automations/types.js';

const node = (id: string, type: FlowNode['type'], data: Record<string, unknown> = {}) =>
  ({ id, type, label: id, position: { x: 0, y: 0 }, data });
const edge = (source: string, target: string, port = 'next') =>
  ({ id: `${source}-${port}-${target}`, source, target, port });
const now = new Date('2026-09-30T12:00:00.000Z');
const input = { text: 'test', eventType: 'MESSAGE' as const, now };
const makeRoot = (nodes: FlowNode[], edges: PublishedAutomation['graph']['edges']): PublishedAutomation =>
  ({ automationId: '11111111-1111-4111-8111-111111111111', version: 1, runtimeStateVersion: 2, graph: { nodes, edges } });
const noSubflow = async (): Promise<PublishedAutomation> => { throw new Error('Unexpected subflow'); };

// These assertions describe the order of the effects, never an unordered set.
describe('automation effect emission order', () => {
  it.each(['menu', 'input'] as const)('numbers a message then %s in emission order', async type => {
    const root = makeRoot([
      node('start', 'start'), node('hello', 'message', { text: 'Welcome' }),
      node('ask', type, { text: 'Choose', variable: 'answer', options: [{ value: '1', label: 'Help' }] }),
      node('end', 'end'),
    ], [edge('start', 'hello'), edge('hello', 'ask'), edge('ask', 'end', type === 'menu' ? 'option-1' : 'next')]);
    const result = await executeAutomation(root, input, noSubflow);
    expect(result.effects.map(effect => effect.ordinal)).toEqual([0, 1]);
    expect(result.effects.map(effect => effect.nodeId)).toEqual(['hello', 'ask']);
    expect(result.status).toBe('WAITING');
  });

  it('orders two messages before handoff', async () => {
    const root = makeRoot([
      node('start', 'start'), node('a', 'message', { text: 'A' }),
      node('b', 'message', { text: 'B' }), node('handoff', 'handoff'),
    ], [edge('start', 'a'), edge('a', 'b'), edge('b', 'handoff')]);
    const result = await executeAutomation(root, input, noSubflow);
    expect(result.effects.map(effect => [effect.ordinal, effect.kind])).toEqual([
      [0, 'SEND_TEXT'], [1, 'SEND_TEXT'], [2, 'HANDOFF'],
    ]);
  });

  it('includes IO in the same ordered effect stream', async () => {
    const root = makeRoot([
      node('start', 'start'), node('a', 'message', { text: 'A' }),
      node('io', 'code', { code: 'return input', target: 'result' }), node('end', 'end'),
    ], [edge('start', 'a'), edge('a', 'io'), edge('io', 'end', 'success'), edge('io', 'end', 'error')]);
    const result = await executeAutomation(root, input, noSubflow);
    expect(result.effects.map(effect => [effect.ordinal, effect.kind])).toEqual([[0, 'SEND_TEXT'], [1, 'IO_CODE']]);
  });

  it('does not reuse an ordinal when a child node executes twice in the same turn', async () => {
    const child: PublishedAutomation = {
      automationId: '22222222-2222-4222-8222-222222222222', version: 1, runtimeStateVersion: 2,
      graph: { nodes: [node('cs', 'start'), node('same-node', 'message', { text: 'Child' }), node('ce', 'end')],
        edges: [edge('cs', 'same-node'), edge('same-node', 'ce')] },
    };
    const config = { automationId: child.automationId, version: 1 };
    const root = makeRoot([node('start', 'start'), node('one', 'subflow', config), node('two', 'subflow', config), node('end', 'end')],
      [edge('start', 'one'), edge('one', 'two'), edge('two', 'end')]);
    const result = await executeAutomation(root, input, async () => child);
    expect(result.effects.map(effect => effect.nodeId)).toEqual(['same-node', 'same-node']);
    expect(result.effects.map(effect => effect.ordinal)).toEqual([0, 1]);
  });

  it('starts the local ordinal at zero for a new turn; persistence owns the durable offset', async () => {
    const root = makeRoot([node('start', 'start'), node('ask', 'input', { text: 'Name?', variable: 'name' }),
      node('reply', 'message', { text: 'Hello {{name}}' }), node('end', 'end')],
    [edge('start', 'ask'), edge('ask', 'reply'), edge('reply', 'end')]);
    const first = await executeAutomation(root, input, noSubflow);
    const second = await executeAutomation(root, { ...input, text: 'Example' }, noSubflow, first.state);
    expect(first.effects.map(effect => effect.ordinal)).toEqual([0]);
    expect(second.effects.map(effect => effect.ordinal)).toEqual([0]);
    expect(second.effects[0]?.payload.text).toBe('Hello Example');
  });
});
