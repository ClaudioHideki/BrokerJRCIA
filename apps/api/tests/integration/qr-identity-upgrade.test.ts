import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {expect,it} from 'vitest';
import {runMigrations} from '../../src/db/migrate.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {createIsolatedPostgresDatabase,queryAsTenant,requireTestDatabaseAdminUrl} from './helpers/postgres.js';

it('upgrades populated 0064 additively and requires QR identity RLS and lifecycle protection for readiness',async()=>{
  const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin),root=resolve(tmpdir());
  const folder=await mkdtemp(join(root,'qr-identity-upgrade-'));
  try{
    const source=resolve('apps/api/drizzle/migrations'),journal=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8'));
    journal.entries=journal.entries.filter((entry:{idx:number})=>entry.idx<64);
    expect(journal.entries.at(-1).tag).toBe('0064_native_flow_guard_coverage');
    await mkdir(join(folder,'meta'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)await copyFile(join(source,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
    await withGlobalRoleLock(admin,async()=>{
      const client=await db.pool.connect();try{
        await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('SET ROLE jrc_migrator');
        await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
      }finally{await client.query('RESET ROLE');client.release();}
    });
    const tenant=await seedAttendanceTenant(db,false);
    const snapshot=async()=>({channels:(await db.pool.query('SELECT * FROM messaging_channels ORDER BY id')).rows,
      contacts:(await db.pool.query('SELECT * FROM messaging_contacts ORDER BY id')).rows,
      conversations:(await db.pool.query('SELECT * FROM messaging_conversations ORDER BY id')).rows});
    const before=await snapshot();
    expect(await probeRequiredRuntimeSchema(sql=>queryAsTenant(db.pool,'jrc_app',tenant.org,sql))).toBe(false);
    await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
    expect(await snapshot()).toEqual(before);
    expect(await probeRequiredRuntimeSchema(sql=>queryAsTenant(db.pool,'jrc_app',tenant.org,sql))).toBe(true);
    for(const table of ['qr_identity_scopes','qr_contact_aliases','qr_identity_pending_events']){
      expect((await queryAsTenant(db.pool,'jrc_app',tenant.org,`SELECT * FROM ${table}`)).rows).toEqual([]);
      await expect(queryAsTenant(db.pool,'jrc_auth',tenant.org,`SELECT * FROM ${table}`)).rejects.toMatchObject({code:'42501'});
    }
    const client=await db.pool.connect();try{
      await client.query('BEGIN');await client.query('DROP TRIGGER qr_identity_channel_admission ON qr_identity_pending_events');
      await client.query('SET LOCAL ROLE jrc_app');
      expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
    }finally{await client.query('ROLLBACK');client.release();}
    const permissions=await db.pool.connect();try{
      await permissions.query('BEGIN');await permissions.query('REVOKE INSERT ON qr_identity_pending_events FROM jrc_app');
      await permissions.query('SET LOCAL ROLE jrc_app');
      expect(await probeRequiredRuntimeSchema(sql=>permissions.query(sql))).toBe(false);
    }finally{await permissions.query('ROLLBACK');permissions.release();}
    const purge=(await db.pool.query("SELECT pg_get_functiondef('lifecycle_purge_channel(uuid,uuid)'::regprocedure) AS body")).rows[0].body as string;
    expect(purge.indexOf('DELETE FROM public.qr_identity_pending_events')).toBeGreaterThan(-1);
    expect(purge.indexOf('DELETE FROM public.qr_identity_pending_events')).toBeLessThan(purge.indexOf('DELETE FROM public.messaging_messages'));
  }finally{
    await db.dispose();const child=relative(root,resolve(folder));
    if(!child||child.startsWith('..')||isAbsolute(child))throw new Error('UNSAFE_TEST_SCRATCH_PATH');
    await rm(folder,{recursive:true,force:true});
  }
},60000);
