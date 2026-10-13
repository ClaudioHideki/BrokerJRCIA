import {randomUUID} from 'node:crypto';
import {readFile,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl} from './postgres.js';
import {withGlobalRoleLock} from './global-role-lock.js';
import {connectionStringForRole} from './task7.js';
import {withOrganizationTransaction,type OrganizationTransaction} from '../../../src/db/tenant-transaction.js';
/** Deliberate historical 0052 baseline. Tests apply the real additive 0053 SQL,
 * rather than rerunning it after the production migrator already installed it. */
export async function attendanceDatabaseBeforeFlow(){
 const admin=requireTestDatabaseAdminUrl(),database=await createIsolatedPostgresDatabase(admin),scratch=resolve('.test-artifacts/p9-test-migrations'),folder=join(scratch,randomUUID());let appPool:Pool|undefined;
 try{
  const source=resolve('apps/api/drizzle/migrations'),full=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8')),entries=full.entries.filter((entry:{tag:string})=>Number(entry.tag.slice(0,4))<53);
  if(entries.at(-1)?.tag!=='0052_durable_private_media')throw new Error('P9_TEST_REQUIRES_CANONICAL_0052');
  await mkdir(join(folder,'meta'),{recursive:true});await writeFile(join(folder,'meta/_journal.json'),JSON.stringify({...full,entries}));for(const entry of entries)await copyFile(join(source,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
  await withGlobalRoleLock(admin,async()=>{const c=await database.pool.connect();try{await c.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await c.query('SET ROLE jrc_migrator');await migrate(drizzle(c),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});}finally{await c.query('RESET ROLE');c.release();}});
  appPool=new Pool({connectionString:connectionStringForRole(database.connectionString,'jrc_app')});const pool=appPool;
  return {database,transact:<T>(org:string,work:OrganizationTransaction<T>)=>withOrganizationTransaction(pool,org,work),dispose:async()=>{await pool.end();await database.dispose();}};
 }catch(error){await appPool?.end();await database.dispose();throw error;}finally{if(dirname(folder)!==scratch)throw new Error('UNSAFE_P9_TEST_SCRATCH');await rm(folder,{recursive:true,force:true});}
}
