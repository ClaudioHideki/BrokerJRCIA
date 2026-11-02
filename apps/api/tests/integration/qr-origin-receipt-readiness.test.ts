import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase} from './helpers/attendance.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});

it('accepts the intact origin receipt integrity boundary',async()=>{
 const client=await db.database.pool.connect();
 try{await client.query('SET ROLE jrc_app');expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(true);}
 finally{await client.query('RESET ROLE');client.release();}
});
it.each([
 'ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_pkey',
 `ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_pkey;
  ALTER TABLE qr_origin_receipts ADD PRIMARY KEY(organization_id,source_event_id)`,
 `ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_pkey;
  ALTER TABLE qr_origin_receipts ADD PRIMARY KEY(organization_id,channel_id,source_event_id) DEFERRABLE INITIALLY IMMEDIATE`,
 'ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_organization_id_fkey',
 'ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_organization_id_channel_id_fkey',
 'ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_organization_id_instance_id_fkey',
 `ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_organization_id_channel_id_fkey;
  ALTER TABLE qr_origin_receipts ADD FOREIGN KEY(channel_id,organization_id) REFERENCES messaging_channels(organization_id,id) ON DELETE CASCADE`,
 `ALTER TABLE qr_origin_receipts DROP CONSTRAINT qr_origin_receipts_organization_id_instance_id_fkey;
  ALTER TABLE qr_origin_receipts ADD FOREIGN KEY(organization_id,instance_id) REFERENCES instances(organization_id,id) ON DELETE RESTRICT`,
 'ALTER TABLE qr_origin_receipts NO FORCE ROW LEVEL SECURITY',
 'GRANT UPDATE ON qr_origin_receipts TO jrc_app',
 'GRANT UPDATE(content_hash) ON qr_origin_receipts TO jrc_app',
 'GRANT SELECT ON qr_origin_receipts TO jrc_platform',
])('rejects receipt integrity or privilege drift: %s',async change=>{
 const client=await db.database.pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE jrc_migrator');await client.query(change);
  await client.query('SET LOCAL ROLE jrc_app');expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
 }finally{await client.query('ROLLBACK');client.release();}
});
