import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { createWhatsAppGroupCatalog } from '../../src/modules/whatsapp-groups/service.js';
import { TenantOperationalError } from '../../src/modules/tenancy/operational-limits.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
afterAll(async () => { await db?.dispose(); });
const groups = (count = 2) => Array.from({ length: count }, (_, i) => ({
  groupJid: `${10000 + i}@g.us`, subject: `Synthetic group ${i}`,
  participantCount: 3, restrict: null, announce: false, isCommunity: false,
  isCommunityAnnounce: false, linkedParent: null,
}));
async function fixture() {
  const principal = await runInAdminTransaction(db.database.pool, async tx => {
    const org = await createOrganization(tx, { name: 'Synthetic G1', slug: `g1-${randomUUID()}` });
    const actor = (await tx.query<{ id: string }>("INSERT INTO users(email,password_hash) VALUES($1,'test-only') RETURNING id", [`${org.id}@example.test`])).rows[0]!.id;
    await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [org.id, actor]);
    return { organizationId: org.id, actorId: actor };
  });
  const upstreamKey = `g1-${randomUUID()}`;
  const data = await db.transact(principal.organizationId, async tx => {
    const provider = (await tx.query<{ id: string }>("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','G1') RETURNING id", [principal.organizationId])).rows[0]!.id;
    const instance = (await tx.query<{ id: string }>("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'G1',$3,'CONNECTED') RETURNING id", [principal.organizationId, provider, upstreamKey])).rows[0]!.id;
    return { instance, channel: (await ensureQrChannel(tx, principal.organizationId, instance)).id };
  });
  let phone = '15550000001', fail = false, catalog = groups(), onRead: (() => Promise<void>) | undefined;
  let reads = 0;
  const service = createWhatsAppGroupCatalog({ encryptionKey: Buffer.alloc(32, 17).toString('base64'), transact: db.transact,
    readIdentity: async (context, key) => {
      expect(context.organizationId).toBe(principal.organizationId); expect(key).toBe(upstreamKey);
      return { connected: true, phone };
    },
    readGroups: async () => {
      reads++; if (onRead) await onRead();
      if (fail) throw Object.assign(new Error('private provider detail'), { code: 'PROVIDER_TIMEOUT' });
      return catalog;
    },
  });
  const selection = (page: any, enabled = true) => ({ expectedSnapshotId: page.snapshot.snapshotId,
    expectedCatalogRevision: page.snapshot.catalogRevision, expectedIdentityRevision: page.snapshot.scope.identityRevision,
    expectedIdentityFingerprint: page.snapshot.scope.identityFingerprint, groupJid: page.items[0].groupJid, enabled });
  return { ...principal, principal, ...data, service, selection,
    setPhone: (value: string) => { phone = value; }, fail: () => { fail = true; },
    setGroups: (value: ReturnType<typeof groups>) => { catalog = value; },
    onRead: (value: () => Promise<void>) => { onRead = value; }, reads: () => reads,
  };
}
it('installs isolated catalog tables for QR metadata without authorizing group automation', async () => {
  const facts = (await db.database.pool.query("SELECT to_regclass('public.whatsapp_group_catalogs')::text AS catalog, to_regclass('public.whatsapp_group_catalog_items')::text AS items")).rows[0];
  expect(facts).toEqual({ catalog: 'whatsapp_group_catalogs', items: 'whatsapp_group_catalog_items' });
});
it('publishes an observed number-scoped catalog with both group actions disabled by default', async () => {
  const h = await fixture(), page: any = await h.service.refresh(h.principal, h.channel);
  expect(page).toMatchObject({ snapshot: { schemaVersion: 1, status: 'CURRENT', scope: { provider: 'QR', organizationId: h.organizationId, channelId: h.channel, identityRevision: 1 } }, total: 2 });
  expect(page.snapshot.scope.identityFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(page.items.every((item: any) => !item.selected && !item.automationEnabled)).toBe(true);
  expect(JSON.stringify(page)).not.toContain('15550000001');
  expect((await db.transact(h.organizationId, tx => tx.query('SELECT * FROM messaging_outbox'))).rows).toEqual([]);
});
it('paginates one persisted snapshot locally without another provider request', async () => {
  const h = await fixture(); h.setGroups(groups(103));
  await h.service.refresh(h.principal, h.channel);
  const first: any = await h.service.page(h.principal, h.channel, { limit: 100 });
  const second: any = await h.service.page(h.principal, h.channel, { limit: 100, cursor: first.nextCursor });
  expect(first.items).toHaveLength(100); expect(second.items).toHaveLength(3);
  expect(second.nextCursor).toBeNull(); expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
  expect(h.reads()).toBe(1);
});
it('selects by current expectations, increments revision and refuses stale or forged scope', async () => {
  const h = await fixture(), first: any = await h.service.refresh(h.principal, h.channel);
  const selected: any = await h.service.select(h.principal, h.channel, h.selection(first));
  expect(selected.items[0]).toMatchObject({ selected: true, automationEnabled: false });
  expect(selected.snapshot.catalogRevision).toBe(first.snapshot.catalogRevision + 1);
  await expect(h.service.select(h.principal, h.channel, h.selection(first, false))).rejects.toThrow('GROUP_CATALOG_CHANGED');
  await expect(h.service.select(h.principal, h.channel, { ...h.selection(selected), expectedIdentityFingerprint: 'f'.repeat(64) })).rejects.toThrow('GROUP_IDENTITY_CHANGED');
});
it('marks a failed refresh stale, preserves the last catalog and prohibits selection', async () => {
  const h = await fixture(), first: any = await h.service.refresh(h.principal, h.channel); h.fail();
  await expect(h.service.refresh(h.principal, h.channel)).rejects.toThrow('PROVIDER_TIMEOUT');
  const page: any = await h.service.page(h.principal, h.channel, { limit: 50 });
  expect(page.items).toEqual(first.items); expect(page.snapshot).toMatchObject({ status: 'STALE', lastErrorCode: 'PROVIDER_TIMEOUT' });
  await expect(h.service.select(h.principal, h.channel, h.selection(first))).rejects.toThrow('GROUP_CATALOG_STALE');
});
it('invalidates old cursors and clears selected groups when the observed number changes', async () => {
  const h = await fixture(), first: any = await h.service.refresh(h.principal, h.channel);
  await h.service.select(h.principal, h.channel, h.selection(first)); h.setPhone('15550000002');
  const second: any = await h.service.refresh(h.principal, h.channel);
  expect(second.snapshot.scope.identityRevision).toBe(2);
  expect(second.snapshot.scope.identityFingerprint).not.toBe(first.snapshot.scope.identityFingerprint);
  expect(second.items.every((item: any) => !item.selected)).toBe(true);
  await expect(h.service.page(h.principal, h.channel, { limit: 50, cursor: { snapshotId: first.snapshot.snapshotId, afterGroupJid: first.items[0].groupJid } })).rejects.toThrow('GROUP_CATALOG_CHANGED');
});
it('does not publish data if the number changes during provider IO', async () => {
  const h = await fixture(); h.onRead(async () => { h.setPhone('15550000002'); });
  await expect(h.service.refresh(h.principal, h.channel)).rejects.toThrow('GROUP_IDENTITY_CHANGED');
  expect((await db.transact(h.organizationId, tx => tx.query('SELECT * FROM whatsapp_group_catalog_items'))).rows).toEqual([]);
});
it('rejects a foreign channel and isolates identical group JIDs by organization/channel', async () => {
  const h = await fixture(), other = await fixture();
  await h.service.refresh(h.principal, h.channel); await other.service.refresh(other.principal, other.channel);
  await expect(h.service.page(h.principal, other.channel, { limit: 50 })).rejects.toThrow('GROUP_CHANNEL_NOT_FOUND');
  expect((await db.transact(h.organizationId, tx => tx.query('SELECT organization_id FROM whatsapp_group_catalog_items'))).rows).toEqual([{ organization_id: h.organizationId }, { organization_id: h.organizationId }]);
  await expect(db.transact(h.organizationId, tx => tx.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)', [h.organizationId, other.channel]))).rejects.toMatchObject({ code: '23503' });
});
it('rechecks membership after IO and keeps provider calls outside the transaction', async () => {
  const h = await fixture();
  const replacement = randomUUID();
  await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')", [replacement, `${replacement}@example.test`]);
  await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [h.organizationId, replacement]);
  h.onRead(async () => {
    await db.database.pool.query("UPDATE instances SET name='Changed outside IO' WHERE organization_id=$1 AND id=$2", [h.organizationId, h.instance]);
    await db.database.pool.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2", [h.organizationId, h.actorId]);
  });
  await expect(h.service.refresh(h.principal, h.channel)).rejects.toThrow('GROUP_ACCESS_DENIED');
  expect((await db.database.pool.query('SELECT * FROM whatsapp_group_catalog_items WHERE organization_id=$1', [h.organizationId])).rows).toEqual([]);
});
it('preserves a sanitized operational denial after suspension during refresh and lease cleanup', async () => {
  const h = await fixture(), first = await h.service.refresh(h.principal, h.channel);
  h.setGroups(groups(3));
  h.onRead(async () => {
    await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [h.organizationId]);
  });
  const denied = await h.service.refresh(h.principal, h.channel).then(() => null, (error: unknown) => error);
  const persisted = (await db.database.pool.query(`SELECT snapshot_id,lease_token,lease_expires_at
    FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2`, [h.organizationId, h.channel])).rows[0];
  expect(persisted).toEqual({ snapshot_id: first.snapshot.snapshotId, lease_token: null, lease_expires_at: null });
  expect((await db.database.pool.query('SELECT count(*)::int AS count FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND channel_id=$2', [h.organizationId, h.channel])).rows[0].count).toBe(2);
  expect((await db.database.pool.query('SELECT count(*)::int AS count FROM messaging_outbox WHERE organization_id=$1', [h.organizationId])).rows[0].count).toBe(0);
  expect(denied).toMatchObject({ code: 'ORGANIZATION_NOT_ACTIVE', status: 403, message: 'ORGANIZATION_NOT_ACTIVE' });
  expect(denied).toBeInstanceOf(TenantOperationalError);
});
it('rejects provider overflow without replacing the previously observed complete catalog', async () => {
  const h = await fixture(), first: any = await h.service.refresh(h.principal, h.channel); h.setGroups(groups(2001));
  await expect(h.service.refresh(h.principal, h.channel)).rejects.toThrow('PROVIDER_INVALID_RESPONSE');
  const last: any = await h.service.page(h.principal, h.channel, { limit: 50 });
  expect(last.items).toEqual(first.items); expect(last.snapshot.status).toBe('STALE');
});
it('denies an old number selection even before the catalog TTL expires', async () => {
  const h = await fixture(), first = await h.service.refresh(h.principal, h.channel);
  h.setPhone('15550000002');
  await expect(h.service.select(h.principal, h.channel, h.selection(first))).rejects.toThrow('GROUP_IDENTITY_CHANGED');
  const page = await h.service.page(h.principal, h.channel, { limit: 50 });
  expect(page.snapshot.status).toBe('STALE'); expect(page.items[0]!.selected).toBe(false);
});
async function blockedBy(pid: number) {
  await vi.waitFor(async () => {
    const count = (await db.database.pool.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].count;
    expect(count).toBeGreaterThan(0);
  }, { timeout: 5000, interval: 25 });
}
it('reads current channel state after waiting for a concurrent archive lock', async () => {
  const h = await fixture(); await h.service.refresh(h.principal, h.channel);
  const holder = await db.database.pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM instances WHERE organization_id=$1 AND id=$2 FOR UPDATE', [h.organizationId, h.instance]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = h.service.page(h.principal, h.channel, { limit: 50 });
    const denied = expect(pending).rejects.toThrow('GROUP_CHANNEL_NOT_FOUND');
    await blockedBy(pid);
    await holder.query('UPDATE instances SET archived_at=clock_timestamp() WHERE organization_id=$1 AND id=$2', [h.organizationId, h.instance]);
    await holder.query('COMMIT'); await denied;
  } finally { await holder.query('ROLLBACK'); await pending?.catch(() => {}); holder.release(); }
});
it('cannot publish with a lease expiring while the post-IO transaction waits for a lock', async () => {
  const h = await fixture(), first = await h.service.refresh(h.principal, h.channel);
  const holder = await db.database.pool.connect();
  let pending: Promise<unknown> | undefined, pid: number | undefined;
  h.onRead(async () => {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM instances WHERE organization_id=$1 AND id=$2 FOR UPDATE', [h.organizationId, h.instance]);
    pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query("UPDATE whatsapp_group_catalogs SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE organization_id=$1 AND channel_id=$2", [h.organizationId, h.channel]);
  });
  try {
    pending = h.service.refresh(h.principal, h.channel);
    const denied = expect(pending).rejects.toThrow('GROUP_REFRESH_LEASE_LOST');
    await vi.waitFor(() => expect(pid).toBeTypeOf('number'), { timeout: 5000, interval: 25 });
    await blockedBy(pid!);
    await vi.waitFor(async () => expect((await holder.query('SELECT clock_timestamp()>lease_expires_at AS expired FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2', [h.organizationId, h.channel])).rows[0].expired).toBe(true), { timeout: 5000, interval: 25 });
    await holder.query('COMMIT'); await denied;
    const last = await h.service.page(h.principal, h.channel, { limit: 50 });
    expect(last.snapshot.snapshotId).toBe(first.snapshot.snapshotId); expect(last.snapshot.status).toBe('STALE');
  } finally { await holder.query('ROLLBACK'); await pending?.catch(() => {}); holder.release(); }
});
