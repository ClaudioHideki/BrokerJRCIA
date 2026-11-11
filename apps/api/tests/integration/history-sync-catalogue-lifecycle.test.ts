import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  await store.acceptChunk(scope,run.id,{ schemaVersion: 2,provenance: 'SOCKET',scope,chunkId: randomUUID(),ordinal: 0,capturedAt: now.toISOString(),
    isLast: false,progress: null,records,checksum: historySyncRecordsDigest(records) },now);
  await store.catalogNext(scope,run.id,now);
  await store.command(scope,run.id,1,'CANCEL');
  const owner = (await db.database.pool.query(`SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'`,[t.org])).rows[0].user_id;
  return { ...t,channel,instance,owner };
}

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
