import { AutomationHandoffConfigV1Schema } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { createPostgresAutomationRepository, type AutomationRepository } from '../automations/repository.js';
import { createPackageStore, type PackageStore } from '../automation-integrations/package-store.js';
import type { SetupSnapshot } from './readiness.js';
import { setupFail } from './service.js';

export function createPackageDraftLocalizer(options: { repository?: AutomationRepository; store?: PackageStore } = {}) {
  const repository = options.repository ?? createPostgresAutomationRepository(), store = options.store ?? createPackageStore();
  return async (tx: TenantTransaction, org: string, id: string, snapshot: SetupSnapshot) => {
    if (snapshot.organizationId !== org || !snapshot.channelId || !snapshot.destination?.ready || !snapshot.agents.targetValid || !snapshot.agents.target ||
      !snapshot.agents.selected.length || snapshot.agents.selected.some(agent => !snapshot.agents.eligible.includes(agent))) return setupFail('DESTINATION_REQUIRED');
    const record = await store.get(tx, org, id, true);
    if (!record || record.organizationId !== org) return setupFail('PACKAGE_NOT_FOUND', 404);
    if (record.state !== 'DRAFT' || Object.keys(record.publications).length) return setupFail('PACKAGE_ALREADY_PUBLISHED');
    const rows = [];
    for (const flow of [...record.flows].sort((a, b) => a.id.localeCompare(b.id))) {
      const row = await repository.getDefinition(tx, org, flow.id, true);
      if (!row || row.organizationId !== org || row.lifecycleStatus !== 'DRAFT' || row.activeVersion !== null) return setupFail('PACKAGE_ALREADY_PUBLISHED');
      rows.push({ row, flow });
    }
    const { ready: _ready, origin: _origin, ...destination } = snapshot.destination;
    const handoff = AutomationHandoffConfigV1Schema.parse({ handoffVersion: 1, destination, target: snapshot.agents.target });
    for (const { row, flow } of rows) {
      const graph = structuredClone(row.draftGraph);
      for (const requirement of record.requirements.filter(item => item.flowKey === flow.key)) {
        const node = graph.nodes.find(item => item.id === requirement.nodeId);
        if (!node) return setupFail('PACKAGE_CHANGED');
        if (requirement.kind === 'HANDOFF') node.data = structuredClone(handoff);
        if (requirement.kind === 'CHANNEL') node.data.channelId = snapshot.channelId;
      }
      const updated = await repository.updateDefinition(tx, { org, id: row.id, name: row.name, graph, revision: row.draftRevision });
      if (!updated) return setupFail('PACKAGE_CHANGED');
    }
    record.revision++; await store.put(tx, record);
  };
}
