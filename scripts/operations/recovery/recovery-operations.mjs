import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import pg from 'pg';
import {createClient} from 'redis';
import {createRecoveryBundle,verifyRecoveryBundle,restoreRecoveryObjects,planRedisRestore} from './recovery.mjs';
import {capturePostgresDump,restorePostgresDump,validateLabDatabase,assertEmptyPostgres} from './postgres-recovery.mjs';
import {captureRedisNamespace,restoreRedisNamespace} from './redis-recovery.mjs';

const fail=code=>{throw Error(code);};
export async function readRecoveryInventory(pool){
 const client=await pool.connect();
 try{
  await client.query('BEGIN READ ONLY');
  const rows=(await client.query(`SELECT o.*,p.state AS put_state,d.state AS delete_state FROM media_private_objects o
   JOIN media_private_operations p ON p.object_id=o.id AND p.kind='PUT'
   LEFT JOIN media_private_operations d ON d.object_id=o.id AND d.kind='DELETE' ORDER BY o.id`)).rows;
  const operations=(await client.query('SELECT * FROM media_private_operations ORDER BY id')).rows;
  const ledgerDigest=createHash('sha256').update(JSON.stringify({rows,operations})).digest('hex');
  return{ledgerDigest,objects:rows.map(o=>({ref:{organizationId:o.organization_id,channelId:o.channel_id,mediaId:o.media_id,operationId:o.id},expected:{byteLength:o.cipher_byte_length,sha256:o.cipher_sha256},state:o.state,putState:o.put_state,deleteState:o.delete_state??null}))};
 }finally{await client.query('ROLLBACK');client.release();}
}
function paused(value){if(['postgres','redis','objectStore','providers'].some(k=>value?.[k]!==true))fail('RECOVERY_WRITERS_NOT_PAUSED');}
function redisTarget(value){
 let url;try{url=new URL(value);}catch{fail('RECOVERY_LAB_REDIS_REQUIRED');}
 if(url.protocol!=='redis:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['','/0'].includes(url.pathname)||url.search||url.hash)fail('RECOVERY_LAB_REDIS_REQUIRED');return value;
}
function storageConfig(configuration){
 const config=configuration?.objectStore;let url;try{url=new URL(config?.endpoint);}catch{fail('RECOVERY_LAB_OBJECT_STORE_REQUIRED');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^broker-c5-[a-z0-9-]{1,64}$/.test(config?.bucket??'')||config.dedicatedBucket!==true||config.allowLoopbackHttpForTests!==true)fail('RECOVERY_LAB_OBJECT_STORE_REQUIRED');
 return config;
}
async function factory(parameters,injected){
 if(injected)return injected;
 const module=await import(pathToFileURL(resolve(parameters.objectStoreModule)).href);if(typeof module.createS3PrivateObjectStore!=='function')fail('RECOVERY_OBJECT_ADAPTER_INVALID');return module.createS3PrivateObjectStore;
}
async function globalRoleLock(databaseUrl,work){
 const url=new URL(databaseUrl);url.pathname='/postgres';const db=new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000});
 try{await db.connect();await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))",['jrc-test-global-roles']);return await work();}
 finally{await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",['jrc-test-global-roles']).catch(()=>{});await db.end();}
}
async function versionCheck(pool,redis,metadata){
 const postgres=(await pool.query('SHOW server_version')).rows[0].server_version.split(' ')[0];
 const version=(await redis.info('server')).match(/redis_version:([^\r\n]+)/)?.[1];
 if(postgres!==metadata.versions.postgres||version!==metadata.versions.redis)fail('RECOVERY_BACKEND_VERSION_MISMATCH');
}
async function redisEmpty(redis,snapshot){
 const t=await redis.sendCommand(['TIME']),redisNowMs=Number(t[0])*1000+Math.floor(Number(t[1])/1000);
 const plan=planRedisRestore(snapshot,{hostNowMs:Date.now(),redisNowMs});
 for(const item of plan)if(await redis.exists(item.key))fail('RECOVERY_REDIS_TARGET_NOT_EMPTY');
}
export async function runRecoveryOperation({mode,parameters,backupKey,objectStoreFactory}){
 if(!['capture','verify','restore'].includes(mode))fail('RECOVERY_CLI_PARAMETERS_INVALID');
 let snapshot;if(mode!=='capture'){
  snapshot=await verifyRecoveryBundle({directory:parameters.directory,backupKey,expectedBackendFingerprint:parameters.backendFingerprint});
  if(mode==='verify')return{scope:'ISOLATED_NAMESPACE',mode,passed:true,schema:snapshot.manifest.schema,objectCount:snapshot.manifest.objectCount,redisScope:snapshot.manifest.redisScope};
 }
 paused(parameters.quiescence);
 const databaseUrl=mode==='capture'?parameters.databaseUrl:parameters.targetDatabaseUrl;
 validateLabDatabase(databaseUrl);redisTarget(parameters.redisUrl);
 if(mode==='restore'&&!parameters.restoreJournalPath)fail('RECOVERY_CLI_PARAMETERS_INVALID');
 let configuration=snapshot?.privateConfiguration;
 if(mode==='capture'){
  const raw=await readFile(parameters.privateConfigurationFile,'utf8');if(raw.length>32768)fail('RECOVERY_LIMIT_EXCEEDED');configuration=JSON.parse(raw);
 }
 const config=storageConfig(configuration),createObjectStore=await factory(parameters,objectStoreFactory),objectStore=createObjectStore(config);
 const metadata=snapshot?.manifest??parameters.metadata;
 if(objectStore.destinationFingerprint!==metadata.backendFingerprint)fail('RECOVERY_BACKEND_MISMATCH');
 const pool=new pg.Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
 const redis=createClient({url:parameters.redisUrl,socket:{connectTimeout:5000,reconnectStrategy:false}});redis.on('error',()=>{});
 try{
  await redis.connect();await versionCheck(pool,redis,metadata);
  if(mode==='capture'){
   const manifest=await createRecoveryBundle({directory:parameters.directory,backupKey,metadata,privateConfiguration:configuration,quiescence:parameters.quiescence,
    readInventory:()=>readRecoveryInventory(pool),capturePostgres:()=>capturePostgresDump({databaseUrl,executable:parameters.pgDumpExecutable}),captureRedis:()=>captureRedisNamespace(redis,{namespace:parameters.redisNamespace}),objectStore});
   return{scope:'ISOLATED_NAMESPACE',mode,passed:true,schema:manifest.schema,objectCount:manifest.objectCount,redisScope:manifest.redisScope};
  }
  const result=await globalRoleLock(databaseUrl,async()=>{
   await assertEmptyPostgres(databaseUrl);await redisEmpty(redis,snapshot.redis);
   const objects=await restoreRecoveryObjects({snapshot,objectStore,journalPath:parameters.restoreJournalPath,backupKey});
   await restorePostgresDump({databaseUrl,executable:parameters.pgRestoreExecutable,dump:snapshot.postgres});
   if((await readRecoveryInventory(pool)).ledgerDigest!==snapshot.ledgerDigest)fail('RECOVERY_RESTORED_LEDGER_MISMATCH');
   const keys=await restoreRedisNamespace(redis,snapshot.redis);return{objects,redis:keys};
  });
  return{scope:'ISOLATED_NAMESPACE',mode,passed:true,schema:snapshot.manifest.schema,...result};
 }finally{if(redis.isOpen)await redis.quit();await pool.end();}
}
