import { expect, it, vi } from 'vitest';
vi.mock('../../src/modules/tenancy/operational-limits.js', () => ({ requireActiveOrganization: vi.fn(), TenantOperationalError: class extends Error {} }));
vi.mock('../../src/modules/attendance/repository.js', () => ({ lockAttendanceChannel: vi.fn() }));
vi.mock('../../src/modules/whatsapp-groups/events.js', () => ({ reconcileWhatsAppGroupParticipation: vi.fn() }));
import { createWhatsAppGroupCatalog, GroupCatalogError } from '../../src/modules/whatsapp-groups/service.js';

const org = '11111111-1111-4111-8111-111111111111';
const channel = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const phases = ['CAPTURE', 'IDENTITY_BEFORE', 'CATALOG', 'IDENTITY_AFTER', 'ENGINE_REVALIDATION', 'COMMIT'] as const;
type Phase = typeof phases[number];
const canary = 'secret-token https://secret.invalid/120000000000001@g.us raw-body secret-stack';
const item = { groupJid: '120000000000001@g.us', subject: 'Synthetic group', participantCount: 2,
  restrict: false, announce: false, isCommunity: false, isCommunityAnnounce: false, linkedParent: null };

function fixture(failure?: Phase, observer = vi.fn(), error: unknown = Object.assign(new Error(canary), { code: 'PROVIDER_TIMEOUT', stack: canary, body: canary })) {
  const state = { busy: false, recorded: null as unknown, selected: false, published: false };
  const catalog: any = { identity_revision: '1', identity_fingerprint: null, catalog_revision: '0',
    snapshot_id: null, observed_at: null, valid_until: null, last_attempt_at: new Date(), last_error_code: null, lease_token: null };
  const rows = (values: any[]) => ({ rows: values, rowCount: values.length });
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('lock_local_attendance_member')) return rows([{ role: 'OWNER' }]);
    if (sql.includes('SELECT c.instance_id')) return rows([{ instance_id: channel, upstream_instance_key: canary, connected: true }]);
    if (sql.startsWith('INSERT INTO whatsapp_group_catalogs')) return rows([{ channel_id: channel }]);
    if (sql.includes('SET lease_token=$3')) { state.busy = true; return rows([{ channel_id: channel }]); }
    if (sql.includes('SELECT * FROM whatsapp_group_catalogs')) return rows([catalog]);
    if (sql.includes('SET snapshot_id=')) {
      if (failure === 'COMMIT') throw error;
      state.published = true; state.busy = false;
      Object.assign(catalog, { snapshot_id: args[3], identity_fingerprint: args[4], catalog_revision: '1',
        observed_at: new Date(), valid_until: new Date(Date.now() + 300000) });
      return rows([{ channel_id: channel }]);
    }
    if (sql.includes('last_error_code=$4')) { state.recorded = args[3]; state.busy = false; return rows([]); }
    if (sql.includes('group_jid AS "groupJid"')) return rows([{ ...item, selected: false, automationEnabled: false }]);
    if (sql.includes('SELECT count(*)')) return rows([{ count: '1' }]);
    return rows([]);
  });
  let observations = 0;
  const readIdentity = vi.fn(async () => {
    observations++;
    if (failure === (observations === 1 ? 'IDENTITY_BEFORE' : 'IDENTITY_AFTER')) throw error;
    return { connected: true, phone: '15550000001' };
  });
  const readGroups = vi.fn(async () => { if (failure === 'CATALOG') throw error; return [item]; });
  const captureBinding = vi.fn(async () => { if (failure === 'CAPTURE') throw error; return {} as any; });
  const assertBinding = vi.fn(async () => { if (failure === 'ENGINE_REVALIDATION') throw error; });
  const service = createWhatsAppGroupCatalog({ encryptionKey: Buffer.alloc(32, 21).toString('base64'),
    transact: async (_org, work) => work({ query } as any), readIdentity, readGroups, captureBinding, assertBinding,
    ...{ onRefreshFailure: observer } });
  return { service, state, observer, readIdentity, query };
}

