import {createHash,createHmac,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {requireStorageEnvironment} from '../storage/environment.js';
import {attendanceDatabase,seedAttendanceTenant} from '../integration/helpers/attendance.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl} from '../integration/helpers/postgres.js';
import {withGlobalRoleLock} from '../integration/helpers/global-role-lock.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {withLifecycleWorkerTransaction} from '../../src/modules/lifecycle/service.js';
import {registerPendingMedia,createMediaStore} from '../../src/modules/messaging/media-store.js';
import {createDurablePrivateMediaStore} from '../../src/modules/messaging/durable-private-media.js';
import {createS3PrivateObjectStore,type PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';
import {probeRequiredRuntimeSchema,RUNTIME_SCHEMA_BASELINE} from '../../src/db/runtime-schema.js';
import {createRecoveryBundle,verifyRecoveryBundle,restoreRecoveryObjects} from '../../../../scripts/operations/recovery/recovery.mjs';
import {capturePostgresDump,restorePostgresDump} from '../../../../scripts/operations/recovery/postgres-recovery.mjs';
import {captureRedisNamespace,restoreRedisNamespace} from '../../../../scripts/operations/recovery/redis-recovery.mjs';
import {runRecoveryOperation} from '../../../../scripts/operations/recovery/recovery-operations.mjs';

const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const folder=resolve('.sessions/recovery-lab'),suffix=randomUUID().replaceAll('-','').slice(0,16);
const namespace=`broker-c5-${suffix}:`,bucket=`broker-c5-${suffix}`,profile='broker-c5-v1';
const storage=requireStorageEnvironment(),endpoint=storage.endpoint;
const required=(name:string)=>{const value=process.env[name];if(!value||value!==value.trim()||value.length>2048)throw Error('RECOVERY_TEST_ENV_REQUIRED:'+name);return value;};
const redisUrl=required('TEST_REDIS_URL'),pgDumpExecutable=required('TEST_RECOVERY_PG_DUMP_EXECUTABLE'),pgRestoreExecutable=required('TEST_RECOVERY_PG_RESTORE_EXECUTABLE');
const encryptionKey=Buffer.alloc(32,9).toString('base64'),backupKey=Buffer.alloc(32,11).toString('base64');
const file={bytes:new Uint8Array(Buffer.from('C5 private synthetic document')),kind:'document' as const,mimeType:'application/pdf',fileName:'synthetic-c5.pdf'};
let db:Awaited<ReturnType<typeof attendanceDatabase>>,destination:Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
let redis:ReturnType<typeof createClient>,life:Pool,platform:Pool,restoredApp:Pool,restoredLife:Pool,credentials:{access:string;secret:string;binarySha256:string},real:PrivateObjectStore;
const tRows:Array<{org:string;channel:string;conversation:string;instance:string;actor:string;media:string;objectId:string}>=[];
const http:Array<{phase:string;method:string;status:number}>=[];let phase='SEED';
const observations:Array<{phase:string;outcome:string;code?:string}>=[];

function rolePool(connectionString:string,role:string){const u=new URL(connectionString);u.username=role;u.password='';return new Pool({connectionString:u.href,max:1});}
function adapter(){const store=createS3PrivateObjectStore({endpoint,bucket,profile,region:'us-east-1',accessKeyId:credentials.access,secretAccessKey:credentials.secret,dedicatedBucket:true,allowLoopbackHttpForTests:true,requestTimeoutMs:5000,
 fetch:async(input,init)=>{try{const response=await fetch(input,init);http.push({phase,method:init?.method??'GET',status:response.status});return response;}catch(error){http.push({phase,method:init?.method??'GET',status:0});throw error;}}});
 return{...store,read:async(...args:Parameters<PrivateObjectStore['read']>)=>{const result=await store.read(...args);observations.push({phase,outcome:result.outcome,...('code'in result?{code:result.code}:{})});return result;}};}
function core(transact:typeof db.transact,cleanupPool=life,objectStore=real){return createDurablePrivateMediaStore({transact,cleanupTransact:<T>(work:Parameters<typeof withLifecycleWorkerTransaction<T>>[1])=>withLifecycleWorkerTransaction(cleanupPool,work),objectStore,profile,encryptionKey,maxStorageBytes:1024,requestTimeoutMs:5000});}
async function createBucket(){
 const u=new URL('/'+bucket,endpoint),date=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),payload=hash(''),scope=`${day}/us-east-1/s3/aws4_request`;
 const canonical=['PUT',u.pathname,'',`host:${u.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`,'host;x-amz-content-sha256;x-amz-date',payload].join('\n');
 const h=(key:Uint8Array|string,v:string)=>createHmac('sha256',key).update(v).digest();
 const signing=h(h(h(h(`AWS4${credentials.secret}`,day),'us-east-1'),'s3'),'aws4_request');
 const signature=createHmac('sha256',signing).update(['AWS4-HMAC-SHA256',date,scope,hash(canonical)].join('\n')).digest('hex');
 const response=await fetch(u,{method:'PUT',headers:{'x-amz-date':date,'x-amz-content-sha256':payload,authorization:`AWS4-HMAC-SHA256 Credential=${credentials.access}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`},signal:AbortSignal.timeout(5000)});
 expect(response.status).toBe(200);await response.body?.cancel();
}
async function inventory(pool:Pool){
 const rows=(await pool.query(`SELECT o.*,p.state AS put_state,d.state AS delete_state FROM media_private_objects o
  JOIN media_private_operations p ON p.object_id=o.id AND p.kind='PUT' LEFT JOIN media_private_operations d ON d.object_id=o.id AND d.kind='DELETE' ORDER BY o.id`)).rows;
 const operations=(await pool.query('SELECT * FROM media_private_operations ORDER BY id')).rows;
 return{ledgerDigest:hash(JSON.stringify({rows,operations})),objects:rows.map(o=>({ref:{organizationId:o.organization_id,channelId:o.channel_id,mediaId:o.media_id,operationId:o.id},expected:{byteLength:o.cipher_byte_length,sha256:o.cipher_sha256},state:o.state,putState:o.put_state,deleteState:o.delete_state??null}))};
}
async function seed(mode:'READY'|'PUT_UNKNOWN_PRESENT'|'PUT_UNKNOWN_MISSING'|'DELETE_UNKNOWN_PRESENT'){
 const t=await seedAttendanceTenant(db.database,false),instance=randomUUID();
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
 await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'C5 synthetic',$4,'CONNECTED')",[instance,t.org,provider,`synthetic-c5-${instance}`]);
 await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
 const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[t.org])).rows[0]!.user_id as string;
 const media=await db.transact(t.org,tx=>registerPendingMedia(tx,t.org,t.channel,{source:'META',sourceKey:randomUUID(),kind:'document',fileName:file.fileName,descriptor:{mediaId:'11111'}}));
 const objectStore:PrivateObjectStore={...real,put:async(...args)=>{
  if(mode==='PUT_UNKNOWN_PRESENT'){await real.put(...args);return{outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'};}
  if(mode==='PUT_UNKNOWN_MISSING')return{outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'};return real.put(...args);
 }};
 const kernel=core(db.transact,life,objectStore);const staged=await kernel.stage(t.org,media,file);expect(await kernel.dispatchPut(t.org,staged.objectId)).toBe(mode.startsWith('PUT_UNKNOWN')?'UNKNOWN':'CONFIRMED');
 if(mode==='DELETE_UNKNOWN_PRESENT'){
  const id=(await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6)',[t.org,instance,'C5 synthetic','C5 synthetic recovery','TENANT',actor])).rows[0]!.lifecycle_request_channel as string,lease=randomUUID();
  await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1",[id]);
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL',lease_token=$2,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[id,lease]);
  const deletionStore:PrivateObjectStore={...real,remove:async()=>({outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'})};
  const deleter=core(db.transact,life,deletionStore);await deleter.prepareCleanup(id,lease);await deleter.runCleanupOnce(id,lease);
 }
 const row={...t,instance,actor,media,objectId:staged.objectId};tRows.push(row);return row;
}
beforeAll(async()=>{
 credentials={access:storage.access,secret:storage.secret,binarySha256:storage.binarySha256};
 if(credentials.binarySha256!=='7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f')throw new Error('C5_MINIO_ARTIFACT_UNVERIFIED');
 await createBucket();real=adapter();redis=createClient({url:redisUrl});redis.on('error',()=>{});await redis.connect();await redis.ping();
 db=await attendanceDatabase();destination=await createIsolatedPostgresDatabase(requireTestDatabaseAdminUrl());
 expect(RUNTIME_SCHEMA_BASELINE).toMatch(/^00(?:5[2-9]|[6-9][0-9])_/);
 expect(await db.transact((await seedAttendanceTenant(db.database,false)).org,tx=>probeRequiredRuntimeSchema(sql=>tx.query(sql)))).toBe(true);
 life=rolePool(db.database.connectionString,'jrc_lifecycle');platform=rolePool(db.database.connectionString,'jrc_platform');
 await seed('READY');await seed('PUT_UNKNOWN_PRESENT');await seed('PUT_UNKNOWN_MISSING');await seed('DELETE_UNKNOWN_PRESENT');
 await redis.set(namespace+'persistent','synthetic-c5-persistent');await redis.set(namespace+'live','synthetic-c5-live',{PX:120000});await redis.set(namespace+'expired','synthetic-c5-expired',{PX:250});
 await mkdir(join(folder,'runs',suffix),{recursive:true});
});
afterAll(async()=>{await mkdir(join(folder,'runs',suffix),{recursive:true});await writeFile(join(folder,'runs',suffix,'diagnostics.json'),JSON.stringify({scope:'ISOLATED_NAMESPACE',http,observations},null,2)+'\n');await restoredApp?.end();await restoredLife?.end();await life?.end();await platform?.end();if(redis?.isOpen){await redis.del([namespace+'persistent',namespace+'live',namespace+'expired',`broker-c5-${suffix}-outside:guard`]);await redis.quit();}await destination?.dispose();await db?.dispose();});

it('exports and restores only the real Redis namespace, preserving persistence and remaining TTL',async()=>{
 const guard=`broker-c5-${suffix}-outside:guard`;await redis.set(guard,'synthetic-guard');
 const snapshot=await captureRedisNamespace(redis,{namespace});await redis.del(snapshot.keys.map((k:{key:string})=>k.key));
 await restoreRedisNamespace(redis,snapshot);
 expect(await redis.get(namespace+'persistent')).toBe('synthetic-c5-persistent');expect(await redis.pTTL(namespace+'persistent')).toBe(-1);
 expect(await redis.pTTL(namespace+'live')).toBeGreaterThan(0);expect(await redis.pTTL(namespace+'live')).toBeLessThanOrEqual(120000);
 expect(await redis.get(guard)).toBe('synthetic-guard');await redis.del(guard);
});

it('restores real PG, scoped Redis and private MinIO ciphertext then reconciles UNKNOWN without PUT, DELETE or send replay',async()=>{
 const run=join(folder,'runs',suffix),directory=join(run,'backup'),before=await inventory(db.database.pool);phase='CAPTURE';
 const pgVersion=(await db.database.pool.query('SHOW server_version')).rows[0]!.server_version.split(' ')[0] as string;
 const redisVersion=(await redis.info('server')).match(/redis_version:([^\r\n]+)/)?.[1];expect(redisVersion).toBeDefined();
 const metadata={scope:'ISOLATED_NAMESPACE',sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),apiDigest:null,webDigest:null,runtimeArtifacts:'UNPUBLISHED_SOURCE_OVERLAY',schema:{baseline:RUNTIME_SCHEMA_BASELINE},versions:{postgres:pgVersion,redis:redisVersion,s3ArtifactSha256:credentials.binarySha256},backendFingerprint:real.destinationFingerprint};
 const configuration={mediaEncryptionKey:encryptionKey,objectStore:{endpoint,bucket,profile,region:'us-east-1',accessKeyId:credentials.access,secretAccessKey:credentials.secret,dedicatedBucket:true,allowLoopbackHttpForTests:true,requestTimeoutMs:5000}};
 const configurationPath=join(run,'private-configuration.json');await writeFile(configurationPath,JSON.stringify(configuration),{mode:0o600});
 const parameters={directory,databaseUrl:db.database.connectionString,targetDatabaseUrl:destination.connectionString,redisUrl,redisNamespace:namespace,pgDumpExecutable,pgRestoreExecutable,privateConfigurationFile:configurationPath,objectStoreModule:resolve('apps/api/dist/modules/messaging/private-object-store.js'),restoreJournalPath:join(run,'restore-state.jrcbak'),backendFingerprint:real.destinationFingerprint,metadata,quiescence:{postgres:true,redis:true,objectStore:true,providers:true}};
 const parametersPath=join(run,'cli-parameters.json');
 await writeFile(parametersPath,JSON.stringify(parameters),{mode:0o600});
 const cli=(mode:string)=>JSON.parse(execFileSync(process.execPath,[resolve('scripts/operations/recovery/recovery-cli.mjs'),mode,'--parameters',parametersPath],{encoding:'utf8',env:{...process.env,JRC_BACKUP_KEY:backupKey},timeout:120000}));
 expect(cli('capture')).toMatchObject({passed:true,mode:'capture',objectCount:4});
 await unlink(configurationPath);
 const snapshot=await verifyRecoveryBundle({directory,backupKey,expectedBackendFingerprint:real.destinationFingerprint});expect(snapshot.objects.filter((o:{putState:string})=>o.putState==='UNKNOWN')).toHaveLength(2);
 // Simulate storage loss only for this owned laboratory object. This is not a kernel DELETE.
 phase='FAULT_INJECTION';const lost=snapshot.objects.find((o:{ref:{operationId:string}})=>o.ref.operationId===tRows[0]!.objectId)!;
 expect(await real.remove(lost.ref,{deadline:new Date(Date.now()+5000)})).toEqual({outcome:'CONFIRMED'});
 await redis.del([namespace+'persistent',namespace+'live']);
 phase='ADMINISTRATIVE_RESTORE';const restoration=cli('restore');
 await unlink(parametersPath);
 expect(restoration).toMatchObject({passed:true,mode:'restore'});const redisEvidence=restoration.redis;
 expect((await inventory(destination.pool)).ledgerDigest).toBe(before.ledgerDigest);
 expect(await redis.get(namespace+'persistent')).toBe('synthetic-c5-persistent');expect(await redis.pTTL(namespace+'persistent')).toBe(-1);
 expect(await redis.get(namespace+'live')).toBe('synthetic-c5-live');expect(await redis.pTTL(namespace+'live')).toBeGreaterThan(0);expect(await redis.pTTL(namespace+'live')).toBeLessThan(120000);expect(await redis.get(namespace+'expired')).toBeNull();
 restoredApp=rolePool(destination.connectionString,'jrc_app');restoredLife=rolePool(destination.connectionString,'jrc_lifecycle');
 const transact:typeof db.transact=(org,work)=>withOrganizationTransaction(restoredApp,org,work),kernel=core(transact,restoredLife);phase='RECOVERED_RUNTIME';
 const facade=createMediaStore({encryptionKey:snapshot.privateConfiguration.mediaEncryptionKey,maxStorageBytes:1024,transact,privateStore:kernel,download:async()=>{throw new Error('C5_DOWNLOAD_REPLAY_FORBIDDEN');}});
 expect(await facade.read(tRows[0]!.org,tRows[0]!.media)).toEqual(file);
 await expect(facade.read(tRows[1]!.org,tRows[0]!.media)).rejects.toMatchObject({code:'MEDIA_NOT_FOUND'});
 expect(await kernel.reconcilePut(tRows[1]!.org,tRows[1]!.objectId)).toBe('CONFIRMED');expect(await facade.read(tRows[1]!.org,tRows[1]!.media)).toEqual(file);
 expect(await kernel.reconcilePut(tRows[2]!.org,tRows[2]!.objectId)).toBe('UNKNOWN');
 const deletion=(await destination.pool.query('SELECT deletion_id,authorization_lease FROM media_private_operations WHERE object_id=$1 AND kind=$2',[tRows[3]!.objectId,'DELETE'])).rows[0]!;
 expect(await kernel.runCleanupOnce(deletion.deletion_id,deletion.authorization_lease)).toBe(true);
 expect((await destination.pool.query('SELECT state FROM media_private_operations WHERE object_id=$1 AND kind=$2',[tRows[3]!.objectId,'DELETE'])).rows).toEqual([{state:'UNKNOWN'}]);
 expect(http.filter(o=>o.phase==='RECOVERED_RUNTIME'&&o.method!=='GET')).toEqual([]);
 expect((await destination.pool.query('SELECT count(*) FROM messaging_outbox')).rows[0]!.count).toBe('0');
 const evidence={scope:'ISOLATED_NAMESPACE',schema:metadata.schema,sourceSha:metadata.sourceSha,backendFingerprint:real.destinationFingerprint,postgresDumpRestored:true,ledgerInitiallyIdentical:true,redis:redisEvidence,privateMediaReadable:true,otherTenantDenied:true,unknownPutConfirmedByRead:true,missingPutStillUnknown:true,deletePresentStillUnknown:true,runtimePuts:0,runtimeDeletes:0,runtimeSendOutboxRows:0,cliCapture:true,cliRestore:true,administrativeRestore:restoration.objects,http:http.map(({phase,method,status})=>({phase,method,status}))};
 await writeFile(join(run,'result.json'),JSON.stringify(evidence,null,2)+'\n');await writeFile(join(folder,'latest-result.json'),JSON.stringify(evidence,null,2)+'\n');
});

it('refuses an occupied real Redis namespace before overwriting any key',async()=>{
 const snapshot=await captureRedisNamespace(redis,{namespace}),value=await redis.get(namespace+'persistent');
 await expect(restoreRedisNamespace(redis,snapshot)).rejects.toThrow('RECOVERY_REDIS_TARGET_NOT_EMPTY');
 expect(await redis.get(namespace+'persistent')).toBe(value);expect(await redis.pTTL(namespace+'persistent')).toBe(-1);
});

it('refuses a populated real PostgreSQL destination without changing its ledger',async()=>{
 const before=await inventory(db.database.pool),dump=await capturePostgresDump({databaseUrl:db.database.connectionString,executable:pgDumpExecutable});
 await expect(restorePostgresDump({databaseUrl:db.database.connectionString,executable:pgRestoreExecutable,dump})).rejects.toThrow('RECOVERY_POSTGRES_TARGET_NOT_EMPTY');
 expect((await inventory(db.database.pool)).ledgerDigest).toBe(before.ledgerDigest);
});
