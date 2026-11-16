import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { connectionStringForRole } from './helpers/task7.js';
import { createLifecycleService, withLifecyclePlatformTransaction, withLifecycleWorkerTransaction } from '../../src/modules/lifecycle/service.js';
import { createHistorySyncStore } from '../../src/modules/history-sync/store.js';
import { historySyncRecordsDigest, type HistorySyncScope } from '../../src/modules/history-sync/contract.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>, platform: Pool, worker: Pool;
const actor = randomUUID(), now = new Date('2026-11-11T12:00:00Z');
beforeAll(async()=>{
  db = await attendanceDatabase();
  await db.database.pool.query(`INSERT INTO platform_users(id,email,password_hash,role,mfa_seed)
    VALUES($1,'catalogue-admin@example.test','no-login','SUPER_ADMIN','no-login')`,[actor]);
  platform = new Pool({ connectionString: connectionStringForRole(db.database.connectionString,'jrc_platform') });
  worker = new Pool({ connectionString: connectionStringForRole(db.database.connectionString,'jrc_lifecycle') });
},180000);
afterAll(async()=>{ await platform?.end(); await worker?.end(); await db?.dispose(); });

async function populated() {
  const t = await seedAttendanceTenant(db.database,false), provider = randomUUID(), instance = randomUUID(), channel = randomUUID();
  await db.database.pool.query(`INSERT INTO provider_accounts(id,organization_id,provider,name) VALUES($1,$2,'BAILEYS','Synthetic QR')`,[provider,t.org]);
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
    VALUES($1::uuid,$2,$3,'Synthetic catalogue QR',($1::uuid)::text,'DISCONNECTED')`,[instance,t.org,provider]);
  await db.database.pool.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference)
    VALUES($1,$2,$3,'BAILEYS',$4,'synthetic')`,[channel,t.org,provider,instance]);
  const scope: HistorySyncScope = { organizationId: t.org,channelId: channel,instanceId: instance,engineId: 'synthetic-engine',engineGeneration: 1,
    sessionGeneration: randomUUID(),bindingFingerprint: 'a'.repeat(64),historyAccountIdentity: randomUUID(),identityScopeId: randomUUID(),ownerFingerprint: 'b'.repeat(64) };
  const store = createHistorySyncStore({ transact: db.transact,encryptionKey: Buffer.alloc(32,79),maxStagedBytes: 1000000,assertCurrentScope: async()=>{} });
  const run = await store.admit(scope,randomUUID(),{ mode: 'FULL_AVAILABLE',categories: ['INDIVIDUAL'] },now);
  const records = [{ kind: 'CHAT',recipientKind: 'INDIVIDUAL',chatJid: '15550000001@s.whatsapp.net',displayName: 'Synthetic chat',lastMessageAt: 1600000000,unreadCount: 0 }];
  const chunk = randomUUID();
  await store.acceptChunk(scope,run.id,{ schemaVersion: 2,provenance: 'SOCKET',scope,chunkId: chunk,ordinal: 0,capturedAt: now.toISOString(),
    isLast: false,progress: null,records,checksum: historySyncRecordsDigest(records) },now);
  await store.catalogNext(scope,run.id,now);
  await store.command(scope,run.id,1,'CANCEL');
  const owner = (await db.database.pool.query(`SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'`,[t.org])).rows[0].user_id;
  return { ...t,channel,instance,owner,run: run.id,chunk };
}

const deliveryCases = [
  { label: 'active HTTP claim',state: 'PENDING',lease: 'ACTIVE' },
  { label: 'expired HTTP claim with no confirmed ACK',state: 'PENDING',lease: 'EXPIRED' },
  { label: 'retry after an uncertain HTTP outcome',state: 'PENDING',lease: 'NONE' },
  { label: 'receiver still waiting for private media',state: 'WAITING_MEDIA',lease: 'NONE' },
  { label: 'legacy DONE flag without a durable receiver receipt',state: 'DONE',lease: 'NONE' },
] as const;

