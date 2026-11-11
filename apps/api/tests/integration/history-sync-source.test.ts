import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createHistorySyncStore } from '../../src/modules/history-sync/store.js';
import { acceptHistorySourceChunk } from '../../src/modules/history-sync/source.js';
import { createOriginJournal, installOriginJournal } from '../../../../integrations/evolution-origin-journal/src/journal.mjs';
import type { HistorySyncScope } from '../../src/modules/history-sync/contract.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>, sourcePool: Pool;
beforeAll(async () => {
  db = await attendanceDatabase();
  sourcePool = new Pool({ connectionString: db.database.connectionString, max: 2 });
  await installOriginJournal(sourcePool);
}, 180000);
afterAll(async () => { await sourcePool?.end(); await db?.dispose(); });

it('relays sealed source history into Broker staging and safely reconciles a lost correlated ACK', async () => {
  const t = await seedAttendanceTenant(db.database), instanceId = randomUUID();
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
    SELECT $1::uuid,organization_id,provider_account_id,($1::uuid)::text,($1::uuid)::text FROM messaging_channels WHERE id=$2`, [instanceId,t.channel]);
  const scope: HistorySyncScope = { organizationId: t.org, channelId: t.channel, instanceId, engineId: 'synthetic-engine', engineGeneration: 1,
    sessionGeneration: randomUUID(), bindingFingerprint: 'a'.repeat(64), identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null };
  let revoked = false;
  const broker = createHistorySyncStore({ transact: db.transact, encryptionKey: Buffer.alloc(32,61), maxStagedBytes: 2000000,
    assertCurrentScope: async () => { if (revoked) throw Error('HISTORY_SYNC_AUTHORITY_REVOKED'); } });
  const now = new Date('2026-11-11T12:00:00Z');
  const run = await broker.admit(scope, randomUUID(), { mode: 'FULL_AVAILABLE', categories: ['INDIVIDUAL','GROUP','MEDIA'] }, now);
  const create = () => createOriginJournal({ pool: sourcePool, encryptionKey: Buffer.alloc(32,62), history: { maxStagedBytes: 2000000 } }).history;
  const origin = create();
  const captured = origin.prepare(scope,run.id,{ 'messaging-history.set': { isLatest: true, progress: 100, chats: [], contacts: [], messages: [{
    key: { id: 'synthetic-relay', remoteJid: '100-200@g.us', participant: `${'1'.repeat(11)}@s.whatsapp.net`, fromMe: false },
    messageTimestamp: 1600000000, message: { conversation: 'Synthetic group history' },
  }] } }, { captureId: randomUUID(), capturedAt: now, startOrdinal: 0, provenance: 'SOCKET' });
  await origin.append(captured);
  const [pending] = await origin.pending(scope);
  // Broker committed, but the source process did not receive this first ACK.
  const first = await acceptHistorySourceChunk(broker,scope,run.id,pending.chunk,now);
  const restarted = create(), [retry] = await restarted.pending(scope);
  const second = await acceptHistorySourceChunk(broker,scope,run.id,retry.chunk,now);
  expect(second).toEqual(first);
  expect(await restarted.acknowledge(scope,retry,second)).toBe(true);
  expect(await restarted.pending(scope)).toEqual([]);
  expect(first).toMatchObject({ protocol: 'jrc-history-source/2', kind: 'STAGED', durablyAccepted: true, runId: run.id });
  expect((await broker.get(t.org,run.id))?.capture).toBe('WAITING_IDENTITY');
  expect((await db.transact(t.org, tx => tx.query('SELECT count(*) FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].count).toBe('1');
  const tight = createHistorySyncStore({ transact: db.transact, encryptionKey: Buffer.alloc(32,61), maxStagedBytes: 1,
    assertCurrentScope: async () => { if (revoked) throw Error('HISTORY_SYNC_AUTHORITY_REVOKED'); } });
  const limitedRun = await tight.admit(scope,randomUUID(),{ mode: 'FULL_AVAILABLE',categories: ['INDIVIDUAL','GROUP','MEDIA'] },now);
  const gap = await acceptHistorySourceChunk(tight,scope,limitedRun.id,retry.chunk,now);
  expect(gap).toMatchObject({ protocol: 'jrc-history-source/2', kind: 'GAP', durablyAccepted: false,
    chunkId: retry.chunk.chunkId, reason: 'SOURCE_QUOTA' });
  expect((await tight.get(t.org,limitedRun.id))?.state).toBe('PARTIAL');
  revoked = true;
  await expect(acceptHistorySourceChunk(broker,scope,run.id,retry.chunk,now)).rejects.toThrow('HISTORY_SYNC_AUTHORITY_REVOKED');
});
