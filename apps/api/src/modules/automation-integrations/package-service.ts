import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUTOMATION_PACKAGE_FORMAT, AutomationHandoffConfigSchema, AutomationPackageSchema,
  withDependencyPolicyV1, type AutomationPackage, type AutomationPackageRequirement } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { requireAutomationDraftAccess, type AutomationService } from '../automations/service.js';
import { AutomationError } from '../automations/errors.js';
import { createPostgresAutomationRepository, type AutomationRepository } from '../automations/repository.js';
import { prepareSubflowSnapshot } from '../automations/subflow-dependencies.js';
import { claimIdempotency, completeIdempotencyRecord, hashIdempotencyRequest } from '../instances/idempotency.js';
import { clearPortableReferences, preparePortablePackage } from './portable-package.js';
import { createPackageStore, type PackageRecord, type PackageStore } from './package-store.js';

interface PackageServiceOptions {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  repository?: AutomationRepository; store?: PackageStore;
  automations: Pick<AutomationService, 'get' | 'save' | 'versions' | 'publish'>;
}
const fail = (code: string, status = 409): never => { throw new AutomationError(`AUTOMATION_PACKAGE_${code}`, status); };
function publicRecord(record: PackageRecord) {
  const { leaseToken: _lease, leaseExpiresAt: _expires, publishKey: _key, publishRevision: _revision, ...value } = record;
  const state: PackageRecord['state'] = record.state === 'PUBLISHING' && (record.leaseExpiresAt ?? 0) <= Date.now() ? 'UNKNOWN' : record.state;
  return { ...value, state };
}
export function createAutomationPackageService(options: PackageServiceOptions) {
  const repository = options.repository ?? createPostgresAutomationRepository(), store = options.store ?? createPackageStore();
  const read = async (tx: TenantTransaction, org: string, id: string, lock = false) => {
    await requireAutomationDraftAccess(tx, org);
    const record = await store.get(tx, org, id, lock);
    if (!record || record.organizationId !== org) return fail('NOT_FOUND', 404);
    return record;
  };
  const get = (org: string, id: string) => options.transact(org, async tx => publicRecord(await read(tx, org, id)));
  return {
    preview: (_org: string, input: unknown) => {
      const prepared = preparePortablePackage(input, randomUUID);
      return { ...prepared, createdAsDraft: false, autoPublished: false };
    },
    get,
    async import(org: string, input: unknown, key: string) {
      return options.transact(org, async tx => {
        await requireAutomationDraftAccess(tx, org);
        const claim = await claimIdempotency(tx, { organizationId: org, route: 'POST /v1/automation-packages', key,
          requestHash: hashIdempotencyRequest(input), expiresAt: new Date(Date.now() + 7 * 86400000) });
        if (claim.kind === 'REPLAY') {
          const id = z.uuid().safeParse(claim.record.responseMetadata.packageId);
          if (claim.record.status !== 'COMPLETED' || !id.success) return fail('REPLAY_UNAVAILABLE', 503);
          return publicRecord(await read(tx, org, id.data));
        }
        const prepared = preparePortablePackage(input, randomUUID);
        for (const flow of prepared.flows) await repository.insertDefinition(tx, { org, id: flow.id, name: flow.name, graph: flow.graph });
        const record: PackageRecord = { id: randomUUID(), organizationId: org, revision: 1,
          rootKey: prepared.rootKey, rootId: prepared.rootId, flows: prepared.flows.map(({ key, id, name }) => ({ key, id, name })),
          publicationOrder: prepared.publicationOrder, requirements: prepared.requirements, publications: {}, state: 'DRAFT',
          publishKey: null, publishRevision: null, leaseToken: null, leaseExpiresAt: null };
        await store.insert(tx, record);
        await completeIdempotencyRecord(tx, { organizationId: org, recordId: claim.recordId, status: 'COMPLETED', responseMetadata: { packageId: record.id } });
        return publicRecord(record);
      });
    },
    async export(org: string, id: string, version: number): Promise<AutomationPackage> {
      return options.transact(org, async tx => {
        await requireAutomationDraftAccess(tx, org);
        const row = await repository.getVersion(tx, org, id, version);
        if (!row) return fail('NOT_FOUND', 404);
        const root = { automationId: id, version, graph: row.graph, runtimeStateVersion: row.runtimeStateVersion ?? 1 };
        let snapshot: Awaited<ReturnType<typeof prepareSubflowSnapshot>>;
        try { snapshot = await prepareSubflowSnapshot(tx, org, root, repository, 'NEW'); }
        catch { return fail('DEPENDENCY_MISSING', 422); }
        if (snapshot.versions.some(v => v.runtimeStateVersion !== 2)) return fail('RUNTIME_UNSUPPORTED', 422);
        const keys = new Map(snapshot.versions.map((v, at) => [`${v.automationId}:${v.version}`, `flow-${at + 1}`]));
        const flows: AutomationPackage['flows'] = [];
        for (const value of snapshot.versions) {
          const definition = await repository.getDefinition(tx, org, value.automationId);
          if (!definition || definition.lifecycleStatus === 'ARCHIVED') return fail('DEPENDENCY_MISSING', 422);
          const key = keys.get(`${value.automationId}:${value.version}`)!, local = clearPortableReferences(value.graph, key);
          for (const node of local.graph.nodes.filter(n => n.type === 'subflow')) {
            const target = keys.get(`${String(node.data.automationId)}:${Number(node.data.version)}`);
            if (!target) return fail('DEPENDENCY_MISSING', 422);
            node.data.automationId = target; node.data.version = 1;
          }
          flows.push({ key, name: definition.name, graph: local.graph });
        }
        return AutomationPackageSchema.parse({ format: AUTOMATION_PACKAGE_FORMAT, rootKey: keys.get(`${id}:${version}`)!, flows });
      });
    },
    async publish(org: string, id: string, revision: number, key: string) {
      const lease = randomUUID();
      const record = await options.transact(org, async tx => {
        const row = await read(tx, org, id, true);
        if (row.publishKey === key && row.publishRevision === revision && row.state === 'PUBLISHED') return row;
        if (row.publishKey !== key && row.revision !== revision || row.publishKey === key && row.publishRevision !== revision) return fail('CHANGED');
        if (row.leaseToken && (row.leaseExpiresAt ?? 0) > Date.now()) return fail('PUBLICATION_IN_PROGRESS');
        if (row.state === 'PUBLISHED') return fail('ALREADY_PUBLISHED');
        row.state = 'PUBLISHING'; row.publishKey = key; row.publishRevision = revision;
        row.leaseToken = lease; row.leaseExpiresAt = Date.now() + 600000;
        return store.put(tx, row);
      });
      if (record.state === 'PUBLISHED') return publicRecord(record);
      const leaseRead = async (tx: TenantTransaction) => {
        const row = await read(tx, org, id, true);
        if (row.leaseToken !== lease || (row.leaseExpiresAt ?? 0) <= Date.now()) return fail('LEASE_LOST');
        return row;
      };
      try {
        for (const flowKey of record.publicationOrder) {
          const current = await options.transact(org, leaseRead);
          if (Object.hasOwn(current.publications, flowKey)) continue;
          const reference = current.flows.find(flow => flow.key === flowKey)!;
          let definition = await options.automations.get(org, reference.id);
          const graph = structuredClone(definition.draft.graph);
          for (const node of graph.nodes.filter(n => n.type === 'subflow')) {
            const child = current.flows.find(flow => flow.id === node.data.automationId);
            if (!child || !Object.hasOwn(current.publications, child.key)) return fail('DEPENDENCY_CHANGED');
            node.data.version = current.publications[child.key]!.version;
          }
          const missing = current.requirements.filter(r => r.flowKey === flowKey).filter(r => !resolved(r, graph));
          if (missing.length) return fail('LOCAL_REFERENCES_REQUIRED', 422);
          if (hashIdempotencyRequest(graph) !== hashIdempotencyRequest(definition.draft.graph))
            definition = await options.automations.save(org, reference.id, { name: definition.name, graph, revision: definition.draft.revision });
          const expected = hashIdempotencyRequest(withDependencyPolicyV1(definition.draft.graph));
          const findPublished = async () => (await options.automations.versions(org, reference.id)).data
            .find(v => hashIdempotencyRequest(v.graph) === expected);
          // A commit acknowledgement can be lost. Re-read immutable versions before retrying a publish.
          let published = await findPublished();
          if (!published) {
            await options.transact(org, leaseRead);
            try { published = await options.automations.publish(org, reference.id, definition.draft.revision); }
            catch (error) { published = await findPublished(); if (!published) throw error; }
          }
          await options.transact(org, async tx => {
            const row = await leaseRead(tx);
            row.publications[flowKey] = { version: published!.version, checksum: published!.checksum, draftRevision: definition.draft.revision };
            row.revision++; row.leaseExpiresAt = Date.now() + 600000; await store.put(tx, row);
          });
        }
        return await options.transact(org, async tx => {
          const row = await leaseRead(tx); row.state = 'PUBLISHED'; row.leaseToken = null; row.leaseExpiresAt = null; row.revision++;
          return publicRecord(await store.put(tx, row));
        });
      } catch (error) {
        await options.transact(org, async tx => {
          const row = await read(tx, org, id, true);
          if (row.leaseToken === lease) { row.state = 'UNKNOWN'; row.leaseToken = null; row.leaseExpiresAt = null; await store.put(tx, row); }
        });
        throw error;
      }
    },
  };
}
function resolved(requirement: AutomationPackageRequirement, graph: { nodes: Array<{ id: string; data: Record<string, unknown> }> }) {
  const data = graph.nodes.find(node => node.id === requirement.nodeId)?.data;
  if (!data) return false;
  if (requirement.kind === 'HANDOFF') return AutomationHandoffConfigSchema.safeParse(data).success;
  if (requirement.kind === 'CREDENTIAL') return z.uuid().safeParse(data.credentialId).success;
  return requirement.fields.every(field => data[field] !== undefined && data[field] !== null && data[field] !== '');
}
export type AutomationPackageService = ReturnType<typeof createAutomationPackageService>;
