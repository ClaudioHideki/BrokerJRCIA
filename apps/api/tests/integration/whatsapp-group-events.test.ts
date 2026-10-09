import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { ensureQrChannel, createQrMessagingService } from '../../src/modules/messaging/qr-service.js';
import { createWhatsAppGroupCatalog } from '../../src/modules/whatsapp-groups/service.js';
import { createWhatsAppGroupEvents } from '../../src/modules/whatsapp-groups/events.js';
import { normalizeQrGroupEvents } from '../../src/modules/messaging/qr-group-events.js';
import { createWhatsAppGroupWebhookConfiguration } from '../../src/modules/whatsapp-groups/webhook-configuration.js';
import { createLifecycleService, withLifecyclePlatformTransaction, withLifecycleWorkerTransaction } from '../../src/modules/lifecycle/service.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
const encryptionKey = Buffer.alloc(32, 43).toString('base64'), signingKey = 'synthetic-key'.repeat(4);
beforeAll(async () => {
  db = await attendanceDatabase();
}, 60000);
afterAll(async () => { await db?.dispose(); });
const eventService = createWhatsAppGroupEvents({ encryptionKey });
const raw = (action = 'remove', participants = ['15550000001@s.whatsapp.net'], override: Record<string, unknown> = {}) => ({
  instance: 'synthetic-instance', event: 'group-participants.update', sender: '15550000001@s.whatsapp.net',
  date_time: '2026-10-08T10:00:00.000Z', apikey: 'private-canary-token',
  data: { id: '10000@g.us', author: '123456789@lid', action, participants }, ...override,
});
async function fixture() {
  const principal = await runInAdminTransaction(db.database.pool, async tx => {
    const org = await createOrganization(tx, { name: 'Synthetic G2', slug: `g2-${randomUUID()}` });
    const actor = (await tx.query<{ id: string }>("INSERT INTO users(email,password_hash) VALUES($1,'test-only') RETURNING id", [`${org.id}@example.test`])).rows[0]!.id;
    await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [org.id, actor]);
    return { organizationId: org.id, actorId: actor };
  });
  const data = await db.transact(principal.organizationId, async tx => {
    const provider = (await tx.query<{ id: string }>("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','G2') RETURNING id", [principal.organizationId])).rows[0]!.id;
    const upstreamKey = `g2-${randomUUID()}`;
    const instance = (await tx.query<{ id: string }>("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'G2',$3,'CONNECTED') RETURNING id", [principal.organizationId, provider, upstreamKey])).rows[0]!.id;
    return { instance, upstreamKey, channel: (await ensureQrChannel(tx, principal.organizationId, instance)).id };
  });
  let phone = '15550000001';
  const catalog = createWhatsAppGroupCatalog({ encryptionKey, transact: db.transact,
    readIdentity: async () => ({ connected: true, phone }),
    readGroups: async () => [{ groupJid: '10000@g.us', subject: 'Synthetic group', participantCount: 2,
      restrict: false, announce: false, isCommunity: false, isCommunityAnnounce: false, linkedParent: null }],
  });
  const page = await catalog.refresh(principal, data.channel);
  await catalog.select(principal, data.channel, { expectedSnapshotId: page.snapshot.snapshotId,
    expectedCatalogRevision: page.snapshot.catalogRevision, expectedIdentityRevision: page.snapshot.scope.identityRevision,
    expectedIdentityFingerprint: page.snapshot.scope.identityFingerprint, groupJid: '10000@g.us', enabled: true });
  return { principal, org: principal.organizationId, ...data, catalog, setPhone: (value: string) => { phone = value; },
    ingest: (envelope = raw()) => db.transact(principal.organizationId, tx => eventService.ingest(tx, principal.organizationId, data.channel, normalizeQrGroupEvents(envelope, 'synthetic-instance'))),
    read: () => db.transact(principal.organizationId, async tx => ({
      events: (await tx.query('SELECT * FROM whatsapp_group_events WHERE channel_id=$1', [data.channel])).rows,
      members: (await tx.query('SELECT * FROM whatsapp_group_participants WHERE channel_id=$1', [data.channel])).rows,
      participation: (await tx.query('SELECT * FROM whatsapp_group_participation WHERE channel_id=$1', [data.channel])).rows,
      selected: (await tx.query('SELECT selected FROM whatsapp_group_catalog_items WHERE channel_id=$1', [data.channel])).rows[0]?.selected,
    })),
  };
}
it('persists authenticated number-scoped events once and invalidates a self removal without creating messages', async () => {
  const h = await fixture();
  expect(await h.ingest()).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
  expect(await h.ingest()).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
  const state = await h.read();
  expect(state.events).toHaveLength(1); expect(state.members).toHaveLength(1);
  expect(state.events[0]).toMatchObject({ group_jid: '10000@g.us', event_kind: 'REMOVE', author_jid: '123456789@lid',
    own_number_effect: 'REMOVAL_OBSERVED', provider_emitted_at: '2026-10-08T10:00:00.000Z' });
  expect(state.participation[0]).toMatchObject({ own_state: 'REMOVAL_OBSERVED' });
  expect(state.selected).toBe(false);
  expect(JSON.stringify(state)).not.toContain('private-canary-token');
  const page = await h.catalog.page(h.principal, h.channel, { limit: 50 });
  expect(page.snapshot).toMatchObject({ status: 'STALE', lastErrorCode: 'GROUP_MEMBERSHIP_CHANGED' });
  expect((await db.transact(h.org, tx => tx.query('SELECT * FROM messaging_outbox'))).rows).toEqual([]);
  expect((await db.transact(h.org, tx => tx.query('SELECT * FROM messaging_contacts'))).rows).toEqual([]);
});
it('keeps JIDs and scopes distinct for the same event in two organizations', async () => {
  const a = await fixture(), b = await fixture(); await a.ingest(); await b.ingest();
  const ra = await a.read(), rb = await b.read();
  expect(ra.events[0].event_key).not.toBe(rb.events[0].event_key);
  expect(ra.events[0].organization_id).toBe(a.org); expect(rb.events[0].organization_id).toBe(b.org);
  await expect(db.transact(a.org, tx => eventService.ingest(tx, a.org, b.channel, normalizeQrGroupEvents(raw(), 'synthetic-instance'))))
    .rejects.toThrow('GROUP_CHANNEL_NOT_FOUND');
});
it('never treats a LID fallback as the connected number and conservatively clears a removal selection', async () => {
  const h = await fixture();
  await h.ingest(raw('remove', ['123456789@lid'], { data: { id: '10000@g.us', action: 'remove', participants: ['123456789@lid'],
    participantsData: [{ jid: '123456789@lid', phoneNumber: '15550000001' }] } }));
  const state = await h.read();
  expect(state.events[0].own_number_effect).toBe('UNVERIFIED'); expect(state.participation[0].own_state).toBe('UNVERIFIED');
  expect(state.members[0].participant_jid).toBe('123456789@lid'); expect(state.selected).toBe(false);
  expect(JSON.stringify(state)).not.toContain('phoneNumber');
});
it('does not reactivate selection or assert present membership on a late ADD after removal', async () => {
  const h = await fixture(); await h.ingest();
  await h.ingest(raw('add', ['15550000001@s.whatsapp.net'], { date_time: '2026-10-08T09:00:00.000Z' }));
  const state = await h.read();
  expect(state.events).toHaveLength(2); expect(state.selected).toBe(false);
  expect(state.participation[0].own_state).toBe('REMOVAL_OBSERVED');
  expect(state.participation[0].last_event_id).toBe(state.events.find((row: any) => row.own_number_effect === 'REMOVAL_OBSERVED').id);
  expect(state.events.some((row: any) => row.own_number_effect === 'ADD_OBSERVED')).toBe(true);
});
it('does not admit events from another number or a LID sender, even when the envelope offers phoneNumber', async () => {
  const h = await fixture();
  expect(await h.ingest(raw('remove', undefined, { sender: '15550000002@s.whatsapp.net' }))).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
  expect(await h.ingest(raw('remove', undefined, { sender: '123456789@lid', phoneNumber: '15550000001' }))).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
  const state = await h.read(); expect(state.events).toHaveLength(0); expect(state.selected).toBe(true);
});
it('invalidates the old identity and clears selection on a connection observation, without accepting stale events', async () => {
  const h = await fixture();
  await db.transact(h.org, tx => eventService.observeConnection(tx, h.org, h.channel, { connected: true, phone: '15550000002' }));
  expect(await h.ingest()).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
  expect((await h.read()).selected).toBe(false);
  h.setPhone('15550000002'); await h.catalog.refresh(h.principal, h.channel);
  expect(await h.ingest(raw('remove', ['15550000002@s.whatsapp.net'], { sender: '15550000002@s.whatsapp.net' })))
    .toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
  expect((await h.read()).events[0].identity_revision).toBe('2');
});
it('updates metadata only through factual catalog refresh and keeps the event author separate from owner', async () => {
  const h = await fixture();
  await h.ingest(raw('remove', undefined, { event: 'groups.update', data: [{ id: '10000@g.us', subject: 'Provider changed', owner: '15550000003@s.whatsapp.net' }] }));
  const state = await h.read();
  expect(state.events[0].author_jid).toBeNull(); expect(state.events[0].metadata).toEqual({ subject: 'Provider changed', ownerJid: '15550000003@s.whatsapp.net' });
  const stale = await h.catalog.page(h.principal, h.channel, { limit: 50 });
  expect(stale.items[0].subject).toBe('Synthetic group'); expect(stale.snapshot.lastErrorCode).toBe('GROUP_METADATA_CHANGED');
  const refreshed = await h.catalog.refresh(h.principal, h.channel);
  expect(refreshed.snapshot.status).toBe('CURRENT');
});
it('cancels an in-flight catalog refresh so its old read cannot override a removal', async () => {
  const h = await fixture();
  await db.transact(h.org, tx => tx.query("UPDATE whatsapp_group_catalogs SET lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE channel_id=$1", [h.channel, randomUUID()]));
  await h.ingest();
  const row = (await db.transact(h.org, tx => tx.query('SELECT lease_token,lease_expires_at FROM whatsapp_group_catalogs WHERE channel_id=$1', [h.channel]))).rows[0];
  expect(row).toEqual({ lease_token: null, lease_expires_at: null });
});
it('uses forced RLS and restricted roles, and prevents unauthenticated foreign-context inserts', async () => {
  const tables = ['whatsapp_group_events', 'whatsapp_group_participants', 'whatsapp_group_participation','whatsapp_group_webhook_operations'];
  const rows = (await db.database.pool.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname
    FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname=ANY($1) ORDER BY c.relname`, [tables])).rows;
      expect(rows).toHaveLength(4); expect(rows.every(row => row.relrowsecurity && row.relforcerowsecurity && row.rolname === 'jrc_migrator')).toBe(true);
  const h = await fixture(); await h.ingest();
  const noContext = await db.database.pool.connect();
  try {
    await noContext.query('BEGIN'); await noContext.query('SET LOCAL ROLE jrc_app');
    expect((await noContext.query('SELECT * FROM whatsapp_group_events')).rows).toEqual([]); await noContext.query('ROLLBACK');
    for (const role of ['jrc_auth', 'jrc_platform']) {
      await noContext.query('BEGIN'); await noContext.query(`SET LOCAL ROLE ${role}`);
      await expect(noContext.query('SELECT * FROM whatsapp_group_events')).rejects.toMatchObject({ code: '42501' });
      await noContext.query('ROLLBACK');
    }
  } finally { await noContext.query('ROLLBACK'); noContext.release(); }
});
it('preserves inbound group observations for suspended or disabled companies without granting selection or Flow', async () => {
  for (const status of ['SUSPENDED', 'DISABLED']) {
    const h = await fixture(); await db.database.pool.query('UPDATE organizations SET status=$2 WHERE id=$1', [h.org, status]);
    expect(await h.ingest()).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    expect((await h.read()).selected).toBe(false);
    await expect(h.catalog.refresh(h.principal, h.channel)).rejects.toThrow('ORGANIZATION_NOT_ACTIVE');
    expect((await db.database.pool.query('SELECT * FROM automation_executions WHERE organization_id=$1', [h.org])).rows).toEqual([]);
  }
});
it('rejects disconnects, archived channels and deletion-fenced writes', async () => {
  for (const denial of ['DISCONNECTED', 'ARCHIVED', 'DELETING']) {
    const h = await fixture();
    if (denial === 'DISCONNECTED') await db.database.pool.query("UPDATE instances SET status='DISCONNECTED' WHERE id=$1", [h.instance]);
    if (denial === 'ARCHIVED') await db.database.pool.query('UPDATE instances SET archived_at=clock_timestamp() WHERE id=$1', [h.instance]);
    if (denial === 'DELETING') await db.database.pool.query('UPDATE messaging_channels SET deleting_at=clock_timestamp() WHERE id=$1', [h.channel]);
    await expect(h.ingest()).rejects.toThrow('GROUP_CHANNEL_NOT_FOUND');
  }
});
it('revalidates current state after waiting for an archive instance lock', async () => {
  const h = await fixture(), holder = await db.database.pool.connect(); let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query('SELECT id FROM instances WHERE id=$1 FOR UPDATE', [h.instance]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = h.ingest().then(value => ({ value }), error => ({ error }));
    await vi.waitFor(async () => expect((await db.database.pool.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].count).toBeGreaterThan(0), { timeout: 5000 });
    await holder.query('UPDATE instances SET archived_at=clock_timestamp() WHERE id=$1', [h.instance]); await holder.query('COMMIT');
    expect(await pending).toMatchObject({ error: { message: 'GROUP_CHANNEL_NOT_FOUND' } });
    expect((await db.database.pool.query('SELECT * FROM whatsapp_group_events WHERE organization_id=$1', [h.org])).rows).toEqual([]);
  } finally { await holder.query('ROLLBACK'); await pending?.catch(() => {}); holder.release(); }
});
it('admits groups only through the scoped authenticated QR webhook and ignores body tenant claims', async () => {
  const h = await fixture();
  const qr = createQrMessagingService({ baseUrl: 'https://engine.example.test', apiKey: signingKey,
    webhookOrigin: 'https://broker.example.test', signingKey, groups: eventService, transact: db.transact,
    resolveChannel: async id => id === h.channel ? { organizationId: h.org, instanceId: h.instance } : undefined });
  const body = { ...raw(), instance: h.upstreamKey, organizationId: randomUUID(), channelId: randomUUID() };
  await expect(qr.ingest(h.channel, 'Bearer invalid', body)).rejects.toMatchObject({ code: 'QR_WEBHOOK_UNAUTHORIZED', status: 401 });
  expect((await h.read()).events).toHaveLength(0);
  const scopedToken = createHmac('sha256', signingKey).update(`qr-webhook\0${h.org}\0${h.channel}`).digest('base64url');
  await qr.ingest(h.channel, `Bearer ${scopedToken}`, body);
  expect((await h.read()).events).toHaveLength(1); expect((await h.read()).selected).toBe(false);
  await expect(qr.ingest(h.channel, `Bearer ${scopedToken}`, { ...body, instance: 'other' })).rejects.toThrow('QR_INSTANCE_MISMATCH');
});
it('invalidates participation on disconnect and allows a subsequent authenticated reconnect to update instance state', async () => {
  const h = await fixture();
  const qr = createQrMessagingService({ baseUrl: 'https://engine.example.test', apiKey: signingKey,
    webhookOrigin: 'https://broker.example.test', signingKey, groups: eventService, transact: db.transact,
    resolveChannel: async () => ({ organizationId: h.org, instanceId: h.instance }) });
  const scopedToken = createHmac('sha256', signingKey).update(`qr-webhook\0${h.org}\0${h.channel}`).digest('base64url');
  await qr.ingest(h.channel, `Bearer ${scopedToken}`, { instance: h.upstreamKey, event: 'connection.update', data: { state: 'close' } });
  expect((await h.read()).selected).toBe(false);
  await qr.ingest(h.channel, `Bearer ${scopedToken}`, { instance: h.upstreamKey, event: 'connection.update', data: { state: 'open', wuid: '15550000001@s.whatsapp.net' } });
  expect((await db.database.pool.query('SELECT status FROM instances WHERE id=$1', [h.instance])).rows[0].status).toBe('CONNECTED');
  expect(await h.ingest()).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
});
it('keeps identical group JIDs independent on two channels of the same company', async () => {
  const h = await fixture();
  const second = await db.transact(h.org, async tx => {
    const provider = (await tx.query('SELECT provider_account_id FROM instances WHERE id=$1', [h.instance])).rows[0].provider_account_id;
    const instance = (await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'G2 second',$3,'CONNECTED') RETURNING id", [h.org, provider, `g2-${randomUUID()}`])).rows[0].id;
    return (await ensureQrChannel(tx, h.org, instance)).id;
  });
  await h.catalog.refresh(h.principal, second); await h.ingest();
  expect(await db.transact(h.org, tx => eventService.ingest(tx, h.org, second, normalizeQrGroupEvents(raw(), 'synthetic-instance'))))
    .toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
  const rows = (await db.transact(h.org, tx => tx.query('SELECT channel_id,event_key FROM whatsapp_group_events ORDER BY channel_id'))).rows;
  expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.channel_id)).size).toBe(2);
  expect(rows[0].event_key).not.toBe(rows[1].event_key);
});
it('purges group facts only with the nominated lifecycle operation and leaves the other company intact', async () => {
  const a = await fixture(), b = await fixture(); await a.ingest(); await b.ingest();
  const ca=configuration(a,{setConfiguration:async()=>{throw new Error('lost ACK');}}),cb=configuration(b);
  await expect(ca.service.ensure(a.principal,a.channel)).rejects.toMatchObject({code:'GROUP_WEBHOOK_UNKNOWN'});
  await cb.service.ensure(b.principal,b.channel);
  const url = new URL(db.database.connectionString); url.username = 'jrc_platform'; url.password = '';
  const platform = new Pool({ connectionString: url.toString() }); url.username = 'jrc_lifecycle';
  const worker = new Pool({ connectionString: url.toString() });
  const service = createLifecycleService({ transact: work => withLifecyclePlatformTransaction(platform, work), deprovision: async () => {} });
  const workerService = createLifecycleService({ transact: work => withLifecycleWorkerTransaction(worker, work), deprovision: async () => {} });
  try {
    await expect(platform.query('SELECT lifecycle_purge_channel($1,$2)', [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '42501' });
    const operation = await service.requestChannel(a.org, a.instance, 'G2', 'Synthetic nominated cleanup', 'TENANT', a.principal.actorId);
    await expect(a.ingest()).rejects.toThrow('GROUP_CHANNEL_NOT_FOUND');
    expect(await workerService.processOne()).toBe(true);
    expect((await service.status(a.org, a.instance, operation.operationId)).status).toBe('COMPLETED');
    for (const table of ['whatsapp_group_events', 'whatsapp_group_participation', 'whatsapp_group_participants','whatsapp_group_webhook_operations']) {
      expect((await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [a.org])).rows).toEqual([]);
      expect((await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [b.org])).rows).toHaveLength(1);
    }
  } finally { await platform.end(); await worker.end(); }
});

function configuration(h: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Parameters<typeof createWhatsAppGroupWebhookConfiguration>[0]> = {}) {
  let providerState: 'MATCHING'|'MISMATCHED'|'MISSING' = 'MISMATCHED';
  const read = vi.fn(async () => providerState), set = vi.fn(async () => { providerState = 'MATCHING'; });
  const options = { encryptionKey,configurationScope:'synthetic-private-config-scope',transact:db.transact,
    readIdentity:async()=>({connected:true,phone:'15550000001'}),readConfiguration:read,setConfiguration:set,...overrides };
  return { service:createWhatsAppGroupWebhookConfiguration(options),read,set,options,setState:(value:typeof providerState)=>{providerState=value;} };
}
it('updates an existing QR webhook exactly once before catalog refresh and exposes only configuration state',async()=>{
  const h=await fixture(),c=configuration(h);
  expect(await c.service.status(h.principal,h.channel)).toMatchObject({status:'UNCONFIGURED',nextAction:'UPDATE_GROUPS'});
  await c.service.ensure(h.principal,h.channel);
  expect(c.set).toHaveBeenCalledTimes(1);expect(c.read).toHaveBeenCalledTimes(2);
  const status=await c.service.status(h.principal,h.channel);
  expect(status).toMatchObject({status:'CONFIRMED',configurationRevision:2,nextAction:'UPDATE_GROUPS',safeError:null});
  expect(JSON.stringify(status)).not.toContain(h.upstreamKey);expect(JSON.stringify(status)).not.toContain('private');
  await c.service.ensure(h.principal,h.channel);expect(c.set).toHaveBeenCalledTimes(1);
});
it('keeps post-dispatch uncertainty durable and performs only GET reconciliation after restart',async()=>{
  const h=await fixture(),set=vi.fn(async()=>{throw new Error('lost-private-ack');}),c=configuration(h,{setConfiguration:set});
  await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_WEBHOOK_UNKNOWN'});
  expect(await c.service.status(h.principal,h.channel)).toMatchObject({status:'UNKNOWN',nextAction:'RECONCILE_READ_ONLY'});
  const restarted=createWhatsAppGroupWebhookConfiguration(c.options);
  await expect(restarted.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_WEBHOOK_UNKNOWN'});
  expect(set).toHaveBeenCalledTimes(1);
  c.setState('MATCHING');await restarted.ensure(h.principal,h.channel);
  expect(await restarted.status(h.principal,h.channel)).toMatchObject({status:'CONFIRMED'});expect(set).toHaveBeenCalledTimes(1);
});
it('confirms a lost ACK through matching GET and never mistakes webhook confirmation for a fresh catalog',async()=>{
  const h=await fixture(),c=configuration(h);
  c.options.setConfiguration=vi.fn(async()=>{c.setState('MATCHING');throw new Error('lost ACK');});
  const service=createWhatsAppGroupWebhookConfiguration(c.options);await service.ensure(h.principal,h.channel);
  await h.ingest();
  expect(await service.status(h.principal,h.channel)).toMatchObject({status:'CONFIRMED'});
  expect((await h.catalog.page(h.principal,h.channel,{limit:50})).snapshot.status).toBe('STALE');
  expect((await h.read()).selected).toBe(false);
});
it('treats unavailable preflight as retryable without dispatching any configuration mutation',async()=>{
  const h=await fixture(),read=vi.fn().mockRejectedValueOnce(new Error('private-token')).mockResolvedValue('MISMATCHED'),c=configuration(h,{readConfiguration:read});
  await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_WEBHOOK_UNAVAILABLE'});expect(c.set).not.toHaveBeenCalled();
  expect(await c.service.status(h.principal,h.channel)).toMatchObject({status:'UNCONFIGURED',safeError:'CONFIGURATION_UNAVAILABLE'});
});
it('revalidates current membership after I/O and publishes no private snapshot after revocation',async()=>{
  const h=await fixture();
  await runInAdminTransaction(db.database.pool,async tx=>{
    const actor=(await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id",[`${randomUUID()}@example.test`])).rows[0].id;
    await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[h.org,actor]);
  });
  const c=configuration(h,{readConfiguration:async()=>{
    await db.database.pool.query("UPDATE memberships SET role='OPERATOR' WHERE organization_id=$1 AND user_id=$2",[h.org,h.principal.actorId]);return 'MISMATCHED';
  }});
  await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_ACCESS_DENIED',status:403});expect(c.set).not.toHaveBeenCalled();
  expect(await c.service.status(h.principal,h.channel)).toMatchObject({status:'UNCONFIGURED'});
  await db.database.pool.query('DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2',[h.org,h.principal.actorId]);
  await expect(c.service.status(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_ACCESS_DENIED',status:403});
});
it('does not publish CONFIRMED for an identity changed after dispatch and rejects a foreign channel',async()=>{
  const h=await fixture(),foreign=await fixture();let reads=0;
  const c=configuration(h,{readIdentity:async()=>({connected:true,phone:++reads>1?'15550000002':'15550000001'})});
  await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_IDENTITY_CHANGED'});
  expect(await c.service.status(h.principal,h.channel)).toMatchObject({status:'UNKNOWN',safeError:'IDENTITY_CHANGED'});expect(c.set).toHaveBeenCalledTimes(1);
  await expect(c.service.status(h.principal,foreign.channel)).rejects.toMatchObject({code:'GROUP_CHANNEL_NOT_FOUND'});
});
it('uses the existing explicit administrative group refresh to configure a previously connected standalone box',async()=>{
  const h=await fixture(),c=configuration(h),readGroups=vi.fn(async()=>[{groupJid:'10000@g.us',subject:'Standalone',participantCount:2,
    restrict:false,announce:false,isCommunity:false,isCommunityAnnounce:false,linkedParent:null}]);
  const catalog=createWhatsAppGroupCatalog({encryptionKey,transact:db.transact,readIdentity:async()=>({connected:true,phone:'15550000001'}),
    readGroups,ensureEventsConfiguration:c.service.ensure});
  await catalog.refresh(h.principal,h.channel);
  expect(c.set).toHaveBeenCalledTimes(1);expect(readGroups).toHaveBeenCalledTimes(1);
});
it('rechecks database lease time after provider I/O and refuses POST when the lease expired',async()=>{
  const h=await fixture(),c=configuration(h,{readConfiguration:async()=>{
    await db.database.pool.query("UPDATE whatsapp_group_webhook_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND channel_id=$2",[h.org,h.channel]);return 'MISMATCHED';
  }});
  await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_REFRESH_LEASE_LOST'});expect(c.set).not.toHaveBeenCalled();
});
it('keeps a dispatched operation uncertain after permission is revoked during remote mutation',async()=>{
  const h=await fixture();
  await runInAdminTransaction(db.database.pool,async tx=>{
    const actor=(await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id",[`${randomUUID()}@example.test`])).rows[0].id;
    await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[h.org,actor]);
  });
  const c=configuration(h,{setConfiguration:async()=>{
    c.setState('MATCHING');await db.database.pool.query("UPDATE memberships SET role='OPERATOR' WHERE organization_id=$1 AND user_id=$2",[h.org,h.principal.actorId]);
  }});
  await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_ACCESS_DENIED',status:403});
  expect(await c.service.status(h.principal,h.channel)).toMatchObject({status:'UNKNOWN',safeError:'ACCESS_DENIED'});
});
it('serializes concurrent clicks and reconciles a stale dispatch lease using only read operations',async()=>{
  const h=await fixture();let release!:()=>void,entered!:()=>void;
  const dispatchStarted=new Promise<void>(resolve=>{entered=resolve;}),continueDispatch=new Promise<void>(resolve=>{release=resolve;});
  const set=vi.fn(async()=>{entered();await continueDispatch;}),c=configuration(h,{setConfiguration:set});
  const pending=c.service.ensure(h.principal,h.channel).then(value=>({value}),error=>({error}));
  try{
    await dispatchStarted;
    await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_WEBHOOK_REFRESHING'});
    await db.database.pool.query("UPDATE whatsapp_group_webhook_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND channel_id=$2",[h.org,h.channel]);
    await expect(c.service.ensure(h.principal,h.channel)).rejects.toMatchObject({code:'GROUP_WEBHOOK_UNKNOWN'});
    expect(set).toHaveBeenCalledTimes(1);
  }finally{release();await pending;}
});
