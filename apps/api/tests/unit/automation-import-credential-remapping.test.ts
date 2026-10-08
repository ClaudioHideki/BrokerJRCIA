import { describe, expect, it } from 'vitest';
import { automationNodePorts, validateAutomationGraph, welcomeFlow, type FlowGraph, type FlowNode } from '@jrc/contracts';
import { convertAutomationArtifact, createAutomationImporter } from '../../src/modules/automation-integrations/importer.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { hashIdempotencyRequest } from '../../src/modules/instances/idempotency.js';

const credential = '11111111-1111-4111-8111-111111111111';
const organization = '22222222-2222-4222-8222-222222222222';
const artifact = '33333333-3333-4333-8333-333333333333';
const encryptionKey = Buffer.alloc(32, 8).toString('base64');
const keyring = JSON.stringify({ 1: encryptionKey });
const node = (id: string, type: string, data: Record<string, unknown> = {}): FlowNode => ({
  id, type, label: `Bloco ${id}`, position: { x: 120, y: 80 }, data,
});
function graphFor(type: string): FlowGraph {
  const action = node('action', type, { target: 'result', credentialId: credential, url: 'https://service.example.test/read',
    method: 'GET', query: 'SELECT 1', model: 'test-model', content: '{{message}}',
    body: { credentialId: 'business-reference', text: 'Nome comercial: apiKey; token é parte da descrição.' } });
  return { nodes: [node('start', 'start'), action, node('end', 'end')], edges: [
    { id: 'entry', source: 'start', target: 'action', port: 'next' },
    ...automationNodePorts(action).map(port => ({ id: `branch-${port}`, source: 'action', target: 'end', port })),
  ] };
}
const content = (graph: FlowGraph, format = 'jrc-broker-flows/1') => JSON.stringify({ format, flow: { name: 'Atendimento sintético', graph } });

