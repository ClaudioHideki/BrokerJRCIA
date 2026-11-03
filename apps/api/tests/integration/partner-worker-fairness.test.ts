import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { connectionStringForRole } from './helpers/task7.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { createPartnerEventService } from '../../src/modules/partner-events/service.js';

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../src/modules/partner-events/worker.js', async importActual => {
  const actual = await importActual<typeof import('../../src/modules/partner-events/worker.js')>();
  return { ...actual, createPartnerEventWorker: (options: Parameters<typeof actual.createPartnerEventWorker>[0]) => actual.createPartnerEventWorker({ ...options, send: h.send }) };
});
import { runPartnerEventsWorker } from '../../src/commands/partner-events-worker.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); });
afterAll(async () => { await db?.dispose(); });

it('delivers a healthy tenant while a peer is held, then retries only the identical lost-ACK event under real PG leases', async () => {
  const tenants = [await seedAttendanceTenant(db.database, false), await seedAttendanceTenant(db.database, false)].sort((a, b) => a.org.localeCompare(b.org));
  const slow = tenants[0]!, healthy = tenants[1]!;
  const key = Buffer.alloc(32, 9).toString('base64');
  const service = createPartnerEventService({ transact: db.transact, secrets: createIntegrationSecrets(key) });
  for (const tenant of tenants) {
    await service.create(tenant.org, { url: 'https://synthetic.example.test/hooks' }, randomUUID());
    for (let n = 0; n < (tenant === slow ? 3 : 1); n++) await db.transact(tenant.org, tx => tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state)
      VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic fairness"}','DELIVERED')`, [randomUUID(), tenant.org, tenant.channel, tenant.conversation]));
  }
  const expected = (await Promise.all(tenants.map(async tenant => (await service.events(tenant.org, { limit: 100 })).data.map(event => `${tenant.org}/${event.eventId}`)))).flat().sort();
  const accepted = new Set<string>(), calls: Array<{ key: string; deliveryId: string }> = [];
  let release!: () => void, healthySeen!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const observedHealthy = new Promise<void>(resolve => { healthySeen = resolve; });
  let lostKey: string | undefined;
  h.send.mockImplementation(async (_url: string, init: RequestInit) => {
    const envelope = JSON.parse(String(init.body)) as { organizationId: string; eventId: string };
    const identity = `${envelope.organizationId}/${envelope.eventId}`;
    calls.push({ key: identity, deliveryId: (init.headers as Record<string, string>)['x-jrc-delivery-id']! });
    accepted.add(identity);
    if (envelope.organizationId === healthy.org) healthySeen();
    if (envelope.organizationId === slow.org && lostKey === undefined) {
      lostKey = identity; await held; process.emit('SIGTERM'); throw Error('synthetic lost receiver ACK after persistence');
    }
    return new Response(null, { status: 202 });
  });
  const env = { DATABASE_URL: connectionStringForRole(db.database.connectionString, 'jrc_app'), PARTNER_WEBHOOK_ENCRYPTION_KEY: key };
  const running = runPartnerEventsWorker(env);
  let healthyBeforeRelease = false, timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    healthyBeforeRelease = await Promise.race([observedHealthy.then(() => true), new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 4000); })]);
  } finally { clearTimeout(timeout); release(); await running; }
  expect(healthyBeforeRelease).toBe(true);
  expect(accepted.size).toBe(2);
  const firstRows = (await db.database.pool.query('SELECT organization_id,event_id,id,status,attempts FROM partner_event_deliveries ORDER BY organization_id,event_id')).rows;
  const pending = firstRows.filter(row => row.status === 'PENDING');
  expect(pending).toHaveLength(3);
  const uncertain = pending.find(row => row.attempts === 1)!;
  expect(`${uncertain.organization_id}/${uncertain.event_id}`).toBe(lostKey);
  expect(firstRows.filter(row => row.status === 'DELIVERED')).toHaveLength(1);
  await db.transact(slow.org, tx => tx.query("UPDATE partner_event_deliveries SET available_at=now()-interval '1 second' WHERE organization_id=$1 AND id=$2", [slow.org, uncertain.id]));
  await runPartnerEventsWorker(env);
  const repeated = calls.filter(call => call.key === lostKey);
  expect(repeated).toHaveLength(2); expect(repeated[0].deliveryId).toBe(repeated[1].deliveryId);
  expect(calls).toHaveLength(5); expect([...accepted].sort()).toEqual(expected);
  const final = (await db.database.pool.query('SELECT status,attempts FROM partner_event_deliveries ORDER BY attempts')).rows;
  expect(final.map(row => row.status)).toEqual(['DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED']);
  expect(final.map(row => row.attempts)).toEqual([1, 1, 1, 2]);
});
