import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { seedAttendanceTenant } from './helpers/attendance.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

it('upgrades 0033 preserving active versions, conversations and executions while backfilling owners', async () => {
  const admin = requireTestDatabaseAdminUrl(), db = await createIsolatedPostgresDatabase(admin);
  const scratch = resolve('.sessions'); await mkdir(scratch,{recursive:true});
  const folder = await mkdtemp(resolve(scratch,'attendance-upgrade-'));
  try {
    const migrations = resolve('apps/api/drizzle/migrations');
    const journal = JSON.parse(await readFile(resolve(migrations,'meta/_journal.json'),'utf8'));
    journal.entries = journal.entries.filter((entry:{idx:number})=>entry.idx<33);
    await mkdir(resolve(folder,'meta')); await writeFile(resolve(folder,'meta/_journal.json'),JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(resolve(migrations,`${entry.tag}.sql`),resolve(folder,`${entry.tag}.sql`));
    await withGlobalRoleLock(admin,async()=>{
      const client=await db.pool.connect();
      try { await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8')); await client.query('set role jrc_migrator');
        await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
      } finally { await client.query('reset role'); client.release(); }
    });
    const a=await seedAttendanceTenant(db);
    await db.pool.query(`update messaging_channels set bot_public_id=$2,bot_origin_reference='jrc-automation-v2' where id=$1`,[a.channel,a.automation]);
    const binding=(await db.pool.query(`insert into automation_bindings(organization_id,automation_id,version,channel_id,revision) values($1,$2,1,$3,4) returning id`,[a.org,a.automation,a.channel])).rows[0].id;
    await db.pool.query(`insert into automation_executions(organization_id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status,state)
      values($1,$2,1,$3,$4,$5,'test',$5,'WAITING','{"answer":"preserve"}')`,[a.org,a.automation,binding,a.channel,a.conversation]);
    const before=(await db.pool.query('select * from automation_executions')).rows;
    expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(false);
    await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
    expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(true);
    expect((await db.pool.query('select * from automation_executions')).rows).toEqual(before);
    expect((await db.pool.query('select executor,automation_id,version,revision,integration_id from attendance_owners')).rows)
      .toEqual([{executor:'BROKER',automation_id:a.automation,version:1,revision:4,integration_id:a.integration}]);
    expect((await db.pool.query('select * from automation_versions')).rows).toHaveLength(1);
    expect((await db.pool.query('select id from messaging_conversations')).rows).toEqual([{id:a.conversation}]);
    expect((await db.pool.query('select * from attendance_sessions')).rows).toEqual([]);
    for (const change of ['alter table attendance_owners no force row level security',
      'drop policy attendance_tenant on attendance_sessions',
      'alter table attendance_sessions drop constraint attendance_session_conversation_fk',
      'alter table attendance_sessions drop constraint attendance_session_execution_version_fk',
      'alter table attendance_sessions drop constraint attendance_session_execution_requires_version',
      'drop index attendance_one_live_conversation']) {
      const client=await db.pool.connect();
      try { await client.query('begin'); await client.query(change);
        expect.soft(await probeRequiredRuntimeSchema(sql=>client.query(sql)), change).toBe(false);
      } finally { await client.query('rollback'); client.release(); }
    }
  } finally {
    await db.dispose();
    if(!resolve(folder).startsWith(`${scratch}${sep}`))throw new Error('Unsafe scratch');
    await rm(folder,{recursive:true,force:true});
  }
},60000);
