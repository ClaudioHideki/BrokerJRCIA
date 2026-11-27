import {expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {applyLiveClaimStreak} from '../../src/db/apply-live-claim-streak.js';
import {loadExpectedMigrations} from '../../src/db/schema-status.js';

it('applies only the audited claim-streak migration once on the exact preceding schema',async()=>{
  const db=await attendanceDatabase();
  try{
    const t=await seedAttendanceTenant(db.database);
    const {pool,connectionString}=db.database;
    const target=(await loadExpectedMigrations()).at(-1)!;
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
  }finally{await db.dispose();}
},90_000);
