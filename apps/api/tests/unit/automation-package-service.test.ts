import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { withDependencyPolicyV1, type AutomationGraphV1 } from '@jrc/contracts';
import type { DefinitionRow, VersionRow } from '../../src/modules/automations/repository.js';
import { hashIdempotencyRequest } from '../../src/modules/instances/idempotency.js';

const org = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, data });
const graph = (children: string[] = []): AutomationGraphV1 => {
  const nodes = [node('start', 'start'), ...children.map((id, i) =>
    node(`call-${i}`, 'subflow', { automationId: id, version: 1, timeoutMs: 10000 })), node('end', 'end')];
  return { nodes, edges: nodes.slice(0, -1).map((n, i) => ({ id: `edge-${i}`, source: n.id, target: nodes[i + 1]!.id, port: 'next' })) };
};
const artifact = () => ({ format: 'jrc-broker-package/1', rootKey: 'root', flows: [
  { key: 'root', name: 'Root', graph: graph(['child']) }, { key: 'child', name: 'Child', graph: graph() },
] });

async function fixture() {
  const mod = await import('../../src/modules/automation-integrations/package-service.js').catch(() => null);
  expect(mod, 'package service must exist').not.toBeNull();
  const definitions = new Map<string, DefinitionRow>(), versions = new Map<string, VersionRow[]>(), records = new Map<string, any>();
  const claims = new Map<string, any>(); let failInsert = false, failAfterPublication = false;
  const transact = async (tenant: string, work: (tx: any) => Promise<any>) => {
    const before = structuredClone({ definitions, records, claims });
    try { return await work({ tenant, query: async (sql: string, p: unknown[]) => {
      if (/tenant_is_active/i.test(sql)) return { rows: [{ active: true }] };
      if (/from organizations/i.test(sql)) return { rows: [{ status: 'ACTIVE', moduleEnabled: true }] };
      if (/DELETE FROM idempotency_records/i.test(sql)) return { rows: [] };
      if (/INSERT INTO idempotency_records/i.test(sql)) {
        const key = `${p[0]}:${p[1]}:${p[2]}`;
        if (claims.has(key)) return { rows: [] };
        const claim = { id: randomUUID(), requestHash: p[3], status: 'IN_PROGRESS', responseMetadata: {} };
        claims.set(key, claim); return { rows: [claim] };
      }
      if (/FROM idempotency_records/i.test(sql)) return { rows: [claims.get(`${p[0]}:${p[1]}:${p[2]}`)] };
      if (/UPDATE idempotency_records/i.test(sql)) {
        const claim = [...claims.values()].find(c => c.id === p[1]);
        Object.assign(claim, { status: p[2], responseMetadata: typeof p[3] === 'string' ? JSON.parse(p[3]) : p[3] });
        return { rows: [] };
      }
      throw new Error('Unexpected query: ' + sql);
    } }); }
    catch (error) {
      definitions.clear(); before.definitions.forEach((v, k) => definitions.set(k, v));
      records.clear(); before.records.forEach((v, k) => records.set(k, v));
      claims.clear(); before.claims.forEach((v, k) => claims.set(k, v)); throw error;
    }
  };
  const repository = {
    insertDefinition: async (tx: any, input: any) => {
      if (failInsert && input.name === 'Child') throw new Error('INSERT_FAILED');
      const row: DefinitionRow = { id: input.id, organizationId: tx.tenant, name: input.name, draftGraph: input.graph,
        draftRevision: 1, activeVersion: null, lifecycleStatus: 'DRAFT', updatedAt: new Date() };
      definitions.set(`${tx.tenant}:${row.id}`, row); return row;
    },
    getDefinition: async (_tx: any, tenant: string, id: string) => definitions.get(`${tenant}:${id}`) ?? null,
    getVersion: async (_tx: any, tenant: string, id: string, version: number) => versions.get(`${tenant}:${id}`)?.find(v => v.version === version) ?? null,
  };
  const store = {
    insert: async (tx: any, record: any) => { records.set(`${tx.tenant}:${record.id}`, structuredClone(record)); return structuredClone(record); },
    get: async (_tx: any, tenant: string, id: string) => structuredClone(records.get(`${tenant}:${id}`) ?? null),
    put: async (tx: any, record: any) => { records.set(`${tx.tenant}:${record.id}`, structuredClone(record)); return structuredClone(record); },
  };
  const get = async (tenant: string, id: string) => {
    const row = definitions.get(`${tenant}:${id}`)!;
    return { id: row.id, organizationId: tenant, name: row.name, lifecycleStatus: row.lifecycleStatus,
      activeVersion: row.activeVersion, draft: { revision: row.draftRevision, graph: structuredClone(row.draftGraph) } };
  };
  const automations = {
    get, versions: async (tenant: string, id: string) => ({ data: versions.get(`${tenant}:${id}`) ?? [] }),
    save: async (tenant: string, id: string, value: any) => {
      const row = definitions.get(`${tenant}:${id}`)!;
      if (row.draftRevision !== value.revision) throw new Error('AUTOMATION_CHANGED');
      row.draftRevision++; row.draftGraph = structuredClone(value.graph); return get(tenant, id);
    },
    publish: vi.fn(async (tenant: string, id: string, revision: number) => {
      const row = definitions.get(`${tenant}:${id}`)!;
      if (row.draftRevision !== revision) throw new Error('AUTOMATION_CHANGED');
      const publishedGraph = withDependencyPolicyV1(row.draftGraph), version = (row.activeVersion ?? 0) + 1;
      const value = { automationId: id, organizationId: tenant, version, graph: publishedGraph,
        checksum: hashIdempotencyRequest(publishedGraph), runtimeStateVersion: 2, publishedAt: new Date() };
      versions.set(`${tenant}:${id}`, [...versions.get(`${tenant}:${id}`) ?? [], value]); row.activeVersion = version; row.lifecycleStatus = 'PUBLISHED';
      if (failAfterPublication) { failAfterPublication = false; throw new Error('COMMIT_ACK_LOST'); }
      return value;
    }),
  };
  const service = mod!.createAutomationPackageService({ transact, repository: repository as never, store, automations: automations as never });
  return { service, definitions, records, versions, automations,
    failInsert: () => { failInsert = true; }, failAfterPublication: () => { failAfterPublication = true; } };
}

