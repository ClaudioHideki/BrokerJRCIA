import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>,org:string;
beforeAll(async()=>{
 db=await attendanceDatabase();org=(await seedAttendanceTenant(db.database,false)).org;
});
afterAll(async()=>{await db?.dispose();});
const probe=()=>db.transact(org,tx=>probeRequiredRuntimeSchema(sql=>tx.query(sql)));
it('accepts the private-media schema with required ownership, RLS, constrained lifecycle and grants',async()=>{expect(await probe()).toBe(true);});
it.each([
 ['forced object RLS','ALTER TABLE media_private_objects NO FORCE ROW LEVEL SECURITY','ALTER TABLE media_private_objects FORCE ROW LEVEL SECURITY'],
 ['app operation write','REVOKE INSERT ON media_private_operations FROM jrc_app','GRANT INSERT ON media_private_operations TO jrc_app'],
 ['immutable object trigger','ALTER TABLE media_private_objects DISABLE TRIGGER media_private_objects_immutable','ALTER TABLE media_private_objects ENABLE TRIGGER media_private_objects_immutable'],
 ['dedicated cleanup guard','ALTER TABLE media_private_operations DISABLE TRIGGER media_private_delete_guard','ALTER TABLE media_private_operations ENABLE TRIGGER media_private_delete_guard'],
 ['object owner','ALTER TABLE media_private_objects OWNER TO jrc_lifecycle','ALTER TABLE media_private_objects OWNER TO jrc_migrator'],
 ['tenant policy','ALTER POLICY media_private_tenant ON media_private_operations RENAME TO damaged_private_tenant','ALTER POLICY damaged_private_tenant ON media_private_operations RENAME TO media_private_tenant'],
 ['restricted authentication grants','GRANT SELECT ON media_private_objects TO jrc_auth','REVOKE SELECT ON media_private_objects FROM jrc_auth'],
 ['private function PUBLIC ACL','GRANT EXECUTE ON FUNCTION media_private_channel_open(uuid,uuid) TO PUBLIC','REVOKE EXECUTE ON FUNCTION media_private_channel_open(uuid,uuid) FROM PUBLIC'],
 ['private function app ACL','REVOKE EXECUTE ON FUNCTION media_private_worker_organizations(uuid,integer) FROM jrc_app','GRANT EXECUTE ON FUNCTION media_private_worker_organizations(uuid,integer) TO jrc_app'],
 ['private function definer','ALTER FUNCTION media_private_channel_open(uuid,uuid) SECURITY INVOKER','ALTER FUNCTION media_private_channel_open(uuid,uuid) SECURITY DEFINER'],
])('refuses a schema without %s',async(_label,breakSql)=>{
 const client=await db.database.pool.connect();
 // Read the uncommitted catalogue change from the same connection under the
 // actual app role, then roll back ownership and its implicit ACL changes.
 try{await client.query('BEGIN');await client.query(breakSql);await client.query('SET LOCAL ROLE jrc_app');
  expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);}
 finally{await client.query('ROLLBACK');client.release();}
 expect(await probe()).toBe(true);
});
