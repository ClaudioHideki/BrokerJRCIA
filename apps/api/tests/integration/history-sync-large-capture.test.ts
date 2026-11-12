import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createHistorySyncStore } from '../../src/modules/history-sync/store.js';
import { acceptHistorySourceChunk } from '../../src/modules/history-sync/source.js';
import type { HistorySyncScope } from '../../src/modules/history-sync/contract.js';
import { createOriginJournal, installOriginJournal } from '../../../../integrations/evolution-origin-journal/src/journal.mjs';

// Synthetic source/native persistence reconciliation. This is NOT a 50/400/900
// session benchmark, a throughput SLA, a consumer-delivery or a phone test.
it.skipIf(process.env.HISTORY_SYNC_BULK_LAB !== 'true')('reconciles more than ten thousand source IDs across bounded pages and a source restart', async () => {
  const db = await attendanceDatabase(), started = performance.now(), count = 10_001;
  try {
    const t = await seedAttendanceTenant(db.database, false), instanceId = randomUUID();
    await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
      SELECT $1::uuid,organization_id,provider_account_id,($1::uuid)::text,($1::uuid)::text FROM messaging_channels WHERE id=$2`, [instanceId,t.channel]);
    await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=(SELECT provider_account_id FROM messaging_channels WHERE id=$1)", [t.channel]);
    await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1", [t.channel,instanceId]);
    await db.database.pool.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)', [t.org,t.channel]);
    const scope: HistorySyncScope = { organizationId:t.org,channelId:t.channel,instanceId,engineId:'synthetic-large',engineGeneration:1,
      sessionGeneration:randomUUID(),bindingFingerprint:'a'.repeat(64),identityScopeId:randomUUID(),historyAccountIdentity:randomUUID(),ownerFingerprint:'b'.repeat(64) };
    const store = createHistorySyncStore({ transact:db.transact,encryptionKey:Buffer.alloc(32,73),maxStagedBytes:8*1024*1024,assertCurrentScope:async()=>{} });
    const now = new Date(), run = await store.admit(scope,randomUUID(),{mode:'FULL_AVAILABLE',categories:['INDIVIDUAL','GROUP']},now);
    await installOriginJournal(db.database.pool);
    const source = () => createOriginJournal({pool:db.database.pool,encryptionKey:Buffer.alloc(32,73),history:{maxStagedBytes:8*1024*1024}}).history!;
    const individual = `${'1'.repeat(11)}@s.whatsapp.net`, group = '100-200@g.us';
    const expected = Array.from({length:count},(_,i)=>`synthetic-large-${String(i).padStart(5,'0')}`);
    const input = {'messaging-history.set':{isLatest:true,progress:100,contacts:[],
      chats:[{id:individual,name:'Synthetic individual'},{id:group,name:'Synthetic group'}],
      messages:expected.map((id,i)=>({key:{id,remoteJid:i%2?group:individual,fromMe:false,participant:i%2?'12345@lid':undefined},
        messageTimestamp:1600000000+i,message:{conversation:`Synthetic bulk record ${i}`}}))}};
    const initial = source();
    await initial.append(initial.prepare(scope,run.id,input,{provenance:'SOCKET',captureId:randomUUID(),capturedAt:now,startOrdinal:0}));
    let pages = 0;
    for (;;) {
      // Reconstructing this port intentionally discards all process-local state.
      const restarted = source(), [page] = await restarted.pending(scope,{runId:run.id,limit:1});
      if (!page) break;
      expect(page.chunk.records.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(page.chunk))).toBeLessThanOrEqual(1_048_576);
      const receipt = await acceptHistorySourceChunk(store,scope,run.id,page.chunk,now);
      expect(await restarted.acknowledge(scope,page,receipt)).toBe(true);
      expect(await store.persistNext(scope,run.id,now)).toMatchObject({kind:'PERSISTED',blocked:0});
      pages++;
    }
    const native = (await db.transact(t.org,tx=>tx.query<{provider_message_id:string}>(
      'SELECT provider_message_id FROM history_sync_receipts WHERE channel_id=$1 ORDER BY provider_message_id',[t.channel]))).rows;
    expect(native.map(row=>row.provider_message_id)).toEqual(expected);
    expect(pages).toBe(101);
    const obligations = (await db.transact(t.org,tx=>tx.query<{state:string;count:string}>(
      'SELECT state,count(*)::text FROM history_sync_deliveries WHERE run_id=$1 GROUP BY state',[run.id]))).rows;
    expect(obligations).toEqual([{state:'PENDING',count:String(count+2)}]);
    expect((await db.database.pool.query('SELECT count(*)::integer AS kept FROM jrc_evolution_origin.history_chunks WHERE run_id=$1 AND state=$2',[run.id,'DELIVERED'])).rows[0].kept).toBe(pages);
    expect((await db.transact(t.org,tx=>tx.query('SELECT 1 FROM automation_executions WHERE organization_id=$1',[t.org]))).rowCount).toBe(0);
    expect((await db.transact(t.org,tx=>tx.query('SELECT 1 FROM messaging_outbox WHERE organization_id=$1',[t.org]))).rowCount).toBe(0);
    expect(await store.get(t.org,run.id)).toMatchObject({state:'RUNNING',capture:'CAPTURING'});
    console.info(JSON.stringify({syntheticSourceRecords:count,pages,independentIdsReconciled:native.length,
      elapsedMs:Math.round(performance.now()-started),consumerProjectionExecuted:false,realSessions:0}));
  } finally { await db.dispose(); }
}, 300_000);