describe('tenant-scoped portable package service', () => {
  it('presents a crashed expired publication lease as reconcilable instead of blocking the UI forever', async () => {
    const f = await fixture(), row = await f.service.import(org, artifact(), 'expired-publication');
    const stored = f.records.get(`${org}:${row.id}`);
    Object.assign(stored, { state: 'PUBLISHING', leaseToken: randomUUID(), leaseExpiresAt: Date.now() - 1000 });
    expect((await f.service.get(org, row.id)).state).toBe('UNKNOWN');
  });
  it.each(['constructor', 'toString', 'hasOwnProperty'])('does not confuse logical key %s with an inherited publication receipt', async key => {
    const f = await fixture();
    const imported = await f.service.import(org, { format: 'jrc-broker-package/1', rootKey: key,
      flows: [{ key, name: 'Logical root', graph: graph() }] }, 'logical-key-import');
    const result = await f.service.publish(org, imported.id, imported.revision, 'logical-key-publish');
    expect(f.automations.publish).toHaveBeenCalledOnce();
    expect(Object.hasOwn(result.publications, key)).toBe(true);
    expect(result.publications[key]?.version).toBe(1);
  });
  it('imports atomic drafts with idempotent replay, conflicts and fresh destination identities', async () => {
    const f = await fixture(), first = await f.service.import(org, artifact(), 'import-one');
    expect(first.state).toBe('DRAFT'); expect(first.flows).toHaveLength(2);
    expect(await f.service.import(org, artifact(), 'import-one')).toEqual(first);
    await expect(f.service.import(org, { ...artifact(), rootKey: 'changed' }, 'import-one')).rejects.toThrow();
    const second = await f.service.import(other, artifact(), 'import-one');
    expect(second.rootId).not.toBe(first.rootId);
    await expect(f.service.get(other, first.id)).rejects.toMatchObject({ code: 'AUTOMATION_PACKAGE_NOT_FOUND' });
    expect(f.automations.publish).not.toHaveBeenCalled();
  });

  it('does not retain partial definitions after storage failure', async () => {
    const f = await fixture(); f.failInsert();
    await expect(f.service.import(org, artifact(), 'failed-import')).rejects.toThrow('INSERT_FAILED');
    expect(f.definitions.size).toBe(0); expect(f.records.size).toBe(0);
  });

  it('publishes children before root and reconciles a lost acknowledgement without a duplicate version', async () => {
    const f = await fixture(), imported = await f.service.import(org, artifact(), 'publish-me');
    f.failAfterPublication();
    const result = await f.service.publish(org, imported.id, imported.revision, 'publish-once');
    expect(result.state).toBe('PUBLISHED');
    expect(f.automations.publish.mock.calls.map(call => call[1])).toEqual([
      imported.flows.find(flow => flow.key === 'child')!.id, imported.rootId,
    ]);
    expect(await f.service.publish(org, imported.id, imported.revision, 'publish-once')).toEqual(result);
    expect(f.automations.publish).toHaveBeenCalledTimes(2);
  });

  it('exports a closed portable package and denies a foreign dependency', async () => {
    const f = await fixture(), imported = await f.service.import(org, artifact(), 'export-me');
    await f.service.publish(org, imported.id, imported.revision, 'publish');
    const exported = await f.service.export(org, imported.rootId, 1);
    expect(exported.format).toBe('jrc-broker-package/1'); expect(exported.flows).toHaveLength(2);
    expect(JSON.stringify(exported)).not.toContain(imported.rootId);
    await expect(f.service.export(other, imported.rootId, 1)).rejects.toThrow();
    const root = f.versions.get(`${org}:${imported.rootId}`)![0]!;
    root.graph.nodes.find(n => n.type === 'subflow')!.data.automationId = randomUUID();
    await expect(f.service.export(org, imported.rootId, 1)).rejects.toMatchObject({ code: 'AUTOMATION_PACKAGE_DEPENDENCY_MISSING' });
  });
});
