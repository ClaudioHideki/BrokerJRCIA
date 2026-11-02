import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {BinaryMedia} from '@jrc/providers';
import {createMediaStore,registerPendingMedia,partnerMediaUploadRequestHash,type MediaUploadIdentity} from '../../src/modules/messaging/media-store.js';
import {createDurablePrivateMediaStore,type PrivateMediaTransaction} from '../../src/modules/messaging/durable-private-media.js';
import {createS3PrivateObjectStore,type PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {requireCurrentPartnerKey} from '../../src/modules/messaging/partner-authority.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60_000);
afterAll(async()=>{await db?.dispose();});
const encryptionKey=Buffer.alloc(32,9).toString('base64');
const file:BinaryMedia={bytes:new TextEncoder().encode('Synthetic private upload'),mimeType:'text/plain',kind:'document',fileName:'fixture.txt'};
type Tenant=Awaited<ReturnType<typeof seedAttendanceTenant>>;
async function partnerTenant(){
 const t=await seedAttendanceTenant(db.database,false),instance=randomUUID(),key=randomUUID();
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE organization_id=$1 AND id=$2",[t.org,provider]);
 await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Synthetic partner media',$4,'CONNECTED')",[instance,t.org,provider,`synthetic-${instance}`]);
 await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$3,phone_number_id=NULL,waba_id=NULL WHERE organization_id=$1 AND id=$2",[t.org,t.channel,instance]);
 await db.database.pool.query("INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'Synthetic upload',$3,$4,ARRAY['media:upload'])",[key,t.org,randomUUID(),'d'.repeat(64)]);
 return {...t,instance,key};
}
function identity(t:Tenant,key=randomUUID(),input=file,idempotencyKey=randomUUID()):MediaUploadIdentity {
 return {uploadKind:'PARTNER',apiKeyId:key,idempotencyKey,sha256:createHash('sha256').update(input.bytes).digest('hex'),requestHash:partnerMediaUploadRequestHash(t.org,t.channel,key,input)};
}
const row=async(id:string)=>(await db.database.pool.query('SELECT * FROM messaging_media WHERE id=$1',[id])).rows[0]!;
function inline(maxStorageBytes=1024){return createMediaStore({encryptionKey,maxStorageBytes,transact:db.transact,download:async()=>{throw new Error('UPLOAD must never download a provider');}});}

it('stores partner bytes inline, retains identity after key deletion and preserves automation uploads',async()=>{
 const t=await seedAttendanceTenant(db.database,false),store=inline(),key=randomUUID(),partner=identity(t,key);
 await db.database.pool.query("INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'Synthetic',$3,$4,ARRAY['media:upload'])",[key,t.org,randomUUID(),'a'.repeat(64)]);
 const id=await store.writeUpload(t.org,t.channel,partner,file);
 expect(await store.writeUpload(t.org,t.channel,partner,file)).toBe(id);
 expect(await row(id)).toMatchObject({source:'UPLOAD',source_key:`partner:${key}:${partner.idempotencyKey}`,status:'READY',byte_size:file.bytes.length});
 expect(await store.read(t.org,id)).toEqual(file);
 await db.database.pool.query('DELETE FROM api_keys WHERE id=$1',[key]);
 expect((await row(id)).descriptor).toMatchObject({apiKeyId:key,uploadKind:'PARTNER',mimeType:'text/plain',byteSize:file.bytes.length});
 const legacy=await store.writeUpload(t.org,t.channel,{rootAutomationId:t.automation,idempotencyKey:randomUUID()},file);
 expect(await store.read(t.org,legacy)).toEqual(file);
});

it.each([
 ['name',{...file,fileName:'changed.txt'}],
 ['bytes',{...file,bytes:new TextEncoder().encode('Different synthetic upload')}],
])('rejects changed %s on a partner replay without replacing the stored bytes',async(_label,changed)=>{
 const t=await seedAttendanceTenant(db.database,false),store=inline(),first=identity(t),id=await store.writeUpload(t.org,t.channel,first,file);
 const replay=identity(t,'apiKeyId' in first?first.apiKeyId:'',changed,first.idempotencyKey);
 await expect(store.writeUpload(t.org,t.channel,replay,changed)).rejects.toMatchObject({code:'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT'});
 expect(await store.read(t.org,id)).toEqual(file);
});

it('serializes concurrent partner uploads under the shared inline quota',async()=>{
 const t=await seedAttendanceTenant(db.database,false),store=inline(file.bytes.length),results=await Promise.allSettled([
  store.writeUpload(t.org,t.channel,identity(t),file),store.writeUpload(t.org,t.channel,identity(t),file),
 ]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toMatchObject([{reason:{code:'MEDIA_STORAGE_LIMIT'}}]);
 expect((await db.database.pool.query("SELECT sum(byte_size)::integer AS bytes FROM messaging_media WHERE organization_id=$1 AND status='READY'",[t.org])).rows[0]).toEqual({bytes:file.bytes.length});
});

it('preserves an uncertain partner PUT across replay and restart without duplicate quota or provider download',async()=>{
 const t=await partnerTenant(),bytes=new Map<string,Uint8Array>(),actions:string[]=[];
 const binding=createS3PrivateObjectStore({endpoint:'https://objects.example.test',bucket:'broker-private',region:'us-east-1',profile:'private-v1',accessKeyId:'SYNTHETICACCESS',secretAccessKey:'synthetic-only',dedicatedBucket:true});
 const objectStore:PrivateObjectStore={destinationFingerprint:binding.destinationFingerprint,
  async put(ref,body){actions.push('PUT');bytes.set(ref.operationId,new Uint8Array(body));return {outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'};},
  async inspect(ref){actions.push('INSPECT');const body=bytes.get(ref.operationId)!;return {outcome:'CONFIRMED',byteLength:body.length,sha256:createHash('sha256').update(body).digest('hex')};},
  async read(ref){actions.push('GET');return {outcome:'CONFIRMED',bytes:bytes.get(ref.operationId)!};},
  async remove(){throw new Error('No deletion in upload flow');}};
 const privateStore=createDurablePrivateMediaStore({encryptionKey,profile:'private-v1',objectStore,maxStorageBytes:file.bytes.length,requestTimeoutMs:1000,transact:db.transact,cleanupTransact:async()=>{throw new Error('No cleanup');}});
 const create=()=>createMediaStore({encryptionKey,transact:db.transact,privateStore,download:async()=>{throw new Error('No provider download');}}),partner=identity(t,t.key),store=create();
 const id=await store.writeUpload(t.org,t.channel,partner,file);
 expect(await row(id)).toMatchObject({status:'STORING',storage_backend:'PRIVATE_OBJECT'});
 expect(await create().writeUpload(t.org,t.channel,partner,file)).toBe(id);
 expect(actions).toEqual(['PUT']);
 expect((await db.database.pool.query('SELECT count(*)::integer AS count,sum(reserved_bytes)::integer AS bytes FROM media_private_objects WHERE organization_id=$1',[t.org])).rows[0]).toEqual({count:1,bytes:file.bytes.length});
 await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[t.key]);
 await create().runOnce(t.org);
 expect(await create().read(t.org,id)).toEqual(file);
 expect(actions).toEqual(['PUT','INSPECT','GET']);
});

function preparedPrivateHarness(){
 const actions:string[]=[],bodies=new Map<string,Uint8Array>();
 const binding=createS3PrivateObjectStore({endpoint:'https://objects.example.test',bucket:'broker-private',region:'us-east-1',profile:'private-v1',accessKeyId:'SYNTHETICACCESS',secretAccessKey:'synthetic-only',dedicatedBucket:true});
 const objectStore:PrivateObjectStore={destinationFingerprint:binding.destinationFingerprint,
  async put(ref,body){actions.push('PUT');bodies.set(ref.operationId,new Uint8Array(body));return {outcome:'CONFIRMED'};},
  async inspect(){actions.push('INSPECT');return {outcome:'MISSING'};},
  async read(ref){actions.push('GET');return {outcome:'CONFIRMED',bytes:bodies.get(ref.operationId)!};},
  async remove(){throw new Error('No cleanup');}};
 const create=(transact:PrivateMediaTransaction=db.transact)=>createDurablePrivateMediaStore({encryptionKey,profile:'private-v1',objectStore,maxStorageBytes:1024,requestTimeoutMs:1000,transact,cleanupTransact:async()=>{throw new Error('No cleanup');}});
 return {create,actions};
}
async function stagedPartner(t:Awaited<ReturnType<typeof partnerTenant>>,store:ReturnType<typeof preparedPrivateHarness>['create']){
 const partner=identity(t,t.key),id=await db.transact(t.org,tx=>registerPendingMedia(tx,t.org,t.channel,
  {source:'UPLOAD',sourceKey:`partner:${t.key}:${partner.idempotencyKey}`,kind:file.kind,fileName:file.fileName,descriptor:{...partner,mimeType:file.mimeType,byteSize:file.bytes.length}}));
 return {id,...await store().stage(t.org,id,file)};
}
it.each([
 ['revoked','UPDATE api_keys SET revoked_at=now() WHERE id=$1'],
 ['expired',"UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"],
 ['upload scope removed',"UPDATE api_keys SET scopes=ARRAY['messaging:read'] WHERE id=$1"],
 ['deleted','DELETE FROM api_keys WHERE id=$1'],
])('a restarted durable worker rejects PREPARED upload with %s original key and performs no PUT',async(_label,mutation)=>{
 const t=await partnerTenant(),h=preparedPrivateHarness(),staged=await stagedPartner(t,h.create);
 await db.database.pool.query(mutation,[t.key]);
 expect(await h.create().runOnce(t.org)).toBe(true);expect(h.actions).toEqual([]);
 expect((await db.database.pool.query("SELECT state,dispatched_at,last_error_code FROM media_private_operations WHERE object_id=$1 AND kind='PUT'",[staged.objectId])).rows[0]).toMatchObject({state:'REJECTED',dispatched_at:null,last_error_code:'PARTNER_CREDENTIAL_REVOKED'});
 expect((await db.database.pool.query('SELECT state,reserved_bytes,staging_ciphertext FROM media_private_objects WHERE id=$1',[staged.objectId])).rows[0]).toEqual({state:'REJECTED',reserved_bytes:0,staging_ciphertext:null});
 expect(await row(staged.id)).toMatchObject({status:'FAILED',last_error:'PARTNER_CREDENTIAL_REVOKED'});
});
it('keeps READY bytes readable through a current rotated key after revoking the original uploader',async()=>{
 const t=await partnerTenant(),h=preparedPrivateHarness(),staged=await stagedPartner(t,h.create),rotated=randomUUID();
 expect(await h.create().dispatchPut(t.org,staged.objectId)).toBe('CONFIRMED');
 await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[t.key]);
 await db.database.pool.query("INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'Synthetic rotated',$3,$4,ARRAY['media:upload'])",[rotated,t.org,randomUUID(),'e'.repeat(64)]);
 expect(await h.create().read(t.org,staged.id,{authorize:tx=>requireCurrentPartnerKey(tx as TenantTransaction,t.org,rotated,['media:upload'])})).toEqual(file);
 expect(h.actions).toEqual(['PUT','GET']);
});
it.each([
 ['Meta',"UPDATE messaging_channels SET provider='META',instance_id=NULL,phone_number_id='synthetic-meta',waba_id='synthetic' WHERE organization_id=$1 AND id=$2"],
 ['central transport',"UPDATE messaging_channels SET transport='CENTRAL_TRANSPORT',provider=NULL,provider_account_id=NULL,instance_id=NULL,phone_number_id=NULL,waba_id=NULL,credential_reference=NULL WHERE organization_id=$1 AND id=$2"],
])('does not PUT a staged partner upload after its channel changes to %s',async(_label,mutation)=>{
 const t=await partnerTenant(),h=preparedPrivateHarness(),staged=await stagedPartner(t,h.create);
 await db.database.pool.query(mutation,[t.org,t.channel]);
 expect(await h.create().dispatchPut(t.org,staged.objectId)).toBe('REJECTED');expect(h.actions).toEqual([]);
 expect(await row(staged.id)).toMatchObject({status:'FAILED',last_error:'RESOURCE_DELETING'});
});

/** Prove an actual PostgreSQL lock wait before allowing wall-clock expiry.
 * The clock wait is derived from the database deadline, never used as a
 * substitute for the pg_blocking_pids synchronization barrier. */
async function expiresBehindLock<T>(t:Awaited<ReturnType<typeof partnerTenant>>,lockSql:string,lockValues:unknown[],work:(transact:PrivateMediaTransaction)=>Promise<T>){
 const holder=await db.database.pool.connect();let pending:Promise<{result?:T;error?:unknown}>|undefined;
 try{
  await holder.query('BEGIN');const holderPid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
  await db.database.pool.query("UPDATE api_keys SET expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",[t.key]);
  await holder.query(lockSql,lockValues);
  let announce!:(pid:number)=>void;const started=new Promise<number>(resolve=>{announce=resolve;});
  const transact:PrivateMediaTransaction=(org,callback)=>db.transact(org,async tx=>{
   await tx.query("SET LOCAL lock_timeout='15s'");announce(Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));return callback(tx);
  });
  pending=work(transact).then(result=>({result}),error=>({error}));
  const workerPid=await started;let blocked=false;
  for(let attempt=0;attempt<500&&!blocked;attempt++)blocked=(await db.database.pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[workerPid,holderPid])).rows[0]!.blocked;
  expect(blocked).toBe(true);
  expect((await db.database.pool.query('SELECT expires_at>clock_timestamp() AS valid FROM api_keys WHERE id=$1',[t.key])).rows[0]!.valid).toBe(true);
  await db.database.pool.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM (expires_at-clock_timestamp())))+0.02) FROM api_keys WHERE id=$1',[t.key]);
  expect((await db.database.pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM api_keys WHERE id=$1',[t.key])).rows[0]!.expired).toBe(true);
  await holder.query('COMMIT');return await pending;
 }finally{await holder.query('ROLLBACK');holder.release();await pending;}
}
it('rejects a PREPARED PUT when the key expires during a proven media-row lock wait',async()=>{
 const t=await partnerTenant(),h=preparedPrivateHarness(),staged=await stagedPartner(t,h.create);
 expect(await expiresBehindLock(t,'SELECT id FROM messaging_media WHERE id=$1 FOR UPDATE',[staged.id],transact=>h.create(transact).dispatchPut(t.org,staged.objectId))).toEqual({result:'REJECTED'});
 expect(h.actions).toEqual([]);expect(await row(staged.id)).toMatchObject({status:'FAILED',last_error:'PARTNER_CREDENTIAL_REVOKED'});
});
it('SQL SENDING fence rejects expiry during a proven authorizing-key row lock wait',async()=>{
 const t=await partnerTenant(),id=await inline().writeUpload(t.org,t.channel,identity(t,t.key),file),message=randomUUID();
 await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:send','media:send','media:upload'] WHERE id=$1",[t.key]);
 await db.transact(t.org,tx=>tx.query("INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,authorizing_api_key_id) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR',$5::jsonb,'ACCEPTED',$6)",[message,t.org,t.channel,t.conversation,JSON.stringify({type:'MEDIA',mediaId:id,kind:file.kind,fileName:file.fileName}),t.key]));
 expect(await expiresBehindLock(t,'SELECT id FROM api_keys WHERE id=$1 FOR UPDATE',[t.key],transact=>transact(t.org,tx=>tx.query("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1 AND id=$2",[t.org,message])))).toMatchObject({error:{code:'42501',message:'PARTNER_CREDENTIAL_REVOKED'}});
 expect((await db.database.pool.query('SELECT state FROM messaging_messages WHERE id=$1',[message])).rows[0]).toEqual({state:'ACCEPTED'});
});

