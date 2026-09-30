import { describe, expect, it } from 'vitest';
import type { AutomationGraphV1 } from '@jrc/contracts';
import { executeAutomation } from '../../src/modules/automations/engine.js';
import type { RuntimeState } from '../../src/modules/automations/types.js';

const node = (id: string, type: string, data: Record<string, unknown> = {}) =>
  ({ id, type, label: id, position: { x: 0, y: 0 }, data });
const root = (middle = [node('request', 'http', { target: 'response' })]) => ({
  automationId: '11111111-1111-4111-8111-111111111111', version: 3, runtimeStateVersion: 2 as const,
  graph: { nodes: [node('start', 'start'), ...middle, node('end', 'end')],
    edges: [node('start', 'start'), ...middle].map((n, i) => ({
      id: String(i), source: n.id, target: middle[i]?.id ?? 'end', port: n.type === 'http' ? 'success' : 'next',
    })) } as AutomationGraphV1,
});
const resolve = async () => { throw new Error('UNEXPECTED_SUBFLOW'); };
const input = (text = '') => ({ text, eventType: 'MESSAGE' as const, now: new Date('2030-01-01T00:00:00Z') });
const resumed = (output: unknown) => ({ ...input(), eventType: 'RESUME' as const, payload: { outcome: 'success', output } });

