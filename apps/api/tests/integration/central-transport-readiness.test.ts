import { afterAll,beforeAll,expect,it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { probeRequiredRuntimeSchema,RUNTIME_SCHEMA_BASELINE } from '../../src/db/runtime-schema.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
it('requires central persistence as the runtime baseline',async()=>{
 expect(RUNTIME_SCHEMA_BASELINE).toBe('0046_central_transport');
 expect(await probeRequiredRuntimeSchema(sql=>db.database.pool.query(sql))).toBe(true);
});
it.each([
 'ALTER TABLE central_runtime_events NO FORCE ROW LEVEL SECURITY',
 'DROP POLICY central_tenant ON central_transport_bindings',
 'REVOKE INSERT ON central_runtime_events FROM jrc_app',
 'GRANT SELECT ON central_runtime_events TO PUBLIC',
 'ALTER TABLE messaging_channels DROP CONSTRAINT messaging_channels_organization_fk',
 'ALTER TABLE messaging_channels DROP CONSTRAINT messaging_channels_kind_fields',
 'ALTER TABLE central_transport_bindings DROP CONSTRAINT central_transport_bindings_origin_account_id_inbox_id_key',
 'ALTER TABLE central_runtime_events DROP CONSTRAINT central_runtime_events_organization_id_channel_id_event_key_key',
 'ALTER TABLE messaging_channels DROP COLUMN transport CASCADE',
])('rejects a weakened central storage boundary: %s',async change=>{
 const tx=await db.database.pool.connect();
 try{await tx.query('BEGIN');await tx.query('SET LOCAL ROLE jrc_migrator');await tx.query(change);await tx.query('SET LOCAL ROLE jrc_app');
 expect(await probeRequiredRuntimeSchema(sql=>tx.query(sql))).toBe(false);
 }finally{await tx.query('ROLLBACK');tx.release();}
});