async function uncertainDelivery(testCase: typeof deliveryCases[number]) {
  const target = await populated(), id = randomUUID();
  await db.database.pool.query(`INSERT INTO history_sync_record_results(organization_id,channel_id,run_id,chunk_id,record_index,disposition)
    VALUES($1,$2,$3,$4,0,'PEER')`,[target.org,target.channel,target.run,target.chunk]);
  // The canceled run cannot dispatch new work, but does not disprove an earlier
  // remote write. These rows model an attempted POST whose durable ACK is absent.
  await db.database.pool.query(`INSERT INTO history_sync_deliveries(organization_id,channel_id,run_id,chunk_id,record_index,id,state,
    attempts,lease_token,lease_until,last_error) VALUES($1,$2,$3,$4,0,$5,$6,1,$7,$8,'CHATWOOT_OUTCOME_UNKNOWN')`,
  [target.org,target.channel,target.run,target.chunk,id,testCase.state,testCase.lease === 'NONE' ? null : randomUUID(),
    testCase.lease === 'NONE' ? null : new Date(Date.now() + (testCase.lease === 'ACTIVE' ? 120000 : -120000))]);
  return { ...target,delivery: id };
}

async function legacyDeletion(target: Awaited<ReturnType<typeof uncertainDelivery>>,kind: 'CHANNEL'|'ORGANIZATION') {
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='ACTION_REQUIRED' WHERE status='REQUESTED'");
  const deletion = randomUUID();
  await db.database.pool.query(`INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,resource_name,messaging_channel_id,
    provider,upstream_key,actor_kind,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Synthetic legacy deletion')`,
  [deletion,target.org,kind,kind === 'CHANNEL' ? target.instance : target.org,kind === 'CHANNEL' ? 'Synthetic catalogue QR' : 'Attendance',
    kind === 'CHANNEL' ? target.channel : null,kind === 'CHANNEL' ? 'QR' : null,kind === 'CHANNEL' ? target.instance : null,
    kind === 'CHANNEL' ? 'TENANT' : 'PLATFORM',kind === 'CHANNEL' ? target.owner : actor]);
  await db.database.pool.query(`INSERT INTO lifecycle_cleanup_items(deletion_id,instance_id,upstream_key) VALUES($1,$2,$3)`,
  [deletion,target.instance,target.instance]);
  await db.database.pool.query('UPDATE messaging_channels SET deleting_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',
  [target.org,target.channel]);
  return deletion;
}

for (const kind of ['CHANNEL','ORGANIZATION'] as const) {
  it.each(deliveryCases)(`refuses ${kind} purge admission for $label without altering retained history`,async testCase=>{
    const target = await uncertainDelivery(testCase);
    const service = createLifecycleService({ transact: work=>withLifecyclePlatformTransaction(platform,work),deprovision: vi.fn() });
    const request = kind === 'CHANNEL'
      ? service.requestChannel(target.org,target.instance,'Synthetic catalogue QR','Synthetic authorized deletion','TENANT',target.owner)
      : service.requestOrganization(target.org,'Attendance','Synthetic authorized deletion',actor);
    await expect(request).rejects.toMatchObject({ code: 'LIFECYCLE_PENDING_WORK',status: 409 });
    const preview = kind === 'CHANNEL' ? await service.previewChannel(target.org,target.instance) : await service.previewOrganization(target.org);
    expect(preview.canDelete).toBe(false);
    expect(preview.blockers.length).toBeGreaterThan(0);
    const state = (await db.database.pool.query(`SELECT
      (SELECT count(*)::int FROM lifecycle_deletions WHERE organization_id=$1) AS deletions,
      (SELECT count(*)::int FROM history_sync_deliveries WHERE organization_id=$1 AND id=$2) AS deliveries,
      (SELECT deleting_at FROM messaging_channels WHERE organization_id=$1 AND id=$3) AS deleting_at`,
    [target.org,target.delivery,target.channel])).rows[0];
    expect(state).toEqual({ deletions: 0,deliveries: 1,deleting_at: null });
  });

  it.each(deliveryCases)(`rechecks legacy ${kind} deletion before external cleanup for $label`,async testCase=>{
    // Old releases could admit deletion despite a history delivery. Seed only
    // that persisted legacy state; real restricted worker/SQL paths run below.
    const target = await uncertainDelivery(testCase), deletion = await legacyDeletion(target,kind);
    const deprovision = vi.fn(async()=>{}), cleanupPrivateMedia = vi.fn(async()=>({ state: 'COMPLETE' as const }));
    const service = createLifecycleService({ transact: work=>withLifecycleWorkerTransaction(worker,work),deprovision,cleanupPrivateMedia });
    expect(await service.processOne()).toBe(true);
    expect(deprovision).not.toHaveBeenCalled();
    expect(cleanupPrivateMedia).not.toHaveBeenCalled();
    expect((await db.database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1',[deletion])).rows[0])
      .toEqual({ status: 'ACTION_REQUIRED' });
    expect((await db.database.pool.query('SELECT id FROM history_sync_deliveries WHERE organization_id=$1 AND id=$2',
      [target.org,target.delivery])).rows).toEqual([{ id: target.delivery }]);
    expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE organization_id=$1 AND id=$2',
      [target.org,target.channel])).rows).toEqual([{ id: target.channel }]);
  });
}

