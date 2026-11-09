import { expect, it, vi } from 'vitest';
const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
async function fixture(published = false) {
  const mod = await import('../../src/modules/guided-setup/package-mapping.js').catch(() => null);
  expect(mod, 'atomic package localization must exist').not.toBeNull();
  const graph = { nodes: [ { id: 'handoff', type: 'handoff', label: 'Handoff', position: { x: 0, y: 0 }, data: { handoffVersion: 1 } },
    { id: 'note', type: 'note', label: 'Note', position: { x: 0, y: 0 }, data: { conversationEffectVersion: 2, text: 'Business text' } } ], edges: [] };
  const record: any = { id, organizationId: org, state: 'DRAFT', publications: {}, flows: [{ id, key: 'root' }], revision: 1,
    requirements: [{ flowKey: 'root', nodeId: 'handoff', kind: 'HANDOFF' }, { flowKey: 'root', nodeId: 'note', kind: 'CHANNEL' }] };
  const repository = { getDefinition: vi.fn(async () => ({ id, organizationId: org, lifecycleStatus: published ? 'PUBLISHED' : 'DRAFT', activeVersion: published ? 1 : null, draftGraph: graph, draftRevision: 1, name: 'Root' })),
    updateDefinition: vi.fn(async (_tx, value) => value) };
  const store = { get: vi.fn(async () => record), put: vi.fn(async (_tx, value) => value) };
  const snapshot: any = { organizationId: org, channelId: id,
    destination: { integrationId: id, accountId: 3, inboxId: 1, credentialRevision: 2, destinationRevision: 4, ready: true },
    agents: { selected: [7], eligible: [7], targetValid: true, target: { teamId: null, agentId: 7 } } };
  return { localize: mod!.createPackageDraftLocalizer({ repository, store } as never), repository, store, snapshot };
}
it('maps only the private unpublished package drafts to the server-observed inbox and human target', async () => {
  const f = await fixture(); await f.localize({ query: vi.fn() } as never, org, id, f.snapshot);
  const mapped = f.repository.updateDefinition.mock.calls[0]?.[1] as any;
  expect(mapped.graph.nodes[0].data).toEqual({ handoffVersion: 1, destination: { integrationId: id, accountId: 3, inboxId: 1, credentialRevision: 2, destinationRevision: 4 }, target: { teamId: null, agentId: 7 } });
  expect(mapped.graph.nodes[1].data).toMatchObject({ channelId: id, text: 'Business text' });
  expect(f.store.put).toHaveBeenCalledOnce();
});
it('refuses any already published or shared version before changing its draft', async () => {
  const f = await fixture(true);
  await expect(f.localize({ query: vi.fn() } as never, org, id, f.snapshot)).rejects.toMatchObject({ code: 'GUIDED_SETUP_PACKAGE_ALREADY_PUBLISHED' });
  expect(f.repository.updateDefinition).not.toHaveBeenCalled();
});
