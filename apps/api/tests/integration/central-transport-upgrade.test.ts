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

it('upgrades 0045 without changing physical channels, conversations, credentials or owners',async()=>{
 const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin);
 const scratch=resolve(tmpdir()),folder=await mkdtemp(join(scratch,'jrc-d2-upgrade-'));
 try{
  const source=resolve('apps/api/drizzle/migrations'),journal=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8'));
  journal.entries=journal.entries.filter((entry:{idx:number})=>entry.idx<45);
  await mkdir(join(folder,'meta'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));
  for(const entry of journal.entries)await copyFile(join(source,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
  await withGlobalRoleLock(admin,async()=>{const client=await db.pool.connect();
   try{await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('SET ROLE jrc_migrator');
    await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
   }finally{await client.query('RESET ROLE');client.release();}
  });
  const t=await seedAttendanceTenant(db);
  const channel=(await db.pool.query('SELECT * FROM messaging_channels WHERE id=$1',[t.channel])).rows[0];
  const conversation=(await db.pool.query('SELECT * FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0];
  expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(false);
  await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
  expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(true);
  expect((await db.pool.query('SELECT * FROM messaging_channels WHERE id=$1',[t.channel])).rows).toEqual([{...channel,transport:'BROKER_TRANSPORT'}]);
  expect((await db.pool.query('SELECT * FROM messaging_conversations WHERE id=$1',[t.conversation])).rows).toEqual([{...conversation,remote_conversation_key:null}]);
  expect((await db.pool.query('SELECT * FROM central_transport_bindings')).rows).toEqual([]);
  expect((await db.pool.query('SELECT * FROM central_runtime_events')).rows).toEqual([]);
  expect((await db.pool.query("SELECT table_name FROM lifecycle_purge_catalogue WHERE table_name IN ('central_runtime_events','central_transport_bindings') ORDER BY table_name")).rows)
   .toEqual([{table_name:'central_runtime_events'},{table_name:'central_transport_bindings'}]);
  const body=(await db.pool.query("SELECT pg_get_functiondef('lifecycle_purge_channel(uuid,uuid)'::regprocedure) AS body")).rows[0].body as string;
  expect(body.indexOf('DELETE FROM public.central_runtime_events')).toBeLessThan(body.indexOf('DELETE FROM public.central_transport_bindings'));
  expect(body.indexOf('DELETE FROM public.central_transport_bindings')).toBeLessThan(body.indexOf('DELETE FROM public.chatwoot_connections'));
 }finally{
  await db.dispose();const rel=relative(scratch,resolve(folder));
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('INVALID_SCRATCH_PATH');
  await rm(folder,{recursive:true,force:true});
 }
},60000);
