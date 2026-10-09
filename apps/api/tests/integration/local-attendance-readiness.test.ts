import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase} from './helpers/attendance.js';
import {probeRequiredRuntimeSchema,RUNTIME_SCHEMA_BASELINE} from '../../src/db/runtime-schema.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
it('requires the directory baseline and reports a complete migration as ready',async()=>{
 expect(RUNTIME_SCHEMA_BASELINE).toBe('0051_whatsapp_group_events');
 expect(await probeRequiredRuntimeSchema(sql=>db.database.pool.query(sql))).toBe(true);
});
it.each([
 'ALTER TABLE local_attendance_teams NO FORCE ROW LEVEL SECURITY',
 'DROP POLICY attendance_tenant ON local_attendance_team_members',
 'ALTER TABLE attendance_sessions DROP CONSTRAINT attendance_local_target_scope',
 'ALTER TABLE attendance_sessions DROP COLUMN local_agent_id',
 'ALTER FUNCTION lock_local_attendance_member(uuid) SECURITY INVOKER',
 'GRANT EXECUTE ON FUNCTION current_local_attendance_members() TO PUBLIC',
 'REVOKE EXECUTE ON FUNCTION lock_local_attendance_member(uuid) FROM jrc_app',
 'GRANT SELECT(email) ON users TO jrc_app',
 `DO $$ DECLARE fk text; BEGIN SELECT conname INTO fk FROM pg_constraint WHERE conrelid='local_attendance_team_members'::regclass AND confrelid='memberships'::regclass; EXECUTE format('ALTER TABLE local_attendance_team_members DROP CONSTRAINT %I',fk); END $$`,
 `DO $$ DECLARE fk text; BEGIN SELECT conname INTO fk FROM pg_constraint WHERE conrelid='local_attendance_team_members'::regclass AND confrelid='local_attendance_teams'::regclass; EXECUTE format('ALTER TABLE local_attendance_team_members DROP CONSTRAINT %I',fk); END $$`,
 'ALTER TABLE local_attendance_team_members DROP CONSTRAINT local_attendance_team_members_pkey',
 'REVOKE UPDATE ON local_attendance_teams FROM jrc_app',
 'GRANT SELECT ON local_attendance_teams TO PUBLIC',
 'DROP TRIGGER lifecycle_qr_outbound_observations_block ON qr_outbound_observations',
 'ALTER TABLE qr_outbound_observations DISABLE TRIGGER lifecycle_qr_outbound_observations_block',
])('rejects a weakened local directory boundary: %s',async change=>{
 const client=await db.database.pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE jrc_migrator');
  await client.query(change);await client.query('SET LOCAL ROLE jrc_app');
  expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
 }finally{await client.query('ROLLBACK');client.release();}
});
