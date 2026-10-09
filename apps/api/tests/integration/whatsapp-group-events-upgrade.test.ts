import {expect,it} from 'vitest';
import {readFile,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {connectionStringForRole} from './helpers/task7.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
it('requires the additive 0051 G2 upgrade after 0050 and preserves the physical QR catalog and lifecycle purge',async()=>{
  const admin=requireTestDatabaseAdminUrl(),database=await createIsolatedPostgresDatabase(admin);
  const scratch=resolve('.sessions/g2-upgrade-scratch'),folder=join(scratch,randomUUID());
  let appPool:Pool|undefined;
  try{
    const source=resolve('apps/api/drizzle/migrations'),full=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8'));
    const entries=full.entries.filter((entry:{idx:number})=>entry.idx<=49);
    expect(entries.at(-1).tag).toBe('0050_whatsapp_group_catalog');
    await mkdir(join(folder,'meta'),{recursive:true});await writeFile(join(folder,'meta/_journal.json'),JSON.stringify({...full,entries}));
    for(const entry of entries)await copyFile(join(source,`${entry.tag}.sql`),join(folder,`${entry.tag}.sql`));
    await withGlobalRoleLock(admin,async()=>{
      const connection=await database.pool.connect();
      try{await connection.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await connection.query('SET ROLE jrc_migrator');
        await migrate(drizzle(connection),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
      }finally{await connection.query('RESET ROLE');connection.release();}
    });
    appPool=new Pool({connectionString:connectionStringForRole(database.connectionString,'jrc_app')});
    const db={database,transact:<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(appPool!,org,work)};
    const tenant=await seedAttendanceTenant(db.database,false),instance=randomUUID(),snapshot=randomUUID();
    await db.database.pool.query(`UPDATE provider_accounts SET provider='BAILEYS' WHERE id=(SELECT provider_account_id FROM messaging_channels WHERE id=$1)`,[tenant.channel]);
    await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
      SELECT $2,$3,provider_account_id,'Synthetic upgrade',$4,'CONNECTED' FROM messaging_channels WHERE id=$1`,[tenant.channel,instance,tenant.org,`synthetic-${instance}`]);
    await db.database.pool.query(`UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1`,[tenant.channel,instance]);
    await db.database.pool.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id,identity_fingerprint,catalog_revision,snapshot_id,observed_at,valid_until)
      VALUES($1,$2,$3,3,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[tenant.org,tenant.channel,'a'.repeat(64),snapshot]);
    await db.database.pool.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count,selected)
      VALUES($1,$2,'10000@g.us','Synthetic preserved group',3,true)`,[tenant.org,tenant.channel]);
    const before=(await db.database.pool.query('SELECT * FROM whatsapp_group_catalogs WHERE channel_id=$1',[tenant.channel])).rows[0];
    const ready=()=>db.transact(tenant.org,tx=>probeRequiredRuntimeSchema(sql=>tx.query(sql)));
    expect(await ready()).toBe(false);
    const migration=await db.database.pool.connect();
    try{
      await migration.query('SET ROLE jrc_migrator');
      await migration.query(await readFile('apps/api/drizzle/migrations/0051_whatsapp_group_events.sql','utf8'));
    }finally{await migration.query('RESET ROLE');migration.release();}
    // G2 is installed, but the current runtime also requires the additive C2 schema.
    expect(await ready()).toBe(false);
    const privateMediaMigration=await db.database.pool.connect();
    try{
      await privateMediaMigration.query('SET ROLE jrc_migrator');
      await privateMediaMigration.query(await readFile('apps/api/drizzle/migrations/0052_durable_private_media.sql','utf8'));
    }finally{await privateMediaMigration.query('RESET ROLE');privateMediaMigration.release();}
    expect(await ready()).toBe(true);
    expect((await db.database.pool.query('SELECT * FROM whatsapp_group_catalogs WHERE channel_id=$1',[tenant.channel])).rows[0]).toEqual(before);
    expect((await db.database.pool.query('SELECT selected FROM whatsapp_group_catalog_items WHERE channel_id=$1',[tenant.channel])).rows[0]?.selected).toBe(true);
    const purge=(await db.database.pool.query("SELECT pg_get_functiondef('lifecycle_purge_channel(uuid,uuid)'::regprocedure) AS body")).rows[0].body;
    expect(purge).toContain('DELETE FROM public.whatsapp_group_webhook_operations');
    expect(purge).toContain('lifecycle_validate_purge');
  }finally{await appPool?.end();await database.dispose();
    if(dirname(folder)!==scratch)throw new Error('UNSAFE_UPGRADE_SCRATCH');await rm(folder,{recursive:true,force:true});}
});