it.each([
 {},{uploadKind:'PARTNER'},{uploadKind:'PARTNER',apiKeyId:randomUUID(),idempotencyKey:randomUUID(),sha256:'a'.repeat(64)},
 {uploadKind:'PARTNER',apiKeyId:null,idempotencyKey:randomUUID(),sha256:'a'.repeat(64),requestHash:'b'.repeat(64)},
 {uploadKind:'PARTNER',rootAutomationId:randomUUID(),idempotencyKey:randomUUID(),sha256:'a'.repeat(64)},
])('fails closed on incomplete partner upload identity %#',async descriptor=>{
 const t=await seedAttendanceTenant(db.database,false);
 await expect(db.transact(t.org,tx=>tx.query("INSERT INTO messaging_media(organization_id,channel_id,source,source_key,kind,file_name,descriptor) VALUES($1,$2,'UPLOAD',$3,'document','fixture.txt',$4::jsonb)",[t.org,t.channel,randomUUID(),JSON.stringify(descriptor)]))).rejects.toMatchObject({code:'23514',constraint:'messaging_media_upload_identity'});
});

it('requires both media send scopes at the SQL boundary including SENDING to SENDING, preserving text and legacy messages',async()=>{
 const t=await seedAttendanceTenant(db.database,false),key=randomUUID(),media=randomUUID(),text=randomUUID(),legacy=randomUUID();
 const mediaId=await inline().writeUpload(t.org,t.channel,identity(t),file);
 await db.database.pool.query("INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'Synthetic',$3,$4,ARRAY['messaging:send','media:send'])",[key,t.org,randomUUID(),'b'.repeat(64)]);
 for(const [id,content,authority] of [[media,{type:'MEDIA',mediaId,kind:'document',fileName:'fixture.txt',mimeType:'text/plain'},key],[text,{type:'TEXT',text:'Synthetic'},key],[legacy,{type:'TEXT',text:'Legacy'},null]] as const){
  await db.transact(t.org,tx=>tx.query("INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,authorizing_api_key_id) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR',$5::jsonb,'ACCEPTED',$6)",[id,t.org,t.channel,t.conversation,JSON.stringify(content),authority]));
 }
 const sending=(id:string)=>db.transact(t.org,tx=>tx.query("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1 AND id=$2 RETURNING state",[t.org,id]));
 expect((await sending(media)).rows[0]).toEqual({state:'SENDING'});
 await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:send'] WHERE id=$1",[key]);
 await expect(sending(media)).rejects.toMatchObject({code:'42501',message:'PARTNER_CREDENTIAL_REVOKED'});
 expect((await sending(text)).rows[0]).toEqual({state:'SENDING'});expect((await sending(legacy)).rows[0]).toEqual({state:'SENDING'});
});

