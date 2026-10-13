import {createHash,createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,stat,unlink,rename,open} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {Readable} from 'node:stream';
import {encryptBackup,decryptBackup} from '../backup.mjs';

const MAX_BYTES=64*1024*1024,MAX_OBJECTS=32,MAX_KEYS=128,HEX=/^[a-f0-9]{64}$/;
const fail=code=>{throw new Error(code);},digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeInteger=value=>Number.isSafeInteger(value);
function backupKey(value){const b=Buffer.from(value??'','base64');if(b.length!==32||b.toString('base64')!==value)fail('RECOVERY_KEY_INVALID');return b;}
function auth(value,key){return createHmac('sha256',backupKey(key)).update('jrc-recovery-manifest:v1\n'+JSON.stringify(value)).digest('hex');}
function metadata(v){
 const unpublished=v?.runtimeArtifacts==='UNPUBLISHED_SOURCE_OVERLAY'&&v.apiDigest===null&&v.webDigest===null;
 const published=/^sha256:[a-f0-9]{64}$/.test(v?.apiDigest??'')&&/^sha256:[a-f0-9]{64}$/.test(v?.webDigest??'')&&v.runtimeArtifacts===undefined;
 if(v?.scope!=='ISOLATED_NAMESPACE'||!/^[a-f0-9]{40,64}$/.test(v.sourceSha??'')||(!unpublished&&!published)||!HEX.test(v.backendFingerprint??'')||!/^\d{4}_[a-z0-9_]+$/.test(v.schema?.baseline??''))fail('RECOVERY_METADATA_INVALID');
 const s=v.schema;if(s.overlayTarget!==undefined&&(!/^\d{4}_[a-z0-9_]+$/.test(s.overlayTarget)||!HEX.test(s.overlaySha256??'')))fail('RECOVERY_METADATA_INVALID');
 if(!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(v.versions?.postgres??'')||!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(v.versions?.redis??'')||!HEX.test(v.versions?.s3ArtifactSha256??''))fail('RECOVERY_METADATA_INVALID');
 return{scope:v.scope,sourceSha:v.sourceSha,apiDigest:v.apiDigest,webDigest:v.webDigest,...(unpublished?{runtimeArtifacts:v.runtimeArtifacts}:{}),schema:{baseline:s.baseline,...(s.overlayTarget?{overlayTarget:s.overlayTarget,overlaySha256:s.overlaySha256}:{})},versions:{postgres:v.versions.postgres,redis:v.versions.redis,s3ArtifactSha256:v.versions.s3ArtifactSha256},backendFingerprint:v.backendFingerprint};
}
function bytes(value){const b=Buffer.from(value);if(b.length>MAX_BYTES)fail('RECOVERY_LIMIT_EXCEEDED');return b;}
function redisSnapshot(s){
 if(!/^broker-c5-[a-z0-9-]{1,64}:$/.test(s?.namespace??'')||!safeInteger(s.capturedHostMs)||!safeInteger(s.capturedRedisMs)||s.capturedHostMs<0||s.capturedRedisMs<0||!Array.isArray(s.keys)||s.keys.length>MAX_KEYS)fail('RECOVERY_REDIS_SCOPE_INVALID');
 const seen=new Set();for(const r of s.keys){
  if(typeof r.key!=='string'||!r.key.startsWith(s.namespace)||r.key.length>256||seen.has(r.key)||!safeInteger(r.pttl)||r.pttl< -2)fail('RECOVERY_REDIS_SCOPE_INVALID');seen.add(r.key);
  if(r.pttl!==-2&&(typeof r.dump!=='string'||Buffer.from(r.dump,'base64').toString('base64')!==r.dump||Buffer.from(r.dump,'base64').length>1024*1024))fail('RECOVERY_REDIS_SCOPE_INVALID');
 }return s;
}
export function planRedisRestore(snapshot,{hostNowMs,redisNowMs}){
 const s=redisSnapshot(snapshot);if(!safeInteger(hostNowMs)||!safeInteger(redisNowMs)||hostNowMs<s.capturedHostMs)fail('RECOVERY_CLOCK_REGRESSION');
 return s.keys.flatMap(r=>{
  if(r.pttl===-2||r.pttl===0)return[];
  const ttlMs=r.pttl===-1?0:Math.floor(Math.min(r.pttl-(hostNowMs-s.capturedHostMs),s.capturedRedisMs+r.pttl-redisNowMs));
  if(r.pttl>0&&ttlMs<=0)return[];return[{key:r.key,ttlMs,dump:Buffer.from(r.dump,'base64')}];
 });
}
async function encrypted(directory,name,data,key){const body=bytes(data),path=join(directory,name);await mkdir(dirname(path),{recursive:true});await encryptBackup(Readable.from([body]),path,key);return{name,sha256:digest(await readFile(path))};}
async function decoded(path,key){const temporary=join(dirname(path),'.decoded-'+randomUUID());try{await decryptBackup(path,temporary,key);if((await stat(temporary)).size>MAX_BYTES)fail('RECOVERY_LIMIT_EXCEEDED');return await readFile(temporary);}finally{await unlink(temporary).catch(()=>{});}}
const control=()=>({deadline:new Date(Date.now()+10000)});
function validObject(o){
 const r=o?.ref;if(!r||Object.keys(r).length!==4||['organizationId','channelId','mediaId','operationId'].some(k=>! /^[a-f0-9-]{36}$/.test(r[k]??''))||!safeInteger(o.expected?.byteLength)||o.expected.byteLength<1||o.expected.byteLength>MAX_BYTES||!HEX.test(o.expected.sha256??'')||!['STAGED','READY','DELETING','DELETED','REJECTED'].includes(o.state)||!['PREPARED','DISPATCHED','CONFIRMED','UNKNOWN','REJECTED'].includes(o.putState)||(o.deleteState!==null&&!['PREPARED','DISPATCHED','CONFIRMED','UNKNOWN','REJECTED'].includes(o.deleteState)))fail('RECOVERY_LEDGER_INVALID');
 return{ref:{organizationId:r.organizationId,channelId:r.channelId,mediaId:r.mediaId,operationId:r.operationId},expected:{byteLength:o.expected.byteLength,sha256:o.expected.sha256},state:o.state,putState:o.putState,deleteState:o.deleteState};
}
export async function createRecoveryBundle(o){
 backupKey(o.backupKey);const meta=metadata(o.metadata);if(['postgres','redis','objectStore','providers'].some(k=>o.quiescence?.[k]!==true))fail('RECOVERY_WRITERS_NOT_PAUSED');if(o.objectStore.destinationFingerprint!==meta.backendFingerprint)fail('RECOVERY_BACKEND_MISMATCH');
 const first=await o.readInventory();if(!HEX.test(first.ledgerDigest??'')||!Array.isArray(first.objects)||first.objects.length>MAX_OBJECTS)fail('RECOVERY_LEDGER_INVALID');const objects=first.objects.map(validObject),files=[];await mkdir(o.directory,{mode:0o700});
 let total=0;const add=async(name,data)=>{const body=bytes(data);total+=body.length;if(total>MAX_BYTES)fail('RECOVERY_LIMIT_EXCEEDED');files.push(await encrypted(o.directory,name,body,o.backupKey));};
 await add('postgres.dump.jrcbak',await o.capturePostgres());const redis=redisSnapshot(await o.captureRedis());await add('redis.json.jrcbak',JSON.stringify(redis));await add('private-config.json.jrcbak',JSON.stringify(o.privateConfiguration));
 const records=[];for(const[index,row]of objects.entries()){
  if(row.state==='DELETED'||row.state==='REJECTED'){records.push({...row,observation:'EXCLUDED'});continue;}
  const result=await o.objectStore.read(row.ref,row.expected,control());if(result.outcome==='MISSING'){if(row.state==='READY')fail('RECOVERY_READY_OBJECT_MISSING');records.push({...row,observation:'MISSING'});continue;}
  if(result.outcome!=='CONFIRMED')fail('RECOVERY_OBJECT_CAPTURE_UNVERIFIED');const body=bytes(result.bytes);if(body.length!==row.expected.byteLength||digest(body)!==row.expected.sha256)fail('RECOVERY_OBJECT_INTEGRITY_FAILED');
  const name=`objects/${String(index).padStart(6,'0')}.cipher.jrcbak`;await add(name,body);records.push({...row,observation:'PRESENT',artifact:name});
 }
 const second=await o.readInventory();if(second.ledgerDigest!==first.ledgerDigest||JSON.stringify(second.objects.map(validObject))!==JSON.stringify(objects))fail('RECOVERY_CAPTURE_CHANGED');await add('ledger.json.jrcbak',JSON.stringify({ledgerDigest:first.ledgerDigest,objects:records}));
 const unsigned={version:1,...meta,createdAt:new Date().toISOString(),consistency:'ALL_WRITERS_PAUSED',redisScope:'LIMITED_NAMESPACE',objectCount:objects.length,files},manifest={...unsigned,authentication:auth(unsigned,o.backupKey)};await writeFile(join(o.directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return manifest;
}
export async function verifyRecoveryBundle({directory,backupKey:key,expectedBackendFingerprint}){
 backupKey(key);let m;try{const raw=await readFile(join(directory,'manifest.json'));if(raw.length>128*1024)fail('RECOVERY_LIMIT_EXCEEDED');m=JSON.parse(raw.toString());}catch{fail('RECOVERY_MANIFEST_AUTHENTICATION_FAILED');}
 const{authentication,...unsigned}=m,expected=auth(unsigned,key);if(typeof authentication!=='string'||!HEX.test(authentication)||!timingSafeEqual(Buffer.from(authentication,'hex'),Buffer.from(expected,'hex')))fail('RECOVERY_MANIFEST_AUTHENTICATION_FAILED');const meta=metadata(m);
 if(m.version!==1||m.redisScope!=='LIMITED_NAMESPACE'||m.consistency!=='ALL_WRITERS_PAUSED'||!Array.isArray(m.files)||m.files.length>MAX_OBJECTS+4||!safeInteger(m.objectCount)||m.objectCount>MAX_OBJECTS)fail('RECOVERY_MANIFEST_INVALID');if(expectedBackendFingerprint!==meta.backendFingerprint)fail('RECOVERY_BACKEND_MISMATCH');
 const values=new Map();let total=0;for(const f of m.files){
  if(!/^(postgres\.dump|redis\.json|private-config\.json|ledger\.json)\.jrcbak$/.test(f.name??'')&&!/^objects\/[0-9]{6}\.cipher\.jrcbak$/.test(f.name??''))fail('RECOVERY_MANIFEST_INVALID');if(values.has(f.name)||!HEX.test(f.sha256??''))fail('RECOVERY_MANIFEST_INVALID');
  let value;try{const p=join(directory,f.name);if((await stat(p)).size>MAX_BYTES+34)fail('RECOVERY_LIMIT_EXCEEDED');if(digest(await readFile(p))!==f.sha256)fail('RECOVERY_ARTIFACT_AUTHENTICATION_FAILED');value=await decoded(p,key);}catch{fail('RECOVERY_ARTIFACT_AUTHENTICATION_FAILED');}total+=value.length;if(total>MAX_BYTES)fail('RECOVERY_LIMIT_EXCEEDED');values.set(f.name,value);
 }
 try{
  const postgres=values.get('postgres.dump.jrcbak');if(!postgres)fail('RECOVERY_MANIFEST_INVALID');const redis=redisSnapshot(JSON.parse(values.get('redis.json.jrcbak'))),privateConfiguration=JSON.parse(values.get('private-config.json.jrcbak')),ledger=JSON.parse(values.get('ledger.json.jrcbak'));if(!HEX.test(ledger.ledgerDigest??'')||!Array.isArray(ledger.objects)||ledger.objects.length!==m.objectCount)fail('RECOVERY_LEDGER_INVALID');
  const objects=ledger.objects.map(o=>{const row=validObject(o);if(!['PRESENT','MISSING','EXCLUDED'].includes(o.observation))fail('RECOVERY_LEDGER_INVALID');if(o.observation==='PRESENT'){const body=values.get(o.artifact);if(!body||body.length!==row.expected.byteLength||digest(body)!==row.expected.sha256)fail('RECOVERY_OBJECT_INTEGRITY_FAILED');return{...row,observation:o.observation,bytes:body};}if(row.state==='READY')fail('RECOVERY_READY_OBJECT_MISSING');return{...row,observation:o.observation};});
  return{directory,manifest:m,postgres,redis,privateConfiguration,ledgerDigest:ledger.ledgerDigest,objects};
 }catch(error){if(error instanceof Error&&error.message.startsWith('RECOVERY_'))throw error;fail('RECOVERY_MANIFEST_INVALID');}
}
async function saveJournal(path,value,key){const temp=path+'.'+randomUUID();try{await encrypted(dirname(temp),basename(temp),JSON.stringify(value),key);const handle=await open(temp,'r+');try{await handle.sync();}finally{await handle.close();}await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}}
export async function restoreRecoveryObjects({snapshot,objectStore,journalPath,backupKey:key}){
 const lockPath=join(snapshot.directory,'restore.lock');let lock;try{lock=await open(lockPath,'wx',0o600);}catch{fail('RECOVERY_OPERATOR_ALREADY_ACTIVE');}
 try{await lock.writeFile(JSON.stringify({manifestAuthentication:snapshot.manifest.authentication,pid:process.pid}));await lock.sync();return await restoreLocked({snapshot,objectStore,journalPath,backupKey:key});}finally{await lock.close();await unlink(lockPath);}
}
async function restoreLocked({snapshot,objectStore,journalPath,backupKey:key}){
 backupKey(key);if(snapshot.manifest.backendFingerprint!==objectStore.destinationFingerprint)fail('RECOVERY_BACKEND_MISMATCH');let journal;
 try{journal=JSON.parse((await decoded(journalPath,key)).toString());}catch(error){if(error?.code!=='ENOENT')fail('RECOVERY_JOURNAL_INVALID');journal={version:1,manifestAuthentication:snapshot.manifest.authentication,states:{}};}
 if(journal.version!==1||journal.manifestAuthentication!==snapshot.manifest.authentication||!journal.states||typeof journal.states!=='object')fail('RECOVERY_JOURNAL_INVALID');let restored=0;
 for(const[index,row]of snapshot.objects.entries()){
  if(row.observation!=='PRESENT')continue;let observation;try{observation=await objectStore.inspect(row.ref,row.expected,control());}catch{observation={outcome:'UNKNOWN'};}
  if(observation.outcome==='CONFIRMED'){if(observation.byteLength!==row.expected.byteLength||observation.sha256!==row.expected.sha256)fail('RECOVERY_DESTINATION_OBJECT_CONFLICT');journal.states[index]='CONFIRMED';await saveJournal(journalPath,journal,key);restored++;continue;}
  if(observation.outcome!=='MISSING'||journal.states[index]!==undefined)fail('RECOVERY_OBJECT_RESTORE_UNKNOWN');journal.states[index]='DISPATCHED';await saveJournal(journalPath,journal,key);
  try{await objectStore.put(row.ref,row.bytes,row.expected,control());}catch{/* A lost receipt never authorizes another PUT. */}
  try{observation=await objectStore.inspect(row.ref,row.expected,control());}catch{observation={outcome:'UNKNOWN'};}
  if(observation.outcome!=='CONFIRMED'||observation.byteLength!==row.expected.byteLength||observation.sha256!==row.expected.sha256){journal.states[index]='UNKNOWN';await saveJournal(journalPath,journal,key);fail('RECOVERY_OBJECT_RESTORE_UNKNOWN');}
  journal.states[index]='CONFIRMED';await saveJournal(journalPath,journal,key);restored++;
 }return{restored,uncertain:0};
}
