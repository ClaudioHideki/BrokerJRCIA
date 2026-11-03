import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), publish: vi.fn(), processOne: vi.fn(), options: [] as unknown[] }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: unknown) { h.options.push(options); }
  query = h.query;
  end = h.end;
} }));
vi.mock('../../src/db/tenant-transaction.js', () => ({ withOrganizationTransaction: async (_pool: unknown, org: string, work: (tx: unknown) => Promise<unknown>) => work({ query: () => h.publish(org) }) }));
vi.mock('../../src/modules/partner-events/worker.js', () => ({ createPartnerEventWorker: () => ({ processOne: h.processOne }) }));
import { runPartnerEventsWorker } from '../../src/commands/partner-events-worker.js';

const env = { DATABASE_URL: 'postgresql://jrc_app@127.0.0.1/synthetic', PARTNER_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') };
beforeEach(() => {
  vi.clearAllMocks(); h.options.length = 0;
  h.publish.mockResolvedValue({ rows: [] }); h.end.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function organizations(ids: string[]) {
  h.query.mockImplementation(async (_sql: string, [cursor, limit]: [string | null, number]) => ({ rows: ids.filter(id => cursor === null || id > cursor).slice(0, limit).map(organization_id => ({ organization_id })) }));
}

it('offers each tenant a turn before claiming its second delivery, with the same maximum of twenty', async () => {
  organizations(['a', 'b']); h.processOne.mockResolvedValue(true);
  await runPartnerEventsWorker(env);
  expect(h.processOne.mock.calls.slice(0, 4).map(call => call[0])).toEqual(['a', 'b', 'a', 'b']);
  expect(h.processOne.mock.calls.filter(call => call[0] === 'a')).toHaveLength(20);
  expect(h.processOne.mock.calls.filter(call => call[0] === 'b')).toHaveLength(20);
  expect(h.end).toHaveBeenCalledOnce();
});

it('does not hold a healthy tenant behind a slow receiver when the existing pool allows two slots', async () => {
  vi.useFakeTimers(); organizations(['a', 'b']); const completed: string[] = [];
  h.processOne.mockImplementation(async (org: string) => { if (org === 'a') await new Promise(resolve => setTimeout(resolve, 10000)); completed.push(org); return false; });
  const run = runPartnerEventsWorker(env);
  await vi.advanceTimersByTimeAsync(1);
  const beforeSlow = [...completed];
  await vi.runAllTimersAsync(); await run;
  expect(beforeSlow).toEqual(['b']);
  expect(completed).toEqual(['b', 'a']);
});

it('visits later discovery pages before reusing an earlier tenant and keeps at most two in flight', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => String(i).padStart(3, '0')); organizations(ids);
  let active = 0, maximum = 0;
  h.processOne.mockImplementation(async () => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return true; });
  await runPartnerEventsWorker(env);
  expect(h.processOne.mock.calls.slice(0, 101).map(call => call[0])).toEqual(ids);
  expect(h.processOne).toHaveBeenCalledTimes(2020);
  expect(maximum).toBeLessThanOrEqual(2);
});

it('isolates a tenant publication error, logs no detail and keeps the next tenant eligible', async () => {
  organizations(['a', 'b']); h.processOne.mockResolvedValue(false);
  h.publish.mockImplementation(async (org: string) => { if (org === 'a') throw Error('private customer payload and credential'); return { rows: [] }; });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  let error: unknown; try { await runPartnerEventsWorker(env); } catch (caught) { error = caught; }
  expect(error).toBeUndefined();
  expect(h.processOne.mock.calls.map(call => call[0])).toEqual(['b']);
  expect(stderr.mock.calls.map(call => call[0]).join('')).toBe('PARTNER_EVENT_DELIVERY_FAILED\n');
  expect(h.end).toHaveBeenCalledOnce();
});

it('honors a one-connection budget without increasing it or creating simultaneous tenant work', async () => {
  organizations(['a', 'b']); let active = 0, maximum = 0;
  h.processOne.mockImplementation(async () => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return false; });
  await runPartnerEventsWorker({ ...env, PARTNER_EVENTS_WORKER_DB_POOL_MAX: '1' });
  expect(maximum).toBe(1); expect(h.options).toEqual([expect.objectContaining({ max: 1 })]);
});

it('drains admitted work after SIGTERM without starting later tenants, and removes its handlers', async () => {
  organizations(['a', 'b', 'c']); const before = process.listenerCount('SIGTERM');
  h.processOne.mockImplementation(async (org: string) => { if (org === 'a') process.emit('SIGTERM'); await Promise.resolve(); return true; });
  await runPartnerEventsWorker(env);
  expect(h.processOne.mock.calls.map(call => call[0])).not.toContain('c');
  expect(process.listenerCount('SIGTERM')).toBe(before); expect(h.end).toHaveBeenCalledOnce();
});
