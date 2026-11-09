import { z } from 'zod';
import { AutomationPackageSchema, SUBFLOW_MAX_DEPTH, SUBFLOW_MAX_GRAPH_BYTES,
  type AutomationGraphV1, type AutomationPackageRequirement } from '@jrc/contracts';

export interface PreparedPackageFlow { key: string; id: string; name: string; graph: AutomationGraphV1 }
export interface PreparedPackage {
  rootKey: string; rootId: string; flows: PreparedPackageFlow[];
  publicationOrder: string[]; requirements: AutomationPackageRequirement[];
}
const credentialTypes = new Set(['http', 'sql', 'ai-generate', 'ai-classify', 'ai-extract', 'ai-summarize', 'ai-agent']);

/** Only executable reference fields are cleared. Business objects and text remain intact. */
export function clearPortableReferences(graph: AutomationGraphV1, flowKey: string) {
  const copy: AutomationGraphV1 = structuredClone(graph), requirements: AutomationPackageRequirement[] = [];
  for (const node of copy.nodes) {
    const clear = (kind: AutomationPackageRequirement['kind'], fields: string[]) => {
      requirements.push({ flowKey, nodeId: node.id, kind, fields });
      for (const field of fields) delete node.data[field];
    };
    if (credentialTypes.has(node.type)) clear('CREDENTIAL', ['credentialId', 'credentialRevision']);
    if (node.type === 'handoff') {
      clear('HANDOFF', ['destination', 'target']);
      // Partial native configuration cannot fall back to the legacy handoff path.
      if (node.data.handoffVersion !== 2) node.data.handoffVersion = 1;
    }
    if (['tag', 'attribute', 'note', 'resolve'].includes(node.type) && [1, 2].includes(Number(node.data.conversationEffectVersion))) {
      clear('CHANNEL', ['channelId']);
      if (['tag', 'attribute'].includes(node.type)) clear('RESOURCE', ['resourceId', 'resourceRevision']);
    }
    if (node.type === 'media' && [1, 2].includes(Number(node.data.mediaEffectVersion))) {
      clear('CHANNEL', ['channelId']); clear('MEDIA', ['mediaId', 'mediaRevision']);
    }
    if (node.type === 'domain') {
      clear('CHANNEL', ['channelId']);
      if (node.data.command === 'service_desk_intake') clear('DOMAIN', ['configurationId', 'configurationRevision']);
      if (['create_task', 'create_meeting'].includes(String(node.data.command))) clear('DOMAIN', ['ownerId']);
    }
  }
  return { graph: copy, requirements };
}

export function preparePortablePackage(input: unknown, allocateId: () => string): PreparedPackage {
  const parsed = AutomationPackageSchema.parse(input);
  const originals = new Map(parsed.flows.map(flow => [flow.key, flow]));
  const visited = new Set<string>(), active = new Set<string>(), publicationOrder: string[] = [];
  const heights = new Map<string, number>();
  let bytes = 0;
  const visit = (key: string, depth: number): number => {
    if (active.has(key)) throw new Error('AUTOMATION_PACKAGE_RECURSION');
    const current = originals.get(key);
    if (!current) throw new Error('AUTOMATION_PACKAGE_DEPENDENCY_MISSING');
    if (depth > SUBFLOW_MAX_DEPTH) throw new Error('AUTOMATION_PACKAGE_DEPTH_LIMIT');
    const height = heights.get(key);
    if (height !== undefined) {
      if (depth + height > SUBFLOW_MAX_DEPTH) throw new Error('AUTOMATION_PACKAGE_DEPTH_LIMIT');
      return height;
    }
    active.add(key); let subtreeHeight = 0;
    for (const node of current.graph.nodes.filter(item => item.type === 'subflow')) {
      if (typeof node.data.automationId !== 'string' || node.data.version !== 1)
        throw new Error('AUTOMATION_PACKAGE_DEPENDENCY_INVALID');
      subtreeHeight = Math.max(subtreeHeight, 1 + visit(node.data.automationId, depth + 1));
    }
    active.delete(key); visited.add(key); heights.set(key, subtreeHeight); publicationOrder.push(key);
    bytes += new TextEncoder().encode(JSON.stringify(current.graph)).byteLength;
    if (bytes > SUBFLOW_MAX_GRAPH_BYTES) throw new Error('AUTOMATION_PACKAGE_SIZE_LIMIT');
    return subtreeHeight;
  };
  visit(parsed.rootKey, 0);
  if (visited.size !== originals.size) throw new Error('AUTOMATION_PACKAGE_UNREACHABLE_FLOW');
  const ids = new Map(parsed.flows.map(flow => [flow.key, z.uuid().parse(allocateId())]));
  if (new Set(ids.values()).size !== ids.size) throw new Error('AUTOMATION_PACKAGE_ID_COLLISION');
  const requirements: AutomationPackageRequirement[] = [];
  const flows = parsed.flows.map(flow => {
    const local = clearPortableReferences(flow.graph, flow.key); requirements.push(...local.requirements);
    for (const node of local.graph.nodes.filter(item => item.type === 'subflow')) {
      node.data.automationId = ids.get(String(node.data.automationId))!;
      node.data.version = 1;
    }
    return { key: flow.key, id: ids.get(flow.key)!, name: flow.name, graph: local.graph };
  });
  return { rootKey: parsed.rootKey, rootId: ids.get(parsed.rootKey)!, flows, publicationOrder, requirements };
}
