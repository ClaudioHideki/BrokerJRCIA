import { randomUUID } from 'node:crypto';
import { copyFile,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect,it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { seedAttendanceTenant } from './helpers/attendance.js';
import { createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

it('upgrades 0041 additively without treating historical empty HANDOFF or UNKNOWN as remotely applied',async()=>{
  const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin),folder=await mkdtemp(join(tmpdir(),'native-handoff-upgrade-'));
  try {
    const migrations=resolve('apps/api/drizzle/migrations'),journal=JSON.parse(await readFile(join(migrations,'meta/_journal.json'),'utf8'));
    journal.entries=journal.entries.filter((entry:{idx:number})=>entry.idx<41);
    await mkdir(join(folder,'meta'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)await copyFile(join(migrations,`${entry.tag}.sql`),join(folder,`${entry.tag}.sql`));
    await withGlobalRoleLock(admin,async()=>{
      const client=await db.pool.connect();try{await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('SET ROLE jrc_migrator');
        await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
      }finally{await client.query('RESET ROLE');client.release();}
    });
    const t=await seedAttendanceTenant(db),binding=randomUUID(),execution=randomUUID(),outbox=randomUUID();
    await db.pool.query(`INSERT INTO automation_bindings(organization_id,id,automation_id,version,channel_id) VALUES($1,$2,$3,1,$4)`,[t.org,binding,t.automation,t.channel]);
    await db.pool.query(`INSERT INTO automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status)
      VALUES($1,$2,$3,1,$4,$5,$6,'synthetic',$7,'HANDOFF')`,[t.org,execution,t.automation,binding,t.channel,t.conversation,randomUUID()]);
    await db.pool.query(`INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,status,payload)
      VALUES($1,$2,$3,'handoff',0,'HANDOFF','UNKNOWN','{}')`,[t.org,outbox,execution]);
    const before=(await db.pool.query('SELECT * FROM automation_outbox WHERE organization_id=$1',[t.org])).rows;
    expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(false);
    await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
    expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(true);
    expect((await db.pool.query('SELECT * FROM automation_outbox WHERE organization_id=$1',[t.org])).rows).toEqual(before);
    expect((await db.pool.query('SELECT * FROM attendance_handoff_operations')).rows).toEqual([]);
    expect((await db.pool.query("SELECT table_name FROM lifecycle_purge_catalogue WHERE table_name='attendance_handoff_operations'")).rowCount).toBe(1);
    const purge=(await db.pool.query("SELECT pg_get_functiondef('lifecycle_purge_channel(uuid,uuid)'::regprocedure) AS body")).rows[0].body as string;
    expect(purge.indexOf('DELETE FROM public.attendance_handoff_operations')).toBeLessThan(purge.indexOf('DELETE FROM public.automation_outbox'));
  }finally{await db.dispose();await rm(folder,{recursive:true,force:true});}
},60000);