describe('versioned runtime JSON state', () => {
  it('starts new conversations of historical published graphs with their textual IO semantics',async()=>{
    const {runtimeStateVersion:_version,...historical}=root([node('request','http',{target:'response'}),node('parse','json-parse',{source:'response',target:'decoded'})]);
    const first=await executeAutomation(historical,input(),resolve);
    const result=await executeAutomation(historical,resumed({ok:true}),resolve,first.state);
    expect(result.state.runtimeStateVersion).toBe(1);
    expect(result.state.variables.response).toBe('{"ok":true}');
    expect(result.state.variables.decoded).toBe('{"ok":true}');
  });
  it('rejects a subflow with different published data semantics before converting its inputs',async()=>{
    const child={...root(),automationId:'22222222-2222-4222-8222-222222222222',runtimeStateVersion:1 as const};
    const parent=root([node('call','subflow',{automationId:child.automationId,version:child.version,input:{data:{enabled:false}}})]);
    await expect(executeAutomation(parent,input(),async()=>child)).rejects.toThrow('AUTOMATION_SUBFLOW_RUNTIME_VERSION_MISMATCH');
  });
  it('rejects state whose semantics differ from the immutable published graph',async()=>{
    const flow=root(),first=await executeAutomation(flow,input(),resolve);
    await expect(executeAutomation({...flow,runtimeStateVersion:1},resumed({ok:true}),resolve,first.state))
      .rejects.toThrow('AUTOMATION_STATE_VERSION_MISMATCH');
  });
  it('preserves nested JSON values through IO, persistence and the next conversation turn', async () => {
    const flow = root([node('request', 'http', { target: 'response' }), node('answer', 'input', { variable: 'answer' })]);
    const first = await executeAutomation(flow, input('oi'), resolve);
    const output = { rows: [{ active: true, balance: 12.5 }], missing: null, text: '00042' };
    const second = await executeAutomation(flow, resumed(output), resolve, JSON.parse(JSON.stringify(first.state)));
    expect(second.state).toMatchObject({ runtimeStateVersion: 2, variables: { response: output } });
    const third = await executeAutomation(flow, input('Maria'), resolve, JSON.parse(JSON.stringify(second.state)));
    expect(third.state.variables.response).toEqual(output);
    expect(third.state.variables.answer).toBe('Maria');
  });
  it('does not truncate a long message or a captured answer at 4096 characters', async () => {
    const flow = root([node('answer', 'input', { variable: 'answer' })]);
    const long = 'á'.repeat(12000);
    const first = await executeAutomation(flow, input(long), resolve);
    expect(first.state.variables.message).toBe(long);
    const second = await executeAutomation(flow, input(long), resolve, first.state);
    expect(second.state.variables.answer).toBe(long);
  });
  it('preserves long rendered variables and text without silently truncating', async () => {
    const text = 'x'.repeat(12000);
    const flow = root([node('set', 'variable', { variable: 'long', value: text }),
      node('show', 'message', { text: '{{long}}' })]);
    const result = await executeAutomation(flow, input(), resolve);
    expect(result.state.variables.long).toBe(text);
    expect(result.effects[0]?.payload.text).toBe(text);
  });
  it('accepts the exact JSON byte limit and rejects one byte more without changing prior state', async () => {
    const flow = root(), first = await executeAutomation(flow, input(), resolve);
    const prior = JSON.stringify(first.state);
    const exact = 'x'.repeat(65534); // Includes the two JSON quotation bytes.
    expect((await executeAutomation(flow, resumed(exact), resolve, first.state)).state.variables.response).toBe(exact);
    await expect(executeAutomation(flow, resumed(exact + 'x'), resolve, first.state)).rejects.toThrow('AUTOMATION_STATE_VALUE_LIMIT');
    expect(JSON.stringify(first.state)).toBe(prior);
  });
  it('counts UTF-8 bytes rather than characters', async () => {
    const flow = root(), first = await executeAutomation(flow, input(), resolve);
    await expect(executeAutomation(flow, resumed('😀'.repeat(16384)), resolve, first.state))
      .rejects.toThrow('AUTOMATION_STATE_VALUE_LIMIT');
  });
  it('rejects aggregate state overflow although individual values fit', async () => {
    const middle = Array.from({ length: 5 }, (_, i) => node('set' + i, 'variable', { variable: 'v' + i, value: 'x'.repeat(60000) }));
    await expect(executeAutomation(root(middle), input(), resolve)).rejects.toThrow('AUTOMATION_STATE_TOTAL_LIMIT');
  });
  it.each([NaN, Infinity, undefined, { bad: undefined }, new Date(), BigInt(3)])('rejects a non-JSON IO value %s', async output => {
    const flow = root(), first = await executeAutomation(flow, input(), resolve);
    await expect(executeAutomation(flow, resumed(output), resolve, first.state)).rejects.toThrow('AUTOMATION_STATE_VALUE_INVALID');
  });
  it('rejects cyclic values before returning any effect or partially changing prior state', async () => {
    const flow = root(), first = await executeAutomation(flow, input(), resolve);
    const value: Record<string, unknown> = {}; value.self = value;
    await expect(executeAutomation(flow, resumed(value), resolve, first.state)).rejects.toThrow('AUTOMATION_STATE_VALUE_INVALID');
    expect(first.state.variables).not.toHaveProperty('response');
  });
  it('never executes array getters or custom toJSON while validating state', async () => {
    const flow = root(), first = await executeAutomation(flow, input(), resolve);
    let called = false;
    const value: unknown[] = [];
    Object.defineProperty(value, 'toJSON', { value: () => { called = true; return []; } });
    await expect(executeAutomation(flow, resumed(value), resolve, first.state)).rejects.toThrow('AUTOMATION_STATE_VALUE_INVALID');
    expect(called).toBe(false);
  });
  it('a timer or IO result preserves the most recent customer message in typed state', async () => {
    const flow = root(), first = await executeAutomation(flow, input('Consultar pedido'), resolve);
    const result = await executeAutomation(flow, resumed({ ok: true }), resolve, first.state);
    expect(result.state.variables.message).toBe('Consultar pedido');
  });
  it('an unrelated message cannot alter an outstanding IO wait', async () => {
    const flow = root(), first = await executeAutomation(flow, input('primeira'), resolve);
    const result = await executeAutomation(flow, input('segunda'), resolve, first.state);
    expect(result.state).toEqual(first.state);
    expect(result.effects).toEqual([]);
    expect(result.wait?.kind).toBe('IO');
  });
  it('loads historical string state without changing its representation', async () => {
    const flow = {...root(),runtimeStateVersion:1 as const}, first = await executeAutomation(flow, input(), resolve);
    const old = { ...first.state } as RuntimeState & { runtimeStateVersion?: number };
    delete old.runtimeStateVersion;
    old.variables.previous = '{"name":"Ana"}';
    const result = await executeAutomation(flow, resumed({ ok: true }), resolve, old);
    expect(result.state.variables.response).toBe('{"ok":true}');
    expect(result.state.variables.previous).toBe('{"name":"Ana"}');
    expect(result.state.runtimeStateVersion).toBe(1);
  });
  it('does not silently load an unknown state version', async () => {
    const flow = root(), first = await executeAutomation(flow, input(), resolve);
    const future = { ...first.state, runtimeStateVersion: 99 } as unknown as RuntimeState;
    await expect(executeAutomation(flow, resumed({ ok: true }), resolve, future)).rejects.toThrow('AUTOMATION_STATE_VERSION_UNSUPPORTED');
  });
  it('data nodes keep JSON strings distinct from JSON numbers in typed state', async () => {
    const flow = root([node('set', 'data-set', { target: 'literal', value: '123' }),
      node('copy', 'data-rename', { source: 'literal', target: 'copied' }),
      node('list', 'data-set', { target: 'rows', value: [{ enabled: true }] })]);
    const result = await executeAutomation(flow, input(), resolve);
    expect(result.state.variables).toMatchObject({ copied: '123', rows: [{ enabled: true }] });
    expect(result.state.variables).not.toHaveProperty('literal');
  });
});
