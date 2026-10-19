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

it.each([65,66])('upgrades populated baseline %i to 0067 without changing existing history and requires durable ledger guards',async baseline=>{
  const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin),root=resolve(tmpdir());
  const folder=await mkdtemp(join(root,'history-ledger-upgrade-'));
  try{
    const source=resolve('apps/api/drizzle/migrations'),journal=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8'));
    journal.entries=journal.entries.filter((entry:{idx:number})=>entry.idx<baseline);
    expect(journal.entries.at(-1).tag).toBe(baseline===65?'0065_qr_identity_pending':'0066_physical_conversation_cycles');
    await mkdir(join(folder,'meta'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)await copyFile(join(source,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
    await withGlobalRoleLock(admin,async()=>{
      const client=await db.pool.connect();try{
        await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('SET ROLE jrc_migrator');
        await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
      }finally{await client.query('RESET ROLE');client.release();}
    });
    const tenant=await seedAttendanceTenant(db,false);
    await queryAsTenant(db.pool,'jrc_app',tenant.org,
      "INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state) VALUES($1,$2,$3,'INCOMING','CONTACT','existing-history','{\"type\":\"TEXT\",\"text\":\"Synthetic existing history\"}','DELIVERED')",[tenant.org,tenant.channel,tenant.conversation]);
    const snapshot=async()=>({channels:(await db.pool.query('SELECT * FROM messaging_channels ORDER BY id')).rows,
      contacts:(await db.pool.query('SELECT * FROM messaging_contacts ORDER BY id')).rows,
      conversations:(await db.pool.query('SELECT * FROM messaging_conversations ORDER BY id')).rows,messages:(await db.pool.query("SELECT to_jsonb(m)-'is_historical' AS original FROM messaging_messages m ORDER BY id")).rows});
    const before=await snapshot();
    expect(await probeRequiredRuntimeSchema(sql=>queryAsTenant(db.pool,'jrc_app',tenant.org,sql))).toBe(false);
    await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
    expect(await snapshot()).toEqual(before);
    expect(await probeRequiredRuntimeSchema(sql=>queryAsTenant(db.pool,'jrc_app',tenant.org,sql))).toBe(true);
    for(const table of ['history_import_jobs','history_import_pages','history_import_snapshots']){
      expect((await queryAsTenant(db.pool,'jrc_app',tenant.org,`SELECT * FROM ${table}`)).rows).toEqual([]);
      await expect(queryAsTenant(db.pool,'jrc_auth',tenant.org,`SELECT * FROM ${table}`)).rejects.toMatchObject({code:'42501'});
    }
    const client=await db.pool.connect();try{
      await client.query('BEGIN');await client.query('DROP TRIGGER history_import_job_guard ON history_import_jobs');
      await client.query('SET LOCAL ROLE jrc_app');
      expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
    }finally{await client.query('ROLLBACK');client.release();}
    const permissions=await db.pool.connect();try{
      await permissions.query('BEGIN');await permissions.query('REVOKE INSERT ON history_import_pages FROM jrc_app');
      await permissions.query('SET LOCAL ROLE jrc_app');
      expect(await probeRequiredRuntimeSchema(sql=>permissions.query(sql))).toBe(false);
    }finally{await permissions.query('ROLLBACK');permissions.release();}
    for(const mutation of [
      'ALTER TABLE history_import_jobs DROP COLUMN actor_id',
      'ALTER TABLE history_import_jobs DROP COLUMN next_attempt_at',
      'ALTER TABLE history_import_jobs DROP COLUMN last_error',
      'ALTER TABLE history_import_pages DROP COLUMN actor_id',
      'ALTER TABLE messaging_messages DROP COLUMN is_historical',
      'REVOKE EXECUTE ON FUNCTION history_import_expire_snapshots() FROM jrc_app',
      'GRANT EXECUTE ON FUNCTION history_import_expire_snapshots() TO PUBLIC',
    ]){
      const check=await db.pool.connect();try{
        await check.query('BEGIN');await check.query(mutation);await check.query('SET LOCAL ROLE jrc_app');
        expect(await probeRequiredRuntimeSchema(sql=>check.query(sql)),mutation).toBe(false);
      }finally{await check.query('ROLLBACK');check.release();}
    }
    const purge=(await db.pool.query("SELECT pg_get_functiondef('lifecycle_purge_channel(uuid,uuid)'::regprocedure) AS body")).rows[0].body as string;
    expect(purge.indexOf('DELETE FROM public.history_import_jobs')).toBeGreaterThan(-1);
    expect(purge.indexOf('DELETE FROM public.history_import_jobs')).toBeLessThan(purge.indexOf('DELETE FROM public.messaging_messages'));
  }finally{
    await db.dispose();const child=relative(root,resolve(folder));
    if(!child||child.startsWith('..')||isAbsolute(child))throw new Error('UNSAFE_TEST_SCRATCH_PATH');
    await rm(folder,{recursive:true,force:true});
  }
},60000);
