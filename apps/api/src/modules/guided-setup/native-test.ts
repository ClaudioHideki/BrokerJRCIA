import { withDependencyPolicyV1 } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { AutomationService } from '../automations/service.js';
import { createPostgresAutomationRepository, type AutomationRepository } from '../automations/repository.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import type { SetupPrincipal } from './service.js';
import { setupFail } from './service.js';
import type { SetupRecord } from './repository.js';
import { prepareTestMedia } from './test-media.js';

interface TestPreparerOptions {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  repository?: AutomationRepository; automations: Pick<AutomationService, 'create' | 'save' | 'versions' | 'publish'>;
}
export function createNativeTestPreparer(options: TestPreparerOptions) {
  const repository = options.repository ?? createPostgresAutomationRepository();
  return async (principal: SetupPrincipal, record: SetupRecord, keyword: string, key: string) => {
    const org = principal.organizationId, selected = record.selection;
    if (!selected.automationId || !selected.version) return setupFail('FLOW_REQUIRED');
    const source = await options.transact(org, tx => repository.getVersion(tx, org, selected.automationId!, selected.version!));
    if (!source || source.runtimeStateVersion !== 2) return setupFail('FLOW_UNAVAILABLE');
    const graph = structuredClone(source.graph), start = graph.nodes.find(node => node.type === 'start');
    if (!start) return setupFail('FLOW_UNAVAILABLE');
    Object.assign(start.data, { entryConfigVersion: 1, trigger: 'MESSAGE_RECEIVED', reentry: 'ONCE_PER_CONVERSATION',
      keywords: { mode: 'EXACT', terms: [keyword], quantifier: 'ANY', ignoreCase: true, ignoreAccents: true } });
    let definition = await options.automations.create(org, { name: `${record.name.slice(0, 90)} - teste guiado`, graph },
      `guided-test:${hashIdempotencyRequest({ setupId: record.id, key, selected, keyword })}`);
    const local = await options.transact(org, tx => prepareTestMedia(tx, org, selected.automationId!, definition.id, graph));
    const currentHash = hashIdempotencyRequest(definition.draft.graph), localHash = hashIdempotencyRequest(local);
    if (definition.lifecycleStatus === 'ARCHIVED' || currentHash !== hashIdempotencyRequest(graph) && currentHash !== localHash)
      return setupFail('TEST_DRAFT_CHANGED');
    if (currentHash !== localHash) definition = await options.automations.save(org, definition.id, { name: definition.name, graph: local, revision: definition.draft.revision });
    const expected = hashIdempotencyRequest(withDependencyPolicyV1(local));
    const find = async () => (await options.automations.versions(org, definition.id)).data.find(value => hashIdempotencyRequest(value.graph) === expected);
    let published = await find();
    if (!published) {
      try { published = await options.automations.publish(org, definition.id, definition.draft.revision); }
      catch (error) { published = await find(); if (!published) throw error; }
    }
    return { automationId: definition.id, version: published.version };
  };
}
