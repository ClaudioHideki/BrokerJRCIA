import {reportQrEvidence} from '../../../../scripts/report-qr-outbound-evidence.mjs';
import {connectionStringForRole} from './helpers/task7.js';
import {Client} from 'pg';
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {applyLiveClaimStreak} from '../../src/db/apply-live-claim-streak.js';
import * as schemaStatus from '../../src/db/schema-status.js';

it('applies only the audited claim-streak migration once on the exact preceding schema',async()=>{
  const db=await attendanceDatabase();
  try{
    const t=await seedAttendanceTenant(db.database);
    const {pool,connectionString}=db.database;
    const current=await schemaStatus.loadExpectedMigrations();
    await expect(applyLiveClaimStreak(connectionString,false)).rejects.toThrow('UNEXPECTED_IMAGE_MANIFEST');
    const target=current.find(row=>row.name==='0096_chatwoot_live_claim_streak')!;
    // Exercise the preserved, image-pinned 0096 tool on its original disposable schema.
    await pool.query('DROP VIEW qr_traced_dispatch_attempts');
    await pool.query('DROP TABLE qr_dispatch_evidence');
    await pool.query("DELETE FROM lifecycle_purge_catalogue WHERE table_name='qr_dispatch_evidence'");
    await pool.query('DROP FUNCTION qr_keep_dispatch_trace()');
    await pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at>$1',[target.createdAt]);
    vi.spyOn(schemaStatus,'loadExpectedMigrations').mockResolvedValue(current.filter(row=>row.createdAt<=target.createdAt));
    const request=[{organization:t.org,integration:t.integration,account:7,inbox:9,revision:1,message:71902,conversation:688}];
    const reportClient=new Client({connectionString:connectionStringForRole(connectionString,'jrc_app')});
    await reportClient.connect();
    try{expect(await reportQrEvidence(reportClient,request)).toMatchObject({schema:'pre-trace',results:[{rows:[{finding:'NO_EXACT_REPLY_JOB'}]}]});}
    finally{await reportClient.end();}
    const writer=await pool.connect(),migration=await pool.connect();
    try{
      const source=readFileSync('apps/api/drizzle/migrations/0097_qr_dispatch_trace.sql','utf8');
      await writer.query('BEGIN');await writer.query('LOCK TABLE qr_dispatch_attempts IN ROW EXCLUSIVE MODE');
      await migration.query('BEGIN');await migration.query('SET LOCAL ROLE jrc_migrator');
      await expect(migration.query(source)).rejects.toMatchObject({code:'55P03'});
      await migration.query('ROLLBACK');await writer.query('ROLLBACK');
      const structure=()=>migration.query("SELECT relfilenode,(SELECT count(*) FROM pg_index WHERE indrelid=c.oid) indexes FROM pg_class c WHERE c.oid='qr_dispatch_attempts'::regclass");
      const previousStructure=(await structure()).rows[0];
      await migration.query('BEGIN');await migration.query('SET LOCAL ROLE jrc_migrator');await migration.query(source);
      expect((await structure()).rows[0]).toEqual(previousStructure);
      expect((await migration.query('SELECT count(*)::int n FROM qr_dispatch_evidence')).rows[0].n).toBe(0);
      await migration.query('ROLLBACK');
      expect((await migration.query("SELECT to_regclass('qr_dispatch_evidence') AS table")).rows[0].table).toBeNull();
    }finally{await migration.query('ROLLBACK');await writer.query('ROLLBACK');migration.release();writer.release();}
    const client=await pool.connect();
    try{
      await client.query('BEGIN READ ONLY');
      const dryRun=await client.query(readFileSync('docs/operations/qr-outbound-evidence.sql','utf8'),[t.org,t.integration,7,9,1,71902,688]);
      expect(dryRun.rows).toMatchObject([{finding:'NO_EXACT_REPLY_JOB'}]);
    }finally{await client.query('ROLLBACK');client.release();}
    const roleHashes=async()=>(await pool.query("SELECT rolname,md5(coalesce(rolpassword,'')) AS fingerprint FROM pg_authid WHERE rolname IN ('jrc_app','jrc_auth','jrc_platform','jrc_lifecycle','jrc_migrator') ORDER BY rolname")).rows;
    const before=await roleHashes();
    // Recreate the previous release only inside this isolated test database.
    await pool.query('ALTER TABLE public.chatwoot_connections DROP COLUMN live_claims_since_review');
    await pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE hash=$1',[target.hash]);
    expect(await applyLiveClaimStreak(connectionString,false)).toMatchObject({result:'READY'});
    expect((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='chatwoot_connections' AND column_name='live_claims_since_review'")).rows[0].n).toBe(0);
    const previous=(await pool.query('SELECT id,hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows[0];
    await pool.query("UPDATE drizzle.__drizzle_migrations SET hash='different' WHERE id=$1",[previous.id]);
    await expect(applyLiveClaimStreak(connectionString,true)).rejects.toThrow('MIGRATION_PRECONDITION_FAILED');
    await pool.query('UPDATE drizzle.__drizzle_migrations SET hash=$1 WHERE id=$2',[previous.hash,previous.id]);
    const results=await Promise.all([applyLiveClaimStreak(connectionString,true),applyLiveClaimStreak(connectionString,true)]);
    expect(results.map(row=>row.result).sort()).toEqual(['APPLIED','CURRENT']);
    expect((await pool.query('SELECT live_claims_since_review FROM public.chatwoot_connections WHERE id=$1',[t.integration])).rows)
      .toEqual([{live_claims_since_review:0}]);
    expect((await pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE hash=$1',[target.hash])).rows[0].n).toBe(1);
    expect(await roleHashes()).toEqual(before);
  }finally{vi.restoreAllMocks();await db.dispose();}
},90_000);