it('refuses engine deprovision at the SQL boundary even if an older worker skips the new preflight',async()=>{
  const target = await uncertainDelivery(deliveryCases[1]), deletion = await legacyDeletion(target,'CHANNEL'), lease = randomUUID();
  await db.database.pool.query(`UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL',lease_token=$2,
    lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1`,[deletion,lease]);
  await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='IN_FLIGHT' WHERE deletion_id=$1",[deletion]);
  await expect(worker.query('SELECT * FROM public.evolution_cleanup_snapshot($1,$2,$3,true)',[deletion,lease,target.instance]))
    .rejects.toMatchObject({ code: '23514',constraint: 'lifecycle_pending_work' });
  expect((await db.database.pool.query('SELECT id FROM history_sync_deliveries WHERE organization_id=$1 AND id=$2',
    [target.org,target.delivery])).rowCount).toBe(1);
});

it('preserves another tenant while explicitly deleting a channel with populated catalogue and page receipts',async()=>{
  const target = await populated(), other = await populated();
  const service = createLifecycleService({ transact: work=>withLifecyclePlatformTransaction(platform,work),deprovision: async()=>{} });
  const workerService = createLifecycleService({ transact: work=>withLifecycleWorkerTransaction(worker,work),deprovision: async()=>{} });
  const request = await service.requestChannel(target.org,target.instance,'Synthetic catalogue QR','Synthetic authorized deletion','TENANT',target.owner);
  await workerService.processOne();
  expect(await service.status(target.org,target.instance,request.operationId)).toMatchObject({ status: 'COMPLETED',errorCode: null });
  const counts = (await db.database.pool.query(`SELECT (SELECT count(*) FROM history_sync_peers WHERE organization_id=$1) AS target_peers,
    (SELECT count(*) FROM history_sync_catalogue_pages WHERE organization_id=$1) AS target_pages,
    (SELECT count(*) FROM history_sync_peers WHERE organization_id=$2) AS other_peers,
    (SELECT count(*) FROM history_sync_catalogue_pages WHERE organization_id=$2) AS other_pages`,[target.org,other.org])).rows[0];
  expect(counts).toEqual({ target_peers: '0',target_pages: '0',other_peers: '1',other_pages: '1' });
});

it('allows the existing explicit company purge to remove populated catalogue under its real definer role',async()=>{
  const target = await populated();
  const service = createLifecycleService({ transact: work=>withLifecyclePlatformTransaction(platform,work),deprovision: async()=>{} });
  const workerService = createLifecycleService({ transact: work=>withLifecycleWorkerTransaction(worker,work),deprovision: async()=>{} });
  const request = await service.requestOrganization(target.org,'Attendance','Synthetic authorized deletion',actor);
  await workerService.processOne();
  expect(await service.status(target.org,target.org,request.operationId)).toMatchObject({ status: 'COMPLETED',errorCode: null });
  expect((await db.database.pool.query('SELECT count(*) FROM organizations WHERE id=$1',[target.org])).rows[0].count).toBe('0');
});
