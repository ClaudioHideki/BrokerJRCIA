import { z } from 'zod';

import { FlowGraphSchema, type FlowGraph } from './flows.js';
import { type FlowNode } from './flows.js';
import { AUTOMATION_NODE_DEFINITIONS, getNodeDefinition, type NodeDiagnostic } from './automation-node-definitions.js';
export { nodeDiagnosticsToStrings } from './automation-node-definitions.js';

export const AUTOMATION_CONTRACT_VERSION = 1 as const;
export const AUTOMATION_ORIGIN = 'jrc-automation-v2' as const;
export const AUTOMATION_NODE_CATALOG_V1 = AUTOMATION_NODE_DEFINITIONS.map(({ type, version, label, category, description, availability, unavailableReason, capabilitiesRequired, runtimeSupported }) => ({ type, version, label, category, description, availability, unavailableReason, capabilitiesRequired, runtimeSupported }));
export function automationNodePorts(node: FlowNode): string[] { return getNodeDefinition(node.type, 1)?.ports(node) ?? ['next']; }

const forbiddenSecretKey = /(?:access.?token|token|api.?key|secret|password|authorization|private.?key|connection.?string|credential)$/iu;

function findSecretKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenSecretKey.test(key)) return key;
    const found = findSecretKey(child);
    if (found) return found;
  }
  return null;
}

export const AutomationGraphV1Schema = FlowGraphSchema.superRefine((graph, context) => {
  const key = findSecretKey(graph);
  if (key) context.addIssue({ code: 'custom', message: `Secret field is not allowed in automation DTO: ${key}` });
});

/** Version-1 graph semantics. Creation availability never rejects existing nodes. */
export function validateAutomationGraph(input: unknown): NodeDiagnostic[] {
  const parsed = AutomationGraphV1Schema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map(issue => ({ nodeId: null, field: issue.path.join('.'), code: 'INVALID_GRAPH', message: issue.message }));
  const graph = parsed.data, diagnostics: NodeDiagnostic[] = [];
  const add = (nodeId: string | null, field: string, code: string, message: string) => {
    const node = graph.nodes.find(item => item.id === nodeId);
    diagnostics.push({ nodeId, field, code, message: node ? `${node.label}: ${message}` : message });
  };
  const ids = new Set<string>(), edgeIds = new Set<string>(), connected = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) add(node.id, 'id', 'DUPLICATE_NODE_ID', 'Os identificadores dos blocos devem ser únicos.');
    ids.add(node.id);
  }
  if (graph.nodes.filter(node => node.type === 'start').length !== 1) add(null, 'nodes', 'START_COUNT', 'O fluxo precisa de exatamente um início.');
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) add(edge.source, `edges.${edge.id}.id`, 'DUPLICATE_EDGE_ID', 'Os identificadores das conexões devem ser únicos.');
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target)) add(ids.has(edge.source) ? edge.source : null, `edges.${edge.id}`, 'MISSING_NODE', 'Conexão aponta para um bloco inexistente.');
    const key = JSON.stringify([edge.source, edge.port]);
    if (connected.has(key)) add(edge.source, `edges.${edge.id}.port`, 'DUPLICATE_PORT', 'Cada saída permite uma única conexão.');
    connected.add(key);
    const source = graph.nodes.find(node => node.id === edge.source), target = graph.nodes.find(node => node.id === edge.target);
    if (source && !automationNodePorts(source).includes(edge.port)) add(source.id, `edges.${edge.id}.port`, 'INVALID_PORT', 'saída inválida.');
    if (target?.type === 'start') add(edge.source, `edges.${edge.id}.target`, 'START_REENTRY', 'Uma conexão não pode retornar ao início.');
  }
  for (const node of graph.nodes) {
    const definition = getNodeDefinition(node.type, 1);
    if (!definition) { add(node.id, 'type', 'UNKNOWN_NODE_TYPE', `tipo ${node.type} ainda não suportado.`); continue; }
    if (!definition.runtimeSupported) add(node.id, 'type', 'RUNTIME_UNAVAILABLE', definition.unavailableReason!);
    for (const port of definition.ports(node)) if (!connected.has(JSON.stringify([node.id, port]))) add(node.id, `ports.${port}`, 'MISSING_CONNECTION', `conecte a saída ${port}.`);
    const configured = definition.schema.safeParse(node.data);
    if (!configured.success) for (const issue of configured.error.issues) add(node.id, ['data', ...issue.path].join('.'), 'INVALID_CONFIG', issue.message);
  }
  const reachable = new Set<string>(), active = new Set<string>(), visited = new Set<string>();
  const walk = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const edge of graph.edges.filter(item => item.source === id)) walk(edge.target); };
  const start = graph.nodes.find(node => node.type === 'start'); if (start) walk(start.id);
  for (const node of graph.nodes) if (!reachable.has(node.id)) add(node.id, 'id', 'UNREACHABLE_NODE', 'Há blocos sem caminho a partir do início.');
  const cycles = (id: string): boolean => {
    if (active.has(id)) return true; if (visited.has(id)) return false;
    visited.add(id); active.add(id);
    // Keep the historical version-1 rule; changing menu/delay cycle semantics requires an explicit migration.
    if (graph.nodes.find(node => node.id === id)?.type !== 'input') for (const edge of graph.edges.filter(item => item.source === id)) if (cycles(edge.target)) return true;
    active.delete(id); return false;
  };
  if (graph.nodes.some(node => cycles(node.id))) add(null, 'edges', 'CYCLE_WITHOUT_INPUT', 'Há um ciclo sem captura de resposta. Inclua uma espera por nova mensagem.');
  return diagnostics;
}

