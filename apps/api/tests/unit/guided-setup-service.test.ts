import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const org = '11111111-1111-4111-8111-111111111111', actor = '22222222-2222-4222-8222-222222222222';
const principal = { organizationId: org, actorId: actor };
async function fixture() {
  const mod = await import('../../src/modules/guided-setup/service.js').catch(() => null);
  expect(mod, 'guided setup coordinator must exist').not.toBeNull();
  const records = new Map<string, any>(), claims = new Map<string, any>(); let role = 'OWNER', enabled = true;
  const transact = async (tenant: string, work: (tx: any) => Promise<any>) => work({ tenant, query: async (sql: string, p: any[]) => {
    if (/tenant_is_active/i.test(sql)) return { rows: [{ active: true }] };
    if (/from organizations/i.test(sql)) return { rows: [{ status: 'ACTIVE', moduleEnabled: true }] };
    if (/DELETE FROM idempotency_records/i.test(sql)) return { rows: [] };
    if (/INSERT INTO idempotency_records/i.test(sql)) {
      const key = `${p[0]}:${p[1]}:${p[2]}`; if (claims.has(key)) return { rows: [] };
      const row = { id: randomUUID(), requestHash: p[3], status: 'IN_PROGRESS', responseMetadata: {} }; claims.set(key, row); return { rows: [row] };
    }
    if (/FROM idempotency_records/i.test(sql)) return { rows: [claims.get(`${p[0]}:${p[1]}:${p[2]}`)] };
    if (/UPDATE idempotency_records/i.test(sql)) {
      Object.assign([...claims.values()].find(c => c.id === p[1]), { status: p[2], responseMetadata: p[3] }); return { rows: [] };
    }
    throw new Error('Unexpected query: ' + sql);
  } });
  const store = {
    get: async (_tx: any, tenant: string, id: string) => structuredClone(records.get(`${tenant}:${id}`) ?? null),
    list: async (_tx: any, tenant: string) => [...records.values()].filter(r => r.organizationId === tenant).map(r => structuredClone(r)),
    insert: async (tx: any, record: any) => { records.set(`${tx.tenant}:${record.id}`, structuredClone(record)); return record; },
    put: async (tx: any, record: any) => { records.set(`${tx.tenant}:${record.id}`, structuredClone(record)); return record; },
  };
  const validateSelection = vi.fn(async (_principal: any, selection: any) => {
    if (selection.channelId === '33333333-3333-4333-8333-333333333333') throw new Error('CHANNEL_NOT_FOUND');
  });
  const service = mod!.createGuidedSetupService({ transact, store, resolveCurrentRole: async () => role as 'OWNER',
    isEnabled: () => enabled, ports: { validateSelection } });
  return { service, records, validateSelection, revoke: () => { role = 'OPERATOR'; }, disable: () => { enabled = false; } };
}

describe('durable guided configuration coordinator', () => {
  it('creates once, resumes after reload and isolates tenant resources', async () => {
    const f = await fixture(), input = { name: 'Support setup', transport: 'QR' as const };
    const first = await f.service.start(principal, input, 'setup-one');
    expect(first.state).toBe('EDITING'); expect(first.selection).toEqual({ transport: 'QR' });
    expect(await f.service.start(principal, input, 'setup-one')).toEqual(first);
    expect(await f.service.get(principal, first.id)).toEqual(first);
    expect((await f.service.list(principal)).data).toHaveLength(1);
    const foreign = { ...principal, organizationId: '44444444-4444-4444-8444-444444444444' };
    await expect(f.service.get(foreign, first.id)).rejects.toMatchObject({ code: 'GUIDED_SETUP_NOT_FOUND' });
    expect((await f.service.list(foreign)).data).toEqual([]);
  });

  it('updates with revision and idempotency while clearing obsolete check and test proof', async () => {
    const f = await fixture(), row = await f.service.start(principal, { name: 'Meta setup', transport: 'META' }, 'create-meta');
    const stored = f.records.get(`${org}:${row.id}`); stored.readiness = { fingerprint: 'old' }; stored.proof = { passed: true };
    const input = { revision: row.revision, selection: { transport: 'META' as const, channelId: randomUUID(), agentIds: [7] } };
    const saved = await f.service.update(principal, row.id, input, 'update-once');
    expect(saved.revision).toBe(row.revision + 1); expect(saved.readiness).toBeNull(); expect(saved.proof).toBeNull();
    expect(await f.service.update(principal, row.id, input, 'update-once')).toEqual(saved);
    await expect(f.service.update(principal, row.id, input, 'different-update')).rejects.toMatchObject({ code: 'GUIDED_SETUP_CHANGED' });
    expect(f.validateSelection).toHaveBeenCalledWith(principal, input.selection);
  });

  it('rejects foreign selections, secret fields and revoked authorization before writes', async () => {
    const f = await fixture(), row = await f.service.start(principal, { name: 'Setup', transport: 'QR' }, 'new-setup');
    await expect(f.service.update(principal, row.id, { revision: 1, selection: {
      transport: 'QR', channelId: '33333333-3333-4333-8333-333333333333' } }, 'foreign-ref')).rejects.toThrow('CHANNEL_NOT_FOUND');
    await expect(f.service.update(principal, row.id, { revision: 1, selection: { transport: 'QR', token: 'must-not-persist' } } as never, 'secret-field')).rejects.toThrow();
    expect(JSON.stringify([...f.records.values()])).not.toContain('must-not-persist');
    f.revoke(); await expect(f.service.get(principal, row.id)).rejects.toMatchObject({ code: 'GUIDED_SETUP_FORBIDDEN' });
  });

  it('cancels without deleting configured resources and prevents further changes', async () => {
    const f = await fixture(), row = await f.service.start(principal, { name: 'Setup', transport: 'QR' }, 'cancel-me');
    const result = await f.service.cancel(principal, row.id, { revision: row.revision }, 'cancel-once');
    expect(result.state).toBe('CANCELLED'); expect(f.records.size).toBe(1);
    await expect(f.service.update(principal, row.id, { revision: result.revision, selection: { transport: 'QR' } }, 'after-cancel'))
      .rejects.toMatchObject({ code: 'GUIDED_SETUP_CANCELLED' });
  });

  it('keeps the rollout disabled outside explicitly enabled tenants', async () => {
    const f = await fixture(); f.disable();
    expect(await f.service.availability(principal)).toEqual({ enabled: false });
    await expect(f.service.start(principal, { name: 'Not enabled', transport: 'QR' }, 'blocked-setup')).rejects.toMatchObject({ code: 'GUIDED_SETUP_DISABLED' });
    expect(f.records.size).toBe(0);
  });
});
