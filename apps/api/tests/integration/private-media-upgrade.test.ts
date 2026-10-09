import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {runMigrations} from '../../src/db/migrate.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {connectionStringForRole} from './helpers/task7.js';

it('upgrades populated 0051 to registered 0052 preserving every historical inline field, plaintext hash and migration receipt',async()=>{
 const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin),folder=await mkdtemp(join(tmpdir(),'jrc-private-media-upgrade-'));
 let app:Pool|undefined;
 try{
  const source=fileURLToPath(new URL('../../drizzle/migrations/',import.meta.url)),journal=JSON.parse(await readFile(join(source,'meta/_journal.json'),'utf8'));
  const final=journal.entries.at(-1);expect(journal.entries).toHaveLength(52);expect(final.tag).toBe('0052_durable_private_media');expect(final.idx).toBe(51);
  const previous={...journal,entries:journal.entries.slice(0,-1)};expect(previous.entries.at(-1).tag).toBe('0051_whatsapp_group_events');
  await mkdir(join(folder,'meta'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(previous));
  for(const entry of previous.entries)await copyFile(join(source,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
  await withGlobalRoleLock(admin,async()=>{
   const client=await db.pool.connect();try{await client.query(await readFile(fileURLToPath(new URL('../../../../infra/app/postgres/init-roles.sql',import.meta.url)),'utf8'));
    await client.query('SET ROLE jrc_migrator');await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
   }finally{await client.query('RESET ROLE');client.release();}
  });
  app=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app'),max:1});
  const probe=()=>probeRequiredRuntimeSchema(sql=>app!.query(sql));expect(await probe()).toBe(false);
  const a=await seedAttendanceTenant(db,false),b=await seedAttendanceTenant(db,false),key=Buffer.alloc(32,7).toString('base64'),vault=createIntegrationSecrets(key);
  const ids:string[]=[];
  for(const t of [a,b])for(const state of ['READY','PENDING','FAILED','DOWNLOADING']){
   const id=randomUUID(),plain=Buffer.from('synthetic historical '+id),lease=state==='DOWNLOADING'?randomUUID():null;ids.push(id);
   await db.pool.query(`INSERT INTO messaging_media(id,organization_id,channel_id,source,source_key,kind,file_name,mime_type,descriptor,status,encrypted_data,byte_size,sha256,attempts,lease_token,lease_expires_at,last_error)
    VALUES($1,$2,$3,'META',$1::uuid::text,'document','synthetic.pdf','application/pdf','{"mediaId":"11111"}',$4,$5,$6,$7,2,$8,$9,$10)`,
    [id,t.org,t.channel,state,state==='READY'?vault.encrypt(`${t.org}:media:${id}`,plain.toString('base64')):null,state==='READY'?plain.length:null,state==='READY'?createHash('sha256').update(plain).digest('hex'):null,lease,lease?new Date(Date.now()+60000):null,state==='FAILED'?'MEDIA_DOWNLOAD_FAILED':null]);
  }
  const snapshot=async()=>(await db.pool.query('SELECT * FROM messaging_media ORDER BY id')).rows,before=await snapshot();
  const receipts=async()=>(await db.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows,old=await receipts();expect(old).toHaveLength(51);
  await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));expect(await probe()).toBe(true);
  const after=await snapshot();expect(after).toEqual(before.map(row=>({...row,storage_backend:'INLINE_V1',private_object_id:null})));
  const current=await receipts();expect(current).toHaveLength(52);expect(current.slice(0,51)).toEqual(old);
  expect(current[51]).toMatchObject({hash:createHash('sha256').update(await readFile(join(source,final.tag+'.sql'),'utf8')).digest('hex'),created_at:String(final.when)});
  await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));expect(await receipts()).toEqual(current);expect(await snapshot()).toEqual(after);
  const media=createMediaStore({encryptionKey:key,transact:(org,work)=>withOrganizationTransaction(app!,org,work),download:async()=>{throw Error('No historical download');}});
  for(const row of before.filter(row=>row.status==='READY'))expect(await media.read(row.organization_id,row.id)).toMatchObject({bytes:new Uint8Array(Buffer.from('synthetic historical '+row.id))});
  await expect(media.read(a.org,before.find(row=>row.organization_id===b.org&&row.status==='READY')!.id)).rejects.toMatchObject({code:'MEDIA_NOT_FOUND'});
  expect((await db.pool.query('SELECT * FROM media_private_objects')).rows).toEqual([]);expect((await db.pool.query('SELECT * FROM media_private_operations')).rows).toEqual([]);
 }finally{await app?.end();await db.dispose();const within=relative(tmpdir(),folder);if(!within||within.startsWith('..')||isAbsolute(within)||!within.startsWith('jrc-private-media-upgrade-'))throw Error('UNSAFE_UPGRADE_TMP_CLEANUP');await rm(folder,{recursive:true,force:true});}
});