it('readiness rejects a media fence reverted to the text-only body even with intact trigger and ACLs',async()=>{
 const client=await db.database.pool.connect();
 try{await client.query('BEGIN');await client.query(`CREATE OR REPLACE FUNCTION partner_require_message_authority() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF NEW.state<>'SENDING' OR NEW.authorizing_api_key_id IS NULL THEN RETURN NEW; END IF; PERFORM id FROM public.api_keys WHERE organization_id=NEW.organization_id AND id=NEW.authorizing_api_key_id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND scopes @> ARRAY['messaging:send']::text[] FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'PARTNER_CREDENTIAL_REVOKED' USING ERRCODE='42501'; END IF; RETURN NEW; END $$`);
  await client.query('SET LOCAL ROLE jrc_app');expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
 }finally{await client.query('ROLLBACK');client.release();}
});

it.each([
 "ALTER TABLE messaging_media DROP CONSTRAINT messaging_media_upload_identity; ALTER TABLE messaging_media ADD CONSTRAINT messaging_media_upload_identity CHECK(true)",
 "GRANT EXECUTE ON FUNCTION partner_media_upload_identity_valid(jsonb,text) TO PUBLIC",
 "CREATE OR REPLACE FUNCTION partner_media_upload_identity_valid(identity jsonb,source_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT true $$",
])('readiness rejects weakened partner upload integrity: %s',async change=>{
 const client=await db.database.pool.connect();try{await client.query('BEGIN');await client.query(change);await client.query('SET LOCAL ROLE jrc_app');expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);}finally{await client.query('ROLLBACK');client.release();}
});
