import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {attendanceDatabaseBeforeFlow as attendanceDatabase} from './helpers/flow-promotion-test-fixture.js';
import {queryAsTenant} from './helpers/postgres.js';

// Real future order: active 0051, then the C2 predecessor and additive P9.
// No journal mutation or provider/object-store I/O is involved.
let db:Awaited<ReturnType<typeof attendanceDatabase>>,platform:Pool,worker:Pool;
let legacy:Awaited<ReturnType<typeof seedAttendanceTenant>>,legacyBefore:unknown;
function rolePool(role:string){const url=new URL(db.database.connectionString);url.username=role;url.password='';return new Pool({connectionString:url.href,max:1});}
beforeAll(async()=>{
 db=await attendanceDatabase();legacy=await seedAttendanceTenant(db.database);
 legacyBefore=(await db.database.pool.query('SELECT * FROM messaging_channels WHERE organization_id=$1',[legacy.org])).rows;
 const client=await db.database.pool.connect();try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE jrc_migrator');
  await client.query(await readFile(new URL('../../drizzle/migrations/0053_flow_delegation.sql',import.meta.url),'utf8'));await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 platform=rolePool('jrc_platform');worker=rolePool('jrc_lifecycle');
});
afterAll(async()=>{await platform?.end();await worker?.end();await db?.dispose();});
async function fixture(){
 const t=await seedAttendanceTenant(db.database),instance=randomUUID();
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0].provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
 await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Synthetic composed QR',$4,'CONNECTED')",[instance,t.org,provider,`composed-${instance}`]);
 await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$3,phone_number_id=NULL,waba_id=NULL WHERE organization_id=$1 AND id=$2",[t.org,t.channel,instance]);
 const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[t.org])).rows[0].user_id;
 await db.database.pool.query(`INSERT INTO flow_executor_cutovers(organization_id,integration_id,channel_id,host_kind,profile_revision,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,expected_owner_revision,phase)
  VALUES($1,$2,$3,'STOCK',1,1,7,9,1,1,0,'ROLLED_BACK')`,[t.org,t.integration,t.channel]);
 return {...t,actor,instance};
}
async function privateMedia(t:Awaited<ReturnType<typeof fixture>>,state:'PREPARED'|'UNKNOWN'){
 const media=randomUUID(),object=randomUUID(),client=await db.database.pool.connect();try{
  await client.query('BEGIN');
  await client.query(`INSERT INTO messaging_media(id,organization_id,channel_id,source,source_key,kind,file_name,mime_type,descriptor,status,storage_backend,private_object_id,byte_size,sha256)
   VALUES($1::uuid,$2,$3,'QR',$1::uuid::text,'document','synthetic.txt','text/plain','{}','STORING','PRIVATE_OBJECT',$4,1,$5)`,[media,t.org,t.channel,object,'a'.repeat(64)]);
  await client.query(`INSERT INTO media_private_objects(id,organization_id,channel_id,media_id,profile,destination_fingerprint,plain_byte_size,plain_sha256,cipher_byte_length,cipher_sha256,mime_type,kind,file_name,staging_ciphertext,reserved_bytes)
   VALUES($1,$2,$3,$4,'synthetic',$5,1,$5,1,$5,'text/plain','document','synthetic.txt','synthetic-ciphertext',1)`,[object,t.org,t.channel,media,'a'.repeat(64)]);
  await client.query(`INSERT INTO media_private_operations(id,organization_id,channel_id,object_id,kind,state,dispatched_at)
   VALUES($1,$2,$3,$1,'PUT',$4,CASE WHEN $4='UNKNOWN' THEN clock_timestamp() ELSE NULL END)`,[object,t.org,t.channel,state]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 return {media,object};
}
const request=(t:Awaited<ReturnType<typeof fixture>>)=>platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id',[t.org,t.instance,'Synthetic composed QR','Synthetic composition cleanup','TENANT',t.actor]);
async function recoveredDeletion(t:Awaited<ReturnType<typeof fixture>>,kind:'CHANNEL'|'ORGANIZATION',actor:string){
 const id=randomUUID(),lease=randomUUID();await db.database.pool.query(`INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,messaging_channel_id,provider,resource_name,actor_kind,actor_id,status,lease_token,lease_expires_at)
  VALUES($1,$2,$3,$4,$5,$6,'Synthetic recovered composition',$7,$8,'REMOVING_DATA',$9,clock_timestamp()+interval '1 minute')`,[id,t.org,kind,kind==='CHANNEL'?t.instance:t.org,kind==='CHANNEL'?t.channel:null,kind==='CHANNEL'?'QR':null,kind==='CHANNEL'?'TENANT':'PLATFORM',actor,lease]);return {id,lease};
}
it('composes 0051 -> C2 -> P9 without changing historical channels or exposing cancellation to app roles',async()=>{
 expect((await db.database.pool.query('SELECT * FROM messaging_channels WHERE organization_id=$1',[legacy.org])).rows).toEqual(legacyBefore);
 await expect(queryAsTenant(db.database.pool,'jrc_app',legacy.org,'SELECT lifecycle_cancel_safe_work($1,NULL)',[legacy.org])).rejects.toMatchObject({code:'42501'});
 await expect(platform.query('SELECT lifecycle_cancel_safe_work($1,NULL)',[legacy.org])).rejects.toMatchObject({code:'42501'});
 const rules=(await db.database.pool.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname=ANY($1) ORDER BY c.relname",[['media_private_objects','media_private_operations','flow_executor_cutovers']])).rows;
 expect(rules).toEqual(['flow_executor_cutovers','media_private_objects','media_private_operations'].map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,owner:'jrc_migrator'})));
});
it('preserves the C2 safe-work cancellation and channel purge through the new Flow admission wrapper',async()=>{
 const t=await fixture(),m=await privateMedia(t,'PREPARED'),id=(await request(t)).rows[0].id,lease=randomUUID();
 expect((await db.database.pool.query('SELECT state FROM media_private_operations WHERE id=$1',[m.object])).rows).toEqual([{state:'REJECTED'}]);
 expect((await db.database.pool.query('SELECT state,reserved_bytes,staging_ciphertext FROM media_private_objects WHERE id=$1',[m.object])).rows).toEqual([{state:'REJECTED',reserved_bytes:0,staging_ciphertext:null}]);
 await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1",[id]);
 await db.database.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[id,lease]);
 await worker.query('SELECT lifecycle_purge_channel($1,$2)',[id,lease]);
 expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rows).toEqual([]);
 for(const table of ['media_private_objects','media_private_operations','flow_executor_cutovers'])expect((await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`,[t.org])).rows).toEqual([]);
});
it.each([{ledger:'MEDIA',kind:'CHANNEL'},{ledger:'MEDIA',kind:'ORGANIZATION'},{ledger:'FLOW',kind:'CHANNEL'},{ledger:'FLOW',kind:'ORGANIZATION'}] as const)('keeps $ledger UNKNOWN immutable and blocks $kind admission and recovered purge after both migrations',async({ledger,kind})=>{
 const t=await fixture();let object:string|undefined;const actor=kind==='CHANNEL'?t.actor:randomUUID();
 if(kind==='ORGANIZATION')await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')",[actor,`${actor}@example.test`]);
 if(ledger==='MEDIA')object=(await privateMedia(t,'UNKNOWN')).object;else await db.database.pool.query("UPDATE flow_executor_cutovers SET phase='UNKNOWN' WHERE organization_id=$1",[t.org]);
 const table=ledger==='MEDIA'?'media_private_operations':'flow_executor_cutovers';
 const before=(await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`,[t.org])).rows;
 await expect(kind==='CHANNEL'?request(t):platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4)',[t.org,'Attendance','Synthetic composition cleanup',actor])).rejects.toMatchObject({constraint:'lifecycle_pending_work'});
 const d=await recoveredDeletion(t,kind,actor);await expect(worker.query(kind==='CHANNEL'?'SELECT lifecycle_purge_channel($1,$2)':'SELECT lifecycle_purge_organization($1,$2)',[d.id,d.lease])).rejects.toMatchObject({constraint:'lifecycle_pending_work'});
 expect((await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`,[t.org])).rows).toEqual(before);
 expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rows).toEqual([{id:t.channel}]);
 if(object)expect((await db.database.pool.query('SELECT reserved_bytes FROM media_private_objects WHERE id=$1',[object])).rows).toEqual([{reserved_bytes:1}]);
});