export const AutomationLifecycleStatusV1Schema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export const AutomationDefinitionV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  lifecycleStatus: AutomationLifecycleStatusV1Schema,
  draft: z.strictObject({
    revision: z.number().int().positive(),
    graph: AutomationGraphV1Schema,
  }),
  activeVersion: z.number().int().positive().nullable(),
  updatedAt: z.iso.datetime(),
}).refine(
  ({ lifecycleStatus, activeVersion }) => lifecycleStatus !== 'PUBLISHED' || activeVersion !== null,
  { message: 'Published automation requires an active version.', path: ['activeVersion'] },
);

export const AutomationPublishedVersionV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  automationId: z.uuid(),
  organizationId: z.uuid(),
  version: z.number().int().positive(),
  graph: AutomationGraphV1Schema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  publishedAt: z.iso.datetime(),
});

export const AutomationBindingV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  id: z.uuid(),
  organizationId: z.uuid(),
  automationId: z.uuid(),
  version: z.number().int().positive(),
  channelId: z.uuid(),
  humanDestinationId: z.uuid().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const AutomationExecutionSummaryV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_CONTRACT_VERSION),
  id: z.uuid(),
  organizationId: z.uuid(),
  automationId: z.uuid(),
  version: z.number().int().positive(),
  bindingId: z.uuid(),
  channelId: z.uuid(),
  status: z.enum(['QUEUED', 'RUNNING', 'WAITING', 'HANDOFF', 'COMPLETED', 'FAILED', 'CANCELED', 'UNKNOWN']),
  currentNodeId: z.string().min(1).max(100).nullable(),
  correlationId: z.uuid(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export interface LegacyFlowRecordV1 {
  id: string;
  name: string;
  graph: FlowGraph;
  revision: number;
  publishedVersion: number | null;
  updatedAt: string;
}

export function adaptLegacyFlowRecordToAutomationV1(
  flow: LegacyFlowRecordV1,
  organizationId: string,
): AutomationDefinitionV1 {
  return AutomationDefinitionV1Schema.parse({
    schemaVersion: AUTOMATION_CONTRACT_VERSION,
    id: flow.id,
    organizationId,
    name: flow.name,
    lifecycleStatus: flow.publishedVersion === null ? 'DRAFT' : 'PUBLISHED',
    draft: { revision: flow.revision, graph: flow.graph },
    activeVersion: flow.publishedVersion,
    updatedAt: flow.updatedAt,
  });
}

export type AutomationGraphV1 = z.infer<typeof AutomationGraphV1Schema>;
export type AutomationDefinitionV1 = z.infer<typeof AutomationDefinitionV1Schema>;
export type AutomationPublishedVersionV1 = z.infer<typeof AutomationPublishedVersionV1Schema>;
export type AutomationBindingV1 = z.infer<typeof AutomationBindingV1Schema>;
export type AutomationExecutionSummaryV1 = z.infer<typeof AutomationExecutionSummaryV1Schema>;