it.each(phases)('attributes %s failure without leaking provider values or changing cleanup', async phase => {
  const f = fixture(phase);
  await expect(f.service.refresh({ organizationId: org, actorId: actor }, channel)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  expect(f.state).toMatchObject({ busy: false, recorded: 'PROVIDER_TIMEOUT', selected: false, published: false });
  expect(f.observer).toHaveBeenCalledOnce();
  const event = f.observer.mock.calls[0]![0];
  expect(event).toEqual({ phase, safeCode: 'PROVIDER_TIMEOUT', httpStatus: null, organizationId: org, channelId: channel,
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), elapsedMs: expect.any(Number) });
  expect(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0).toBe(true);
  expect(JSON.stringify(event)).not.toContain('secret');
  expect(JSON.stringify(event)).not.toContain(item.groupJid);
  if (phase !== 'CAPTURE') expect(event.requestId).toBe(f.readIdentity.mock.calls[0]![0].requestId);
});

it('allows only known safe codes even when an internal error carries arbitrary content', async () => {
  const error = new GroupCatalogError(canary);
  const f = fixture('CATALOG', vi.fn(), error);
  await expect(f.service.refresh({ organizationId: org, actorId: actor }, channel)).rejects.toBe(error);
  expect(f.observer).toHaveBeenCalledWith(expect.objectContaining({ safeCode: 'GROUP_CATALOG_UNAVAILABLE' }));
  expect(JSON.stringify(f.observer.mock.calls)).not.toContain('secret');
});

it.each(['throw', 'reject', 'never-settle'] as const)('observer %s cannot delay cleanup or replace the refresh error', async mode => {
  const observer = vi.fn(() => {
    if (mode === 'throw') throw new Error(canary);
    return mode === 'reject' ? Promise.reject(new Error(canary)) : new Promise(() => {});
  });
  const f = fixture('CATALOG', observer);
  await expect(f.service.refresh({ organizationId: org, actorId: actor }, channel)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  await Promise.resolve();
  expect(f.state).toMatchObject({ busy: false, recorded: 'PROVIDER_TIMEOUT', selected: false });
  expect(observer).toHaveBeenCalledOnce();
});

it('does not emit a failure diagnostic for successful metadata discovery', async () => {
  const f = fixture();
  const result = await f.service.refresh({ organizationId: org, actorId: actor }, channel);
  expect(result.items[0]).toMatchObject({ selected: false, automationEnabled: false });
  expect(f.observer).not.toHaveBeenCalled();
});

it.each([401, 404, 429, 500])('emits only bounded HTTP status %i alongside the safe failure code', async httpStatus => {
  const f = fixture('CATALOG', vi.fn(), Object.assign(new Error(canary), { code: 'PROVIDER_REQUEST_FAILED', httpStatus, body: canary }));
  await expect(f.service.refresh({ organizationId: org, actorId: actor }, channel)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
  expect(f.observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'CATALOG', safeCode: 'PROVIDER_REQUEST_FAILED', httpStatus }));
  expect(JSON.stringify(f.observer.mock.calls)).not.toContain('secret');
});

it.each([99, 600, 401.5, '401', NaN, { body: canary }])('ignores untrusted HTTP status metadata %#', async httpStatus => {
  const f = fixture('CATALOG', vi.fn(), Object.assign(new Error(canary), { code: 'PROVIDER_REQUEST_FAILED', httpStatus }));
  await expect(f.service.refresh({ organizationId: org, actorId: actor }, channel)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
  expect(f.observer).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: null }));
});

it('does not invoke arbitrary error metadata getters while constructing a diagnostic', async () => {
  const getter = vi.fn(() => { throw new Error(canary); });
  const error = Object.defineProperty(Object.assign(new Error(canary), { code: 'PROVIDER_REQUEST_FAILED' }), 'httpStatus', { get: getter });
  const f = fixture('CATALOG', vi.fn(), error);
  await expect(f.service.refresh({ organizationId: org, actorId: actor }, channel)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
  expect(getter).not.toHaveBeenCalled();
  expect(f.observer).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: null }));
  expect(f.state.busy).toBe(false);
});
