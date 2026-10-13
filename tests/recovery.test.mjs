import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach,expect,it} from 'vitest';
import {createRecoveryBundle,verifyRecoveryBundle,planRedisRestore,restoreRecoveryObjects} from '../scripts/operations/recovery/recovery.mjs';
import {capturePostgresDump,restorePostgresDump} from '../scripts/operations/recovery/postgres-recovery.mjs';

const key=Buffer.alloc(32,7).toString('base64'),fingerprint='b'.repeat(64),hash=v=>createHash('sha256').update(v).digest('hex');
const folders=[];
afterEach(async()=>{for(const f of folders.splice(0)){const target=resolve(f);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('jrc-c5-unit-'))throw Error('RECOVERY_TEST_CLEANUP_TARGET_INVALID');await rm(target,{recursive:true,force:true});}});
async function fixture(){
 const folder=await mkdtemp(join(tmpdir(),'jrc-c5-unit-'));folders.push(folder);
 const cipher=Buffer.from('synthetic ciphertext SECRET_MEDIA'),ref={organizationId:randomUUID(),channelId:randomUUID(),mediaId:randomUUID(),operationId:randomUUID()};
 const states=new Map([[ref.operationId,cipher]]),actions=[];
 const objectStore={destinationFingerprint:fingerprint,
  read:async r=>states.has(r.operationId)?{outcome:'CONFIRMED',bytes:states.get(r.operationId)}:{outcome:'MISSING'},
  inspect:async(r)=>{actions.push('GET');const b=states.get(r.operationId);return b?{outcome:'CONFIRMED',byteLength:b.length,sha256:hash(b)}:{outcome:'MISSING'};},
  put:async(r,b)=>{actions.push('PUT');states.set(r.operationId,Buffer.from(b));return{outcome:'CONFIRMED'};}};
 const inventory={objects:[{ref,expected:{byteLength:cipher.length,sha256:hash(cipher)},state:'READY',putState:'CONFIRMED',deleteState:null}],ledgerDigest:'c'.repeat(64)};
 const metadata={scope:'ISOLATED_NAMESPACE',sourceSha:'a'.repeat(40),apiDigest:'sha256:'+'a'.repeat(64),webDigest:'sha256:'+'d'.repeat(64),schema:{baseline:'0051_whatsapp_group_events',overlayTarget:'0052_durable_private_media',overlaySha256:'e'.repeat(64)},versions:{postgres:'16.4',redis:'7.2.0',s3ArtifactSha256:'f'.repeat(64)},backendFingerprint:fingerprint};
 const options={directory:join(folder,'backup'),backupKey:key,metadata,privateConfiguration:{mediaEncryptionKey:'SECRET_ENCRYPTION_KEY',s3Secret:'SECRET_S3_KEY'},
  quiescence:{postgres:true,redis:true,objectStore:true,providers:true},readInventory:async()=>structuredClone(inventory),
  capturePostgres:async()=>Buffer.from('SYNTHETIC_PG_DUMP_SECRET'),captureRedis:async()=>({namespace:'broker-c5-unit:',capturedHostMs:1000,capturedRedisMs:1000,keys:[{key:'broker-c5-unit:p',pttl:-1,dump:Buffer.from('SECRET_REDIS').toString('base64')}]}),objectStore};
 return {folder,options,cipher,ref,states,actions,inventory};
}
it('authenticates a complete encrypted snapshot without private configuration, dump or media bytes in the public manifest',async()=>{
 const f=await fixture();await createRecoveryBundle(f.options);
 const raw=await readFile(join(f.options.directory,'manifest.json'),'utf8'),m=JSON.parse(raw);
 expect(m).toMatchObject({version:1,scope:'ISOLATED_NAMESPACE',backendFingerprint:fingerprint,objectCount:1});
 expect(raw).not.toMatch(/SECRET_|organizationId|s3Secret|mediaEncryptionKey/);
 const verified=await verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:fingerprint});
 expect(verified.privateConfiguration.s3Secret).toBe('SECRET_S3_KEY');expect(verified.postgres.toString()).toBe('SYNTHETIC_PG_DUMP_SECRET');
 expect(verified.objects[0].bytes).toEqual(f.cipher);
});
it('rejects the combined dump and object bytes before reporting a snapshot that exceeds the verification budget',async()=>{
 const f=await fixture(),cipher=Buffer.alloc(30*1024*1024,3);
 f.states.set(f.ref.operationId,cipher);f.inventory.objects[0].expected={byteLength:cipher.length,sha256:hash(cipher)};
 f.options.capturePostgres=async()=>Buffer.alloc(40*1024*1024,4);
 await expect(createRecoveryBundle(f.options)).rejects.toThrow('RECOVERY_LIMIT_EXCEEDED');
 await expect(readFile(join(f.options.directory,'manifest.json'))).rejects.toMatchObject({code:'ENOENT'});
 expect(f.actions).toEqual([]);
});
it('refuses backend changes and tampered manifests before any restore side effect',async()=>{
 const f=await fixture();await createRecoveryBundle(f.options);
 await expect(verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:'a'.repeat(64)})).rejects.toThrow('RECOVERY_BACKEND_MISMATCH');
 const p=join(f.options.directory,'manifest.json'),m=JSON.parse(await readFile(p,'utf8'));m.schema.baseline='0052_durable_private_media';await writeFile(p,JSON.stringify(m));
 await expect(verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:fingerprint})).rejects.toThrow('RECOVERY_MANIFEST_AUTHENTICATION_FAILED');
 expect(f.actions).toEqual([]);
});
it('refuses a READY object missing from the backend and never uploads while capturing',async()=>{
 const f=await fixture();f.states.clear();await expect(createRecoveryBundle(f.options)).rejects.toThrow('RECOVERY_READY_OBJECT_MISSING');
 expect(f.actions).toEqual([]);
});
it('retains UNKNOWN with observed absence rather than inventing bytes or resetting its ledger state',async()=>{
 const f=await fixture();f.states.clear();f.inventory.objects[0].state='STAGED';f.inventory.objects[0].putState='UNKNOWN';
 await createRecoveryBundle(f.options);const verified=await verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:fingerprint});
 expect(verified.objects[0]).toMatchObject({observation:'MISSING',state:'STAGED',putState:'UNKNOWN'});expect(verified.objects[0].bytes).toBeUndefined();
 const journal=join(f.folder,'restore.jrcbak');await restoreRecoveryObjects({snapshot:verified,objectStore:f.options.objectStore,journalPath:journal,backupKey:key});
 expect(f.actions).toEqual([]);expect(f.states.size).toBe(0);
});
it('rejects unpaused providers and a changed ledger instead of claiming cross-store consistency',async()=>{
 const f=await fixture();await expect(createRecoveryBundle({...f.options,quiescence:{...f.options.quiescence,providers:false}})).rejects.toThrow('RECOVERY_WRITERS_NOT_PAUSED');
 let reads=0;f.options.readInventory=async()=>({...f.inventory,ledgerDigest:++reads===1?'c'.repeat(64):'d'.repeat(64)});
 await expect(createRecoveryBundle(f.options)).rejects.toThrow('RECOVERY_CAPTURE_CHANGED');
});
it('verifies every encrypted artifact before a ciphertext corruption can be accepted',async()=>{
 const f=await fixture();await createRecoveryBundle(f.options);
 const m=JSON.parse(await readFile(join(f.options.directory,'manifest.json'),'utf8')),p=join(f.options.directory,m.files[0].name),data=await readFile(p);data[25]^=1;await writeFile(p,data);
 await expect(verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:fingerprint})).rejects.toThrow('RECOVERY_ARTIFACT_AUTHENTICATION_FAILED');
});
it('keeps PTTL -1 persistent, drops -2 and expired/zero keys, and caps positive TTL despite a destination clock behind the source',()=>{
 const s={namespace:'broker-c5-unit:',capturedHostMs:1000,capturedRedisMs:100000,keys:[
  {key:'broker-c5-unit:permanent',pttl:-1,dump:'YQ=='},{key:'broker-c5-unit:absent',pttl:-2,dump:null},
  {key:'broker-c5-unit:zero',pttl:0,dump:'Yg=='},{key:'broker-c5-unit:expired',pttl:100,dump:'Yw=='},{key:'broker-c5-unit:live',pttl:10000,dump:'ZA=='}]};
 expect(planRedisRestore(s,{hostNowMs:1500,redisNowMs:90000})).toEqual([
  {key:'broker-c5-unit:permanent',ttlMs:0,dump:Buffer.from('a')},{key:'broker-c5-unit:live',ttlMs:9500,dump:Buffer.from('d')}]);
 expect(planRedisRestore(s,{hostNowMs:1500,redisNowMs:110001})).toEqual([{key:'broker-c5-unit:permanent',ttlMs:0,dump:Buffer.from('a')}]);
});
it('rejects namespace escape and host clock regression before creating a Redis recovery plan',()=>{
 const s={namespace:'broker-c5-unit:',capturedHostMs:1000,capturedRedisMs:1000,keys:[{key:'another-app:x',pttl:10000,dump:'YQ=='}]};
 expect(()=>planRedisRestore(s,{hostNowMs:2000,redisNowMs:2000})).toThrow('RECOVERY_REDIS_SCOPE_INVALID');
 s.keys[0].key='broker-c5-unit:x';expect(()=>planRedisRestore(s,{hostNowMs:999,redisNowMs:2000})).toThrow('RECOVERY_CLOCK_REGRESSION');
});
it('restores a missing ciphertext once and only inspects after a lost restore receipt across process restart',async()=>{
 const f=await fixture();await createRecoveryBundle(f.options);const snapshot=await verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:fingerprint});f.states.clear();
 const uncertain={...f.options.objectStore,put:async()=>{f.actions.push('PUT');return{outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'};}};
 const options={snapshot,objectStore:uncertain,journalPath:join(f.folder,'restore.jrcbak'),backupKey:key};
 await expect(restoreRecoveryObjects(options)).rejects.toThrow('RECOVERY_OBJECT_RESTORE_UNKNOWN');
 await expect(restoreRecoveryObjects(options)).rejects.toThrow('RECOVERY_OBJECT_RESTORE_UNKNOWN');
 expect(f.actions.filter(a=>a==='PUT')).toHaveLength(1);f.states.set(f.ref.operationId,f.cipher);
 await expect(restoreRecoveryObjects(options)).resolves.toMatchObject({restored:1,uncertain:0});expect(f.actions.filter(a=>a==='PUT')).toHaveLength(1);
});
it('records an unpublished source overlay without inventing API or web image digests',async()=>{
 const f=await fixture();f.options.metadata.apiDigest=null;f.options.metadata.webDigest=null;f.options.metadata.runtimeArtifacts='UNPUBLISHED_SOURCE_OVERLAY';
 await createRecoveryBundle(f.options);const verified=await verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:fingerprint});
 expect(verified.manifest).toMatchObject({apiDigest:null,webDigest:null,runtimeArtifacts:'UNPUBLISHED_SOURCE_OVERLAY'});
});
it('refuses non-laboratory database names before starting any dump or restore executable',async()=>{
 await expect(capturePostgresDump({databaseUrl:'postgresql://postgres@127.0.0.1:55432/customer_db',executable:'missing.exe'})).rejects.toThrow('RECOVERY_LAB_DATABASE_REQUIRED');
 await expect(restorePostgresDump({databaseUrl:'postgresql://postgres@server.example/customer_db',executable:'missing.exe',dump:Buffer.from('x')})).rejects.toThrow('RECOVERY_LAB_DATABASE_REQUIRED');
});
it('verifies an archive through the operator CLI with explicit parameters and no secret output',async()=>{
 const f=await fixture();await createRecoveryBundle(f.options);const parameters=join(f.folder,'verify.parameters.json');
 await writeFile(parameters,JSON.stringify({directory:f.options.directory,backendFingerprint:fingerprint}));
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/operations/recovery/recovery-cli.mjs',import.meta.url)),'verify','--parameters',parameters],{encoding:'utf8',env:{...process.env,JRC_BACKUP_KEY:key},timeout:10000});
 expect(JSON.parse(output)).toMatchObject({scope:'ISOLATED_NAMESPACE',mode:'verify',passed:true});expect(output).not.toContain('SECRET_');
},10000);
it('prevents two recovery operators from dispatching the same missing object concurrently',async()=>{
 const f=await fixture();await createRecoveryBundle(f.options);const snapshot=await verifyRecoveryBundle({directory:f.options.directory,backupKey:key,expectedBackendFingerprint:fingerprint});f.states.clear();
 let admit,release;const entered=new Promise(r=>admit=r),hold=new Promise(r=>release=r);let puts=0;
 const store={...f.options.objectStore,put:async(r,b)=>{puts++;if(puts===1){admit();await hold;}f.states.set(r.operationId,Buffer.from(b));return{outcome:'CONFIRMED'};}};
 const options={snapshot,objectStore:store,journalPath:join(f.folder,'concurrent.jrcbak'),backupKey:key},first=restoreRecoveryObjects(options);await entered;
 try{await expect(restoreRecoveryObjects(options)).rejects.toThrow('RECOVERY_OPERATOR_ALREADY_ACTIVE');}finally{release();await first;}
 expect(puts).toBe(1);
});
it('refuses an unpaused CLI capture before loading private configuration or connecting to any service',async()=>{
 const f=await fixture(),parameters=join(f.folder,'capture.parameters.json');await writeFile(parameters,JSON.stringify({quiescence:{postgres:true,redis:true,objectStore:true,providers:false},privateConfigurationFile:'must-not-read'}));
 let output;try{execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/operations/recovery/recovery-cli.mjs',import.meta.url)),'capture','--parameters',parameters],{env:{...process.env,JRC_BACKUP_KEY:key},timeout:10000});}catch(e){output=String(e.stdout);}
 expect(JSON.parse(output)).toMatchObject({passed:false,error:'RECOVERY_WRITERS_NOT_PAUSED'});
});
it('authenticates a CLI restore before loading its adapter or connecting to any destination',async()=>{
 const f=await fixture();await createRecoveryBundle(f.options);const manifestPath=join(f.options.directory,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.objectCount++;await writeFile(manifestPath,JSON.stringify(manifest));
 const parameters=join(f.folder,'restore.parameters.json');await writeFile(parameters,JSON.stringify({directory:f.options.directory,backendFingerprint:fingerprint,objectStoreModule:'must-not-import'}));
 let output;try{execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/operations/recovery/recovery-cli.mjs',import.meta.url)),'restore','--parameters',parameters],{env:{...process.env,JRC_BACKUP_KEY:key},timeout:10000});}catch(e){output=String(e.stdout);}
 expect(JSON.parse(output)).toMatchObject({passed:false,error:'RECOVERY_MANIFEST_AUTHENTICATION_FAILED'});
});
