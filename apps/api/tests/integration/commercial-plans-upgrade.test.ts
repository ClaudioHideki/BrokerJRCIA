import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

it('upgrades legacy labels and individual capacity without changing modules, then checks readiness and purge registration',async()=>{
 const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin),scratch=resolve('.sessions');
 await mkdir(scratch,{recursive:true});const folder=await mkdtemp(resolve(scratch,'commercial-upgrade-'));
 try{
  const migrations=resolve('apps/api/drizzle/migrations'),journal=JSON.parse(await readFile(resolve(migrations,'meta/_journal.json'),'utf8'));
  journal.entries=journal.entries.filter((entry:{idx:number})=>entry.idx<35);
  await mkdir(resolve(folder,'meta'));await writeFile(resolve(folder,'meta/_journal.json'),JSON.stringify(journal));
  for(const entry of journal.entries)await copyFile(resolve(migrations,`${entry.tag}.sql`),resolve(folder,`${entry.tag}.sql`));
  await withGlobalRoleLock(admin,async()=>{
   const c=await db.pool.connect();try{await c.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await c.query('SET ROLE jrc_migrator');await migrate(drizzle(c),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});}finally{await c.query('RESET ROLE');c.release();}
  });
  const org=randomUUID(),user=randomUUID();const c=await db.pool.connect();
  try{await c.query('BEGIN');await c.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1::uuid,'Legacy fixture',$1::text,'Individually negotiated')",[org]);
   await c.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')",[user,`${user}@example.test`]);
   await c.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,user]);await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  await db.pool.query('UPDATE organization_limits SET max_instances=37,max_users=23,messages_per_day=915,max_pending_messages=61 WHERE organization_id=$1',[org]);
  await db.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[org]);
  const limits=(await db.pool.query('SELECT * FROM organization_limits WHERE organization_id=$1',[org])).rows;
  const features=(await db.pool.query('SELECT * FROM flow_features WHERE organization_id=$1',[org])).rows;
  await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
  expect((await db.pool.query('SELECT * FROM organization_limits WHERE organization_id=$1',[org])).rows).toEqual(limits);
  expect((await db.pool.query('SELECT * FROM flow_features WHERE organization_id=$1',[org])).rows).toEqual(features);
  expect((await db.pool.query(`SELECT v.name,v.limits,v.flows_enabled,a.overrides,a.revision FROM organization_commercial_plans a JOIN commercial_plan_versions v ON v.id=a.plan_version_id WHERE a.organization_id=$1`,[org])).rows).toEqual([{name:'Individually negotiated',limits:{maxInstances:37,maxUsers:23,messagesPerDay:915,maxPendingMessages:61},flows_enabled:true,overrides:{},revision:1}]);
  expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(true);
  expect((await db.pool.query("SELECT table_name FROM lifecycle_purge_catalogue WHERE table_name='organization_commercial_plans'")).rows).toHaveLength(1);
  const check=await db.pool.connect();try{await check.query('BEGIN');await check.query('ALTER TABLE organization_commercial_plans NO FORCE ROW LEVEL SECURITY');expect(await probeRequiredRuntimeSchema(sql=>check.query(sql))).toBe(false);}finally{await check.query('ROLLBACK');check.release();}
 }finally{
  await db.dispose();if(!resolve(folder).startsWith(`${scratch}${sep}`))throw new Error('Unsafe scratch');await rm(folder,{recursive:true,force:true});
 }
},60000);
