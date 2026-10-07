import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {expect,it} from 'vitest';
import {runMigrations} from '../../src/db/migrate.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';

it('upgrades D2 preserving physical UNKNOWN receipts and central events without claiming delivery',async()=>{
 const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin),root=resolve(tmpdir()),folder=await mkdtemp(join(root,'jrc-d3-upgrade-'));
 try {
  const source=resolve('apps/api/drizzle/migrations'),journal=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8'));
  journal.entries=journal.entries.filter((entry:{idx:number})=>entry.idx<46);
  await mkdir(join(folder,'meta'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));
  for(const entry of journal.entries)await copyFile(join(source,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
  await withGlobalRoleLock(admin,async()=>{
   const client=await db.pool.connect();try{
    await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('SET ROLE jrc_migrator');
    await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
   }finally{await client.query('RESET ROLE');client.release();}
  });
  const t=await seedAttendanceTenant(db),message=randomUUID(),job=randomUUID(),receipt=randomUUID(),lease=randomUUID();
  await db.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
   VALUES($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic"}','UNKNOWN',$1::text,$5)`,[message,t.org,t.channel,t.conversation,'a'.repeat(64)]);
  await db.pool.query(`INSERT INTO integration_jobs(id,organization_id,integration_id,kind,dedupe_key,message_id,status)
   VALUES($1::uuid,$2,$3,'MIRROR_MESSAGE',$1::text,$4,'UNKNOWN')`,[job,t.org,t.integration,message]);
  await db.pool.query(`INSERT INTO chatwoot_mirror_attempts(id,organization_id,channel_id,integration_id,destination_revision,account_id,inbox_id,conversation_id,
   remote_conversation_id,cycle,message_id,job_id,lease_token,state) VALUES($1,$2,$3,$4,1,7,9,$5,51,1,$6,$7,$8,'UNKNOWN')`,[receipt,t.org,t.channel,t.integration,t.conversation,message,job,lease]);
  const centralChannel=randomUUID(),centralIntegration=randomUUID(),event=randomUUID();
  await db.pool.query("INSERT INTO messaging_channels(id,organization_id,transport,provider,provider_account_id,credential_reference) VALUES($1,$2,'CENTRAL_TRANSPORT',NULL,NULL,NULL)",[centralChannel,t.org]);
  await db.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,10,'Synthetic central','READY')",[centralIntegration,t.org,centralChannel]);
  await db.pool.query(`INSERT INTO central_transport_bindings(organization_id,channel_id,integration_id,origin,account_id,inbox_id,destination_revision,credential_version,owner_revision)
   VALUES($1,$2,$3,$4,7,10,1,1,0)`,[t.org,centralChannel,centralIntegration,`https://${t.org}.example.test`]);
  await db.pool.query(`INSERT INTO central_runtime_events(id,organization_id,channel_id,integration_id,event_key,kind,destination_revision,credential_version,owner_revision,remote_conversation_id,remote_message_id)
   VALUES($1,$2,$3,$4,'message:61','CONTACT_TEXT',1,1,0,51,61)`,[event,t.org,centralChannel,centralIntegration]);
  const beforeReceipt=(await db.pool.query('SELECT * FROM chatwoot_mirror_attempts WHERE id=$1',[receipt])).rows[0];
  const beforeEvent=(await db.pool.query('SELECT * FROM central_runtime_events WHERE id=$1',[event])).rows[0];
  const beforeBinding=(await db.pool.query('SELECT * FROM central_transport_bindings')).rows;
  expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(false);
  await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
  expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(true);
  const afterReceipt=(await db.pool.query('SELECT * FROM chatwoot_mirror_attempts WHERE id=$1',[receipt])).rows[0];
  expect(afterReceipt).toMatchObject({...beforeReceipt,transport:'BROKER_TRANSPORT',dispatch_proof:null,sender_id:null,ack_message_id:null});
  expect((await db.pool.query('SELECT * FROM central_runtime_events WHERE id=$1',[event])).rows[0]).toMatchObject({...beforeEvent,attempts:0,lease_token:null});
  expect((await db.pool.query('SELECT * FROM central_transport_bindings')).rows).toEqual(beforeBinding);
  expect((await db.pool.query('SELECT state FROM messaging_messages WHERE id=$1',[message])).rows).toEqual([{state:'UNKNOWN'}]);
 }finally{
  await db.dispose();const rel=relative(root,resolve(folder));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('INVALID_SCRATCH_PATH');
  await rm(folder,{recursive:true,force:true});
 }
},60000);
