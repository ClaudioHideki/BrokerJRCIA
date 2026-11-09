import { expect, it, vi } from 'vitest';
import { automationEntryConfig, matchesAutomationEntry, welcomeFlow, withDependencyPolicyV1 } from '@jrc/contracts';
const id = '11111111-1111-4111-8111-111111111111', root = '22222222-2222-4222-8222-222222222222';
it('prepares a restricted immutable test copy without changing the original and reconciles publication acknowledgement', async () => {
  const mod = await import('../../src/modules/guided-setup/native-test.js').catch(() => null); expect(mod).not.toBeNull();
  const original = welcomeFlow(), before = structuredClone(original), published: any[] = [];
  let copied: any;
  const create = vi.fn(async (_org: string, value: any) => { copied = value.graph;
    return { id, lifecycleStatus: 'DRAFT', draft: { graph: copied, revision: 1 } }; });
  const publish = vi.fn(async () => { published.push({ version: 1, graph: withDependencyPolicyV1(copied) }); throw new Error('ACK_LOST'); });
  const prepare = mod!.createNativeTestPreparer({ transact: async (_org: string, work: any) => work({}),
    repository: { getVersion: async () => ({ automationId: root, version: 7, graph: original, runtimeStateVersion: 2 }) } as never,
    automations: { create, publish, versions: async () => ({ data: published }) } as never });
  const row = { id, name: 'Example setup', selection: { automationId: root, version: 7 } } as never;
  const result = await prepare({ organizationId: id, actorId: id }, row, 'teste-exclusivo-9', 'same-action');
  expect(result).toEqual({ automationId: id, version: 1 }); expect(publish).toHaveBeenCalledOnce();
  const config = automationEntryConfig(copied);
  expect(matchesAutomationEntry(config, 'teste-exclusivo-9')).toBe(true); expect(matchesAutomationEntry(config, 'oi')).toBe(false);
  expect(config?.reentry).toBe('ONCE_PER_CONVERSATION'); expect(original).toEqual(before);
  await prepare({ organizationId: id, actorId: id }, row, 'teste-exclusivo-9', 'same-action'); expect(publish).toHaveBeenCalledOnce();
});
it('prepares test-local media references while retaining the native asset ownership policy', async () => {
  const { createNativeTestPreparer } = await import('../../src/modules/guided-setup/native-test.js');
  const { assertMediaAsset } = await import('../../src/modules/automations/conversation-effects-repository.js');
  const assetId = '33333333-3333-4333-8333-333333333333', channel = '44444444-4444-4444-8444-444444444444', aliasId = '55555555-5555-4555-8555-555555555555';
  const sourceAsset: any = { id: assetId, organizationId: id, rootAutomationId: root, channelId: channel, mediaId: channel, revision: 3,
    status: 'READY', name: 'Manual', kind: 'document', mimeType: 'application/pdf', byteSize: 12, sha256: 'a'.repeat(64) };
  const sourceGraph = welcomeFlow(); sourceGraph.nodes.push({ id: 'media', type: 'media', label: 'Manual', position: { x: 0, y: 0 },
    data: { mediaEffectVersion: 2, channelId: channel, mediaId: assetId, mediaRevision: 3, kind: 'document' } });
  let graph: any, alias: any; const published: any[] = [];
  const query = vi.fn(async (sql: string, params: any[]) => {
    if (/join messaging_media/u.test(sql)) return { rows: [sourceAsset] };
    if (/INSERT INTO automation_media_assets/iu.test(sql)) { alias = { ...sourceAsset, id: aliasId, rootAutomationId: id, revision: 1, requestHash: params[8] }; return { rows: [] }; }
    if (/FROM automation_media_assets/iu.test(sql)) return { rows: [{ id: aliasId, revision: 1, requestHash: alias.requestHash }] };
    throw new Error('Unexpected query: ' + sql);
  });
  const prepare = createNativeTestPreparer({ transact: async (_org: string, work: any) => work({ query }),
    repository: { getVersion: async () => ({ automationId: root, graph: sourceGraph, runtimeStateVersion: 2 }) } as never,
    automations: {
      create: async (_org: string, input: any) => { graph ??= input.graph; return { id, lifecycleStatus: 'DRAFT', draft: { graph, revision: 1 } }; },
      save: async (_org: string, _id: string, input: any) => { graph = input.graph; return { id, lifecycleStatus: 'DRAFT', draft: { graph, revision: 2 } }; },
      versions: async () => ({ data: published }),
      publish: async () => { const node = graph.nodes.find((n: any) => n.type === 'media');
        assertMediaAsset(id, id, channel, node.data, node.data.mediaId === assetId ? sourceAsset : alias);
        const value = { version: 1, graph: withDependencyPolicyV1(graph) }; published.push(value); return value; },
    } as never });
  const row: any = { id, name: 'Media test', selection: { automationId: root, version: 1 } };
  expect(await prepare({ organizationId: id, actorId: id }, row, 'teste-media-9', 'same-media-test')).toEqual({ automationId: id, version: 1 });
  expect(graph.nodes.find((n: any) => n.type === 'media').data.mediaId).toBe(aliasId);
  expect(sourceGraph.nodes.find(n => n.type === 'media')?.data.mediaId).toBe(assetId);
});
