import { describe, expect, it } from 'vitest';
import { getNodeDefinition, AUTOMATION_NODE_DEFINITIONS } from '../src/automation-node-definitions.js';
import { automationNodePorts, validateAutomationGraph, nodeDiagnosticsToStrings } from '../src/automations-v1.js';
import { welcomeFlow } from '../src/flows.js';
import { readFileSync } from 'node:fs';

describe('canonical automation node definitions', () => {
  it('keeps the documented available matrix aligned with tested editor/runtime families', () => {
    const documentation=readFileSync(new URL('../../../docs/automations/node-capabilities.md', import.meta.url),'utf8');
    const documented=[...documentation.matchAll(/^\| (\S+) \| AVAILABLE \|/gm)].map(match=>match[1]);
    expect(AUTOMATION_NODE_DEFINITIONS.filter(item=>item.availability==='AVAILABLE').map(item=>item.type)).toEqual(documented);
    for(const type of documented)expect(getNodeDefinition(type!,1)).toMatchObject({runtimeSupported:true,capabilitiesRequired:[],unavailableReason:null});
  });
  it('recognizes versioned legacy nodes independently of creation availability', () => {
    for (const type of ['sql', 'code', 'ai-agent', 'handoff', 'http', 'delay', 'media', 'schedule', 'tag', 'attribute', 'note', 'resolve']) {
      const definition = getNodeDefinition(type, 1);
      expect(definition, type).not.toBeNull();
      expect(definition?.availability).toBe('UNAVAILABLE');
      expect(definition?.unavailableReason).toBeTruthy();
    }
    expect(getNodeDefinition('message', 2)).toBeNull();
    expect(getNodeDefinition('unknown', 1)).toBeNull();
  });
  it('uses exactly the contract ports for every definition', () => {
    for (const definition of AUTOMATION_NODE_DEFINITIONS) {
      const node = { id: 'n', label: 'n', type: definition.type, position: { x: 0, y: 0 }, data: { options: [{ value: '1', label: 'A' }, { value: '2', label: 'B' }] } };
      expect(automationNodePorts(node)).toEqual(definition.ports(node));
    }
  });
  it('retains the legacy optional question and null subflow timeout semantics',()=>{
    expect(getNodeDefinition('input',1)?.schema.safeParse({variable:'answer'}).success).toBe(true);
    expect(getNodeDefinition('subflow',1)?.schema.safeParse({automationId:'11111111-1111-4111-8111-111111111111',version:'1',timeoutMs:null}).success).toBe(true);
  });
  it('locates missing configuration by stable identity even with duplicate labels', () => {
    const graph = welcomeFlow();
    graph.nodes[1]!.label = graph.nodes[0]!.label;
    graph.nodes[1]!.data = {};
    const diagnostics = validateAutomationGraph(graph);
    expect(diagnostics).toContainEqual(expect.objectContaining({ nodeId: 'welcome', field: 'data.text', code: 'INVALID_CONFIG' }));
    expect(nodeDiagnosticsToStrings(diagnostics)).toEqual(diagnostics.map(item => item.message));
  });
  it('does not mask invalid ports when advanced and basic nodes share labels', () => {
    const graph = welcomeFlow();
    graph.nodes.push({ id: 'wait', label: graph.nodes[1]!.label, type: 'delay', position: { x: 0, y: 0 }, data: { seconds: 1 } });
    graph.edges[1]!.port = 'bad';
    graph.edges.push({ id: 'w', source: 'wait', target: 'end', port: 'next' });
    expect(validateAutomationGraph(graph)).toContainEqual(expect.objectContaining({ nodeId: 'welcome', field: 'edges.e2.port', code: 'INVALID_PORT' }));
  });
  it('reports missing settings for each newly defined capability', () => {
    for (const [type, field] of [['media', 'url'], ['schedule', 'timezone'], ['tag', 'tag'], ['attribute', 'name'], ['note', 'text'], ['http', 'url'], ['input', 'variable'], ['menu', 'options'], ['condition', 'field']]) {
      const graph = welcomeFlow(); graph.nodes[1]!.type = type!; graph.nodes[1]!.data = {};
      expect(validateAutomationGraph(graph), type).toContainEqual(expect.objectContaining({ nodeId: 'welcome', field: `data.${field}`, code: 'INVALID_CONFIG' }));
    }
  });
});