describe('explicit credential remapping in new native imports', () => {
  it.each(['http', 'sql', 'ai-generate', 'ai-classify', 'ai-extract', 'ai-summarize', 'ai-agent'])('removes only the explicit %s credential reference and requires a local selection', type => {
    const original = graphFor(type), result = convertAutomationArtifact('AUTO', content(original));
    const action = result.graph.nodes.find(item => item.id === 'action')!;
    expect(action.data).not.toHaveProperty('credentialId');
    expect(action.data).toMatchObject({ target: 'result', method: 'GET', url: 'https://service.example.test/read',
      body: { credentialId: 'business-reference', text: 'Nome comercial: apiKey; token é parte da descrição.' } });
    expect(action.label).toBe('Bloco action');
    expect(action.position).toEqual({ x: 120, y: 80 });
    expect(result.graph.edges).toEqual(original.edges);
    expect(result.graph.nodes.map(item => item.id)).toEqual(['start', 'action', 'end']);
    expect(result.report.summary).toMatchObject({ credentialsRemoved: true, autoPublished: false,
      manualReviewRequired: true, exact: 2, partial: 1, unsupported: 0 });
    const report = result.report.nodes.find(item => item.sourceId === 'action')!;
    expect(report.classification).toBe('PARTIAL');
    expect(report.notes.join(' ')).toMatch(/data\.credentialId.*credencial.*local/);
    expect(validateAutomationGraph(result.graph)).toContainEqual(expect.objectContaining({
      nodeId: 'action', field: 'data.credentialId', code: 'INVALID_CONFIG',
    }));
    expect(original.nodes[1]!.data.credentialId).toBe(credential);
  });

  it.each(['jrc-flows/1', 'jrc-flows/2', 'jrc-broker-flows/1'])('applies remapping to the supported native wrapper %s', format => {
    const result = convertAutomationArtifact('JRC', content(graphFor('http'), format));
    expect(result.graph.nodes.find(item => item.id === 'action')!.data).not.toHaveProperty('credentialId');
  });

  it('does not claim a removal when the native artifact carries no explicit credential reference', () => {
    const result = convertAutomationArtifact('AUTO', content(welcomeFlow()));
    expect(result.report.summary).toMatchObject({ credentialsRemoved: false, manualReviewRequired: false, exact: 3 });
    expect(result.graph).toEqual(welcomeFlow());
  });

  it('preserves UUIDs, subflow references and similarly named business data on other node types', () => {
    const source = welcomeFlow();
    source.nodes[0]!.id = credential;
    source.edges[0]!.source = credential;
    source.edges[0]!.id = credential;
    source.nodes[1]!.data = { text: `Código ${credential}; apiKey é o nome comercial.`, credentialId: credential };
    const call = node('call', 'subflow', { automationId: credential, version: 7, credentialId: 'metadata-reference' });
    source.nodes.splice(2, 0, call);
    source.edges[1]!.target = 'call';
    source.edges.push({ id: 'return', source: 'call', target: 'end', port: 'next' });
    const result = convertAutomationArtifact('AUTO', content(source));
    expect(result.graph).toEqual(source);
    expect(result.report.summary.credentialsRemoved).toBe(false);
  });

  it('preserves all 150 native nodes and every edge when only credential selection is required', () => {
    const source = graphFor('http'), messages = Array.from({ length: 147 }, (_, index) => node(`message-${index}`, 'message', { text: `Mensagem ${index}` }));
    source.nodes.splice(2, 0, ...messages);
    source.edges = source.edges.map(edge => edge.source === 'action' ? { ...edge, target: 'message-0' } : edge);
    for (const [index, current] of messages.entries()) source.edges.push({ id: `message-edge-${index}`, source: current.id,
      target: messages[index + 1]?.id ?? 'end', port: 'next' });
    const result = convertAutomationArtifact('AUTO', content(source));
    expect(result.graph.nodes).toHaveLength(150);
    expect(result.graph.nodes.map(item => ({ id: item.id, type: item.type, label: item.label, position: item.position })))
      .toEqual(source.nodes.map(item => ({ id: item.id, type: item.type, label: item.label, position: item.position })));
    expect(result.graph.nodes.at(-1)).toEqual(source.nodes.at(-1));
    expect(result.graph.edges).toEqual(source.edges);
    expect(result.report.summary).toMatchObject({ partial: 1, unsupported: 0, manualReviewRequired: true });
    expect(validateAutomationGraph(result.graph).map(item => ({ nodeId: item.nodeId, field: item.field })))
      .toEqual([{ nodeId: 'action', field: 'data.credentialId' }]);
  });

  it('previews a remapped draft without performing persistence', () => {
    const importer = createAutomationImporter({ keyring, transact: async () => { throw new Error('PREVIEW_MUST_NOT_PERSIST'); } });
    const result = importer.preview(organization, { source: 'AUTO', content: content(graphFor('http')) });
    expect(result.createdAsDraft).toBe(false);
    expect(result.report.summary.autoPublished).toBe(false);
    expect(result.graph.nodes.find(item => item.id === 'action')!.data).not.toHaveProperty('credentialId');
  });

  it('persists only the remapped new draft while keeping the encrypted original artifact intact', async () => {
    const raw = content(graphFor('http'));
    let stored: { encrypted: string; graph: FlowGraph } | null = null;
    const query = async (statement: string, params: readonly unknown[] = []) => {
      if (statement.includes('tenant_is_active')) return { rows: [{ active: true }] };
      if (statement.includes('from organizations')) return { rows: [{ status: 'ACTIVE', moduleEnabled: true }] };
      if (statement.includes('INSERT INTO idempotency_records')) return { rows: [{ id: 'claim-new' }] };
      if (statement.includes('insert into automation_import_artifacts')) {
        stored = { encrypted: String(params[4]), graph: JSON.parse(String(params[7])) as FlowGraph };
        return { rows: [] };
      }
      if (statement.includes('UPDATE idempotency_records') || statement.includes('DELETE FROM idempotency_records')) return { rows: [] };
      throw new Error(`Unexpected storage query: ${statement}`);
    };
    const importer = createAutomationImporter({ keyring, transact: async (_org, work) => work({ query } as never) });
    const result = await importer.import(organization, { source: 'AUTO', content: raw }, 'new-draft');
    expect(result.createdAsDraft).toBe(true);
    expect(result.report.summary.autoPublished).toBe(false);
    expect(result.graph.nodes.find(item => item.id === 'action')!.data).not.toHaveProperty('credentialId');
    const persisted = stored as unknown as { encrypted: string; graph: FlowGraph };
    expect(persisted.graph).toEqual(result.graph);
    const original = createIntegrationSecrets(encryptionKey).decrypt(`${organization}:automation-import:${result.id}:key-1`, persisted.encrypted);
    expect(original).toBe(raw);
  });

  it('returns a previously persisted artifact unchanged on replay instead of rewriting its historical graph', async () => {
    const graph = graphFor('http'), raw = content(graph), historical = convertAutomationArtifact('AUTO', content(welcomeFlow())).report;
    const encryptedOriginal = createIntegrationSecrets(encryptionKey).encrypt(`${organization}:automation-import:${artifact}:key-1`, raw);
    const writes: string[] = [];
    const query = async (statement: string) => {
      if (statement.includes('tenant_is_active')) return { rows: [{ active: true }] };
      if (statement.includes('from organizations')) return { rows: [{ status: 'ACTIVE', moduleEnabled: true }] };
      if (statement.includes('INSERT INTO idempotency_records') || statement.includes('DELETE FROM idempotency_records')) return { rows: [] };
      if (statement.includes('FROM idempotency_records')) return { rows: [{ id: 'old-claim', organizationId: organization,
        requestHash: hashIdempotencyRequest({ source: 'AUTO', content: raw, formatVersion: null }), status: 'COMPLETED', responseMetadata: { artifactId: artifact } }] };
      if (statement.includes('from automation_import_artifacts')) return { rows: [{ source: 'JRC', encryptedOriginal,
        keyVersion: 1, report: historical, convertedGraph: graph }] };
      writes.push(statement);
      throw new Error(`Historical artifact must not be changed: ${statement}`);
    };
    const importer = createAutomationImporter({ keyring, transact: async (_org, work) => work({ query } as never) });
    const result = await importer.import(organization, { source: 'AUTO', content: raw }, 'old-confirmation');
    expect(result.id).toBe(artifact);
    expect(result.graph).toEqual(graph);
    expect(result.graph.nodes[1]!.data.credentialId).toBe(credential);
    expect(result.report).toEqual(historical);
    expect(writes).toEqual([]);
  });
});
