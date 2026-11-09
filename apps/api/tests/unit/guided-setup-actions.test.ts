import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
const root = '33333333-3333-4333-8333-333333333333', testRoot = '44444444-4444-4444-8444-444444444444';
const channel = '55555555-5555-4555-8555-555555555555', integration = '66666666-6666-4666-8666-666666666666';
const principal = { organizationId: org, actorId: org };
async function fixture() {
  const mod = await import('../../src/modules/guided-setup/actions.js').catch(() => null);
  expect(mod, 'controlled test and activation actions must exist').not.toBeNull();
  let row: any = { id, organizationId: org, actorId: org, name: 'Setup', revision: 1, state: 'EDITING',
    selection: { transport: 'QR', channelId: channel, integrationId: integration, automationId: root, version: 1, agentIds: [3], humanTarget: { agentId: 3, teamId: null } },
    readiness: null, proof: null, operation: null, testContext: null, previousBinding: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const snapshot: any = { organizationId: org, provider: 'QR', publicChannelId: channel, channelId: channel, connected: true,
    identity: { fingerprint: 'number-one', revision: 1, confirmed: true },
    destination: { origin: 'https://central.example.test', accountId: 1, inboxId: 1, integrationId: integration, destinationRevision: 1, credentialRevision: 1, ready: true },
    agents: { selected: [3], eligible: [3], targetValid: true, target: { agentId: 3, teamId: null } },
    flow: { id: root, version: 1, checksum: 'a'.repeat(64), published: true, valid: true, dependencies: [] },
    owner: { revision: 4, automationId: null, version: null, executor: 'NONE' } };
  const evidence = { scopeMatches: true, entryReceived: true, selectionsReceived: true, botDelivered: true,
    mirrorConfirmed: true, handoffConfirmed: true, humanPaused: true, unresolvedEffects: false };
  let failBind = false;
  const ports = {
    inspect: vi.fn(async () => structuredClone(snapshot)),
    assertOwner: vi.fn(async (_tx: unknown, _principal: unknown, expected: any) => {
      if (JSON.stringify(expected.owner) !== JSON.stringify(snapshot.owner)) {
        const { setupFail } = await import('../../src/modules/guided-setup/service.js'); return setupFail('OWNER_CHANGED');
      }
    }),
    readOwner: vi.fn(async () => ({ channelId: channel, owner: structuredClone(snapshot.owner) })),
    deactivate: vi.fn(async () => { snapshot.owner = { revision: snapshot.owner.revision + 1, automationId: null, version: null, executor: 'NONE' }; return { ownerRevision: snapshot.owner.revision }; }),
    prepareTest: vi.fn(async () => ({ automationId: testRoot, version: 1 })),
    bind: vi.fn(async (_principal: any, input: any) => {
      if (input.expectedOwnerRevision !== snapshot.owner.revision) throw new Error('ATTENDANCE_OWNER_CHANGED');
      snapshot.owner = { revision: snapshot.owner.revision + 1, automationId: input.automationId, version: input.version, executor: 'BROKER' };
      if (failBind) { failBind = false; throw new Error('ACK_LOST'); }
      return { id: randomUUID(), revision: 1, ownerRevision: snapshot.owner.revision };
    }),
    readProof: vi.fn(async () => ({ executionId: '77777777-7777-4777-8777-777777777777', evidence })),
  };
  const audit = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
  const options: any = { transact: async (_org: string, work: any) => work({ query: audit }), ports };
  const store: any = { put: async (_tx: any, value: any) => { row = structuredClone(value); return row; } };
  const authorize = vi.fn(async () => {}), read = async () => structuredClone(row);
  const actions = mod!.createGuidedSetupActions({ options, store, authorize, read });
  const begin = () => actions.beginTest(principal, id, { revision: row.revision, keyword: 'teste-robot-isolado', expectedOwnerRevision: snapshot.owner.revision, replaceExisting: false }, 'test-once');
  return { actions, ports, snapshot, evidence, audit, begin, read: () => row, failBind: () => { failBind = true; } };
}
it('starts a restricted test then activates only after server-collected proof', async () => {
  const f = await fixture(), tested = await f.begin();
  expect(tested.state).toBe('TESTING'); expect(tested.test?.keyword).toBe('teste-robot-isolado');
  await expect(f.actions.activate(principal, id, { revision: tested.revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'activate-early'))
    .rejects.toMatchObject({ code: 'GUIDED_SETUP_PHYSICAL_PROOF_REQUIRED' });
  const proved = await f.actions.collectProof(principal, id, { revision: f.read().revision });
  expect(proved.proof?.passed).toBe(true);
  const active = await f.actions.activate(principal, id, { revision: proved.revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'activate-once');
  expect(active.state).toBe('ACTIVE'); expect(f.ports.bind.mock.calls.map(call => call[1].automationId)).toEqual([testRoot, root]);
});
it('deactivates its test binding without starting another robot or changing human assignment', async () => {
  const f = await fixture(); await f.begin();
  const result = await f.actions.deactivate(principal, id, { revision: f.read().revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'stop-test');
  expect(result.state).toBe('EDITING'); expect(result.proof).toBeNull(); expect(result.test).toBeNull();
  expect(f.ports.deactivate).toHaveBeenCalledOnce(); expect(f.ports.bind).toHaveBeenCalledTimes(1);
});
it('refuses to deactivate a different bot installed after the test', async () => {
  const f = await fixture(); await f.begin();
  f.snapshot.owner = { revision: 99, automationId: '99999999-9999-4999-8999-999999999999', version: 1, executor: 'BROKER' };
  await expect(f.actions.deactivate(principal, id, { revision: f.read().revision, expectedOwnerRevision: 99 }, 'stop-foreign'))
    .rejects.toMatchObject({ code: 'GUIDED_SETUP_OWNER_CHANGED' });
  expect(f.ports.deactivate).not.toHaveBeenCalled();
});
it('can stop its own test after an uncertain binding outcome', async () => {
  const f = await fixture(); f.failBind(); await expect(f.begin()).rejects.toThrow('ACK_LOST');
  const result = await f.actions.deactivate(principal, id, { revision: f.read().revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'stop-uncertain');
  expect(result.state).toBe('EDITING'); expect(f.ports.deactivate).toHaveBeenCalledOnce();
});
it('does not let an old guide stop the same root reinstalled at a newer ownership revision', async () => {
  const f = await fixture(); await f.begin(); await f.actions.collectProof(principal, id, { revision: f.read().revision });
  await f.actions.activate(principal, id, { revision: f.read().revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'activate');
  f.snapshot.owner.revision += 2;
  await expect(f.actions.deactivate(principal, id, { revision: f.read().revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'stop-new-owner'))
    .rejects.toMatchObject({ code: 'GUIDED_SETUP_OWNER_CHANGED' });
  expect(f.ports.deactivate).not.toHaveBeenCalled();
});
it('does not stop a test clone reinstated after another ownership cutover', async () => {
  const f = await fixture(); await f.begin(); f.snapshot.owner.revision += 2;
  await expect(f.actions.deactivate(principal, id, { revision: f.read().revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'stop-reinstalled-test'))
    .rejects.toMatchObject({ code: 'GUIDED_SETUP_OWNER_CHANGED' });
  expect(f.ports.deactivate).not.toHaveBeenCalled();
});
it('invalidates saved ACTIVE and physical proof when authoritative owner no longer matches', async () => {
  const f = await fixture(); await f.begin(); await f.actions.collectProof(principal, id, { revision: f.read().revision });
  await f.actions.activate(principal, id, { revision: f.read().revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'activate');
  f.snapshot.owner = { revision: f.snapshot.owner.revision + 1, automationId: null, version: null, executor: 'NONE' };
  const checked = await f.actions.check(principal, id, { revision: f.read().revision });
  expect(checked.state).toBe('EDITING'); expect(checked.proof).toBeNull(); expect(checked.test).toBeNull();
});
it('checks current owner inside finalization instead of confirming a stale snapshot', async () => {
  const f = await fixture(); let inspections = 0;
  f.ports.inspect.mockImplementation(async () => {
    const saved = structuredClone(f.snapshot);
    if (++inspections === 3) f.snapshot.owner = { revision: f.snapshot.owner.revision + 1, automationId: root, version: 1, executor: 'BROKER' };
    return saved;
  });
  await expect(f.begin()).rejects.toMatchObject({ code: 'GUIDED_SETUP_OWNER_CHANGED' });
  expect(f.read().state).toBe('UNKNOWN'); expect(f.ports.assertOwner).toHaveBeenCalledOnce();
});
it('audits the administrator who performed activation rather than attributing it to the setup creator', async () => {
  const f = await fixture(); await f.begin();
  await f.actions.collectProof(principal, id, { revision: f.read().revision });
  const anotherAdmin = { ...principal, actorId: '88888888-8888-4888-8888-888888888888' };
  await f.actions.activate(anotherAdmin, id, { revision: f.read().revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'another-operator');
  const activation = f.audit.mock.calls.find(([sql, params]) => typeof sql === 'string' && /INSERT INTO audit_logs/i.test(sql)
    && Array.isArray(params) && params[2] === 'GUIDED_SETUP_ACTIVATED');
  expect(activation).toBeDefined(); expect(activation?.[1]).toContain(anotherAdmin.actorId);
});
it('does not replace an existing executor without explicit confirmation and expected revision', async () => {
  const f = await fixture(); f.snapshot.owner = { ...f.snapshot.owner, automationId: root, version: 1, executor: 'BROKER' };
  await expect(f.begin()).rejects.toMatchObject({ code: 'GUIDED_SETUP_REPLACEMENT_CONFIRMATION_REQUIRED' });
  expect(f.ports.bind).not.toHaveBeenCalled();
});
it('rejects invented client proof, pending delivery and a changed number before activation', async () => {
  const f = await fixture(); await f.begin();
  await expect(f.actions.collectProof(principal, id, { revision: f.read().revision, passed: true } as never)).rejects.toThrow();
  f.evidence.botDelivered = false;
  const partial = await f.actions.collectProof(principal, id, { revision: f.read().revision }); expect(partial.proof?.passed).toBe(false);
  await expect(f.actions.activate(principal, id, { revision: partial.revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'blocked-delivery'))
    .rejects.toMatchObject({ code: 'GUIDED_SETUP_PHYSICAL_PROOF_REQUIRED' });
  f.evidence.botDelivered = true;
  const proved = await f.actions.collectProof(principal, id, { revision: f.read().revision });
  f.snapshot.identity.fingerprint = 'other-number';
  await expect(f.actions.activate(principal, id, { revision: proved.revision, expectedOwnerRevision: f.snapshot.owner.revision }, 'blocked-number'))
    .rejects.toMatchObject({ code: 'GUIDED_SETUP_CONFIGURATION_CHANGED' });
  expect(f.ports.bind).toHaveBeenCalledTimes(1);
});
it('reconciles a lost binding acknowledgement without binding a second time', async () => {
  const f = await fixture(); f.failBind();
  await expect(f.begin()).rejects.toThrow('ACK_LOST'); expect(f.read().state).toBe('UNKNOWN');
  const recovered = await f.actions.reconcile(principal, id, { revision: f.read().revision });
  expect(recovered.state).toBe('TESTING'); expect(f.ports.bind).toHaveBeenCalledTimes(1);
});
