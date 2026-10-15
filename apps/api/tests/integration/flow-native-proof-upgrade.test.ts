import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {expect,it} from 'vitest';
import {FLOW_GUARDED_PATHS} from '@jrc/contracts';
import {runMigrations} from '../../src/db/migrate.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';

it('upgrades 0063 native drain proofs to 19 guarded paths without rewriting active bindings or stock proof',async()=>{
 const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin),folder=await mkdtemp(join(tmpdir(),'flow-native-proof-'));
 try{
  const source=resolve('apps/api/drizzle/migrations'),journal=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8'));
  journal.entries=journal.entries.filter((entry:{idx:number})=>entry.idx<63);
  await mkdir(join(folder,'meta'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));
  for(const entry of journal.entries)await copyFile(join(source,`${entry.tag}.sql`),join(folder,`${entry.tag}.sql`));
  await withGlobalRoleLock(admin,async()=>{
   const client=await db.pool.connect();try{
    await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('SET ROLE jrc_migrator');
    await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
   }finally{await client.query('RESET ROLE');client.release();}
  });
  const oldPaths=FLOW_GUARDED_PATHS.slice(0,11),drained=await seedAttendanceTenant(db),active=await seedAttendanceTenant(db),stock=await seedAttendanceTenant(db);
  const binding=(await db.pool.query(`INSERT INTO automation_bindings(organization_id,automation_id,version,channel_id)
   VALUES($1,$2,1,$3) RETURNING *`,[active.org,active.automation,active.channel])).rows[0];
  for(const [tenant,phase,kind] of [[drained,'DRAINED','JRC_NATIVE'],[active,'ACTIVATED','JRC_NATIVE'],[stock,'DRAINED','STOCK']] as const){
   await db.pool.query(`INSERT INTO flow_executor_cutovers(organization_id,integration_id,channel_id,host_kind,profile_revision,
    origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,expected_owner_revision,phase,
    admission_closed,fence_dispatched_at,host_fence_revision,live_runs,legacy_jobs,uncertain_effects,guarded_paths,
    host_source_sha,host_image_digest,proof_observed_at,proof_valid_until,qr_identity_revision,qr_identity_fingerprint,
    activated_owner_revision,binding_id,automation_id)
    VALUES($1,$2,$3,$4,1,1,7,9,1,1,0,$5,true,CASE WHEN $4='JRC_NATIVE' THEN now() ELSE NULL END,1,0,0,0,$6,
     $7,$8,now(),now()+interval '30 seconds',1,$7,$9,$10,$11)`,
    [tenant.org,tenant.integration,tenant.channel,kind,phase,oldPaths,'a'.repeat(40),'sha256:'+'b'.repeat(64),
     phase==='ACTIVATED'?1:null,phase==='ACTIVATED'?binding.id:null,phase==='ACTIVATED'?active.automation:null]);
  }
  const historical=(await db.pool.query('SELECT * FROM flow_executor_cutovers WHERE organization_id IN ($1,$2) ORDER BY organization_id',[active.org,stock.org])).rows;
  expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(false);
  await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
  expect(await probeRequiredRuntimeSchema(sql=>db.pool.query(sql))).toBe(true);
  expect((await db.pool.query('SELECT phase,proof_valid_until,lease_token,guarded_paths FROM flow_executor_cutovers WHERE organization_id=$1',[drained.org])).rows)
   .toEqual([{phase:'UNKNOWN',proof_valid_until:null,lease_token:null,guarded_paths:oldPaths}]);
  expect((await db.pool.query('SELECT * FROM flow_executor_cutovers WHERE organization_id IN ($1,$2) ORDER BY organization_id',[active.org,stock.org])).rows).toEqual(historical);
  expect((await db.pool.query('SELECT * FROM automation_bindings WHERE organization_id=$1',[active.org])).rows).toEqual([binding]);
  const promote=`UPDATE flow_executor_cutovers SET phase='DRAINED',guarded_paths=$2,proof_observed_at=now(),proof_valid_until=now()+interval '30 seconds' WHERE organization_id=$1`;
  await expect(db.pool.query(promote,[drained.org,oldPaths])).rejects.toMatchObject({code:'23514'});
  await expect(db.pool.query(promote,[drained.org,[...FLOW_GUARDED_PATHS]])).resolves.toMatchObject({rowCount:1});
  const client=await db.pool.connect();try{
   await client.query('BEGIN');await client.query('ALTER TABLE flow_executor_cutovers DROP CONSTRAINT flow_executor_cutovers_drain_proof');
   expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
   await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK');client.release();}
 }finally{await db.dispose();await rm(folder,{recursive:true,force:true});}
},60000);
