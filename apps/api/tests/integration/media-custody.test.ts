import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createMediaCustodyService} from '../../src/modules/media-custody/service.js';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {requireExclusiveLab} from './helpers/exclusive-lab.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
// This suite changes global roles through the common fixture: a disposable,
// exclusive cluster is required, not merely a fresh DB in a shared cluster.
beforeAll(async()=>{
 const raw=process.env.TEST_DATABASE_ADMIN_URL;
 requireExclusiveLab(raw,process.env.TEST_MEDIA_CUSTODY_EXCLUSIVE_CLUSTER,'MEDIA_CUSTODY');
 db=await attendanceDatabase();
 // The authoring task deliberately leaves journal integration to the owner.
 // Apply the prepared migration only when not already included by that journal.
 if(!(await db.database.pool.query("SELECT to_regclass('public.media_custody_receipts') AS name")).rows[0]!.name){
  const migration=await readFile(new URL('../../drizzle/migrations/0075_media_custody.sql',import.meta.url),'utf8');
  await withGlobalRoleLock(raw,()=>db.database.pool.query(migration).then(()=>{}));
 }
},60_000);
afterAll(async()=>{await db?.dispose();});
const bytes=Buffer.from('synthetic durable media');
const hash=createHash('sha256').update(bytes).digest('hex');
const service=()=>createMediaCustodyService({transact:db.transact});
async function fixture(){
 const t=await seedAttendanceTenant(db.database,false),key=randomUUID(),media=randomUUID(),message=randomUUID(),endpoint=randomUUID();
 await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes)
  VALUES($1,$2,'Synthetic archive',$3,$4,ARRAY['media:archive'])`,[key,t.org,randomUUID(),'c'.repeat(64)]);
 await db.database.pool.query(`INSERT INTO partner_webhook_endpoints(organization_id,id,url,idempotency_key,encrypted_secret)
  VALUES($1,$2,'https://synthetic.example.test/hook',$3,'synthetic-encrypted')`,[t.org,endpoint,randomUUID()]);
 await db.database.pool.query(`INSERT INTO messaging_media(organization_id,id,channel_id,source,source_key,kind,file_name,mime_type,descriptor,status,encrypted_data,byte_size,sha256)
  VALUES($1,$2,$3,'META',$4,'document','synthetic.txt','text/plain','{}','READY','synthetic-encrypted',$5,$6)`,[t.org,media,t.channel,randomUUID(),bytes.length,hash]);
 await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,id,channel_id,conversation_id,direction,source,content,state)
  VALUES($1,$2,$3,$4,'INCOMING','CONTACT',$5,'ACCEPTED')`,[t.org,message,t.channel,t.conversation,JSON.stringify({type:'MEDIA',mediaId:media,kind:'document',fileName:'synthetic.txt'})]);
 const input={schemaVersion:1 as const,channelId:t.channel,messageId:message,mediaId:media,endpointId:endpoint,destinationVersion:1 as const,clientReceiptId:randomUUID(),byteSize:bytes.length,sha256:hash,storageObjectId:'synthetic/attachment',attestation:'DURABLY_STORED' as const};
 return {...t,key,media,message,endpoint,input};
}
it('serializes concurrent replay, survives lost response/key rotation and preserves bytes/KEEP',async()=>{
 const t=await fixture(),idempotency=randomUUID();
 const results=await Promise.all(Array.from({length:4},()=>service().record(t.org,t.key,t.input,idempotency)));
 expect(new Set(results.map(r=>r.receipt.id)).size).toBe(1);expect(results.filter(r=>!r.replayed)).toHaveLength(1);
 const rotated=randomUUID();await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'Rotated synthetic',$3,$4,ARRAY['media:archive'])`,[rotated,t.org,randomUUID(),'d'.repeat(64)]);
 await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[t.key]);
 expect((await service().record(t.org,rotated,t.input,idempotency)).receipt).toEqual(results[0]!.receipt);
 expect(await service().evaluate(t.org,rotated,results[0]!.receipt.id)).toMatchObject({policy:'KEEP',eligibleForDeletion:false,physicalStorageVerified:false});
 expect((await db.database.pool.query('SELECT status,encrypted_data FROM messaging_media WHERE id=$1',[t.media])).rows[0]).toEqual({status:'READY',encrypted_data:'synthetic-encrypted'});
});
it('isolates tenant reads and rejects real unrelated message/media/channel associations',async()=>{
 const t=await fixture(),other=await fixture(),accepted=await service().record(t.org,t.key,t.input,randomUUID());
 expect((await db.transact(other.org,tx=>tx.query('SELECT id FROM media_custody_receipts'))).rows).toEqual([]);
 await expect(service().get(other.org,other.key,accepted.receipt.id)).rejects.toMatchObject({code:'MEDIA_CUSTODY_NOT_FOUND'});
 for(const change of [{channelId:other.channel},{messageId:other.message},{mediaId:other.media},{channelId:other.channel,messageId:other.message,mediaId:other.media}]){
  await expect(service().record(t.org,t.key,{...t.input,...change},randomUUID())).rejects.toMatchObject({code:'MEDIA_REFERENCE_NOT_FOUND'});
 }
});
it('rejects changed identity, partial media, bad integrity, revocation and inactive endpoints',async()=>{
 const t=await fixture(),idempotency=randomUUID();await service().record(t.org,t.key,t.input,idempotency);
 await expect(service().record(t.org,t.key,{...t.input,storageObjectId:'changed'},idempotency)).rejects.toMatchObject({code:'MEDIA_CUSTODY_CONFLICT'});
 await expect(service().record(t.org,t.key,{...t.input,sha256:'e'.repeat(64)},randomUUID())).rejects.toMatchObject({code:'MEDIA_CUSTODY_INTEGRITY_MISMATCH'});
 const partial=await fixture();await db.database.pool.query("UPDATE messaging_media SET status='PENDING',encrypted_data=NULL WHERE id=$1",[partial.media]);
 await expect(service().record(partial.org,partial.key,partial.input,randomUUID())).rejects.toMatchObject({code:'MEDIA_NOT_READY'});
 await db.database.pool.query("UPDATE partner_webhook_endpoints SET status='REVOKED',encrypted_secret=NULL,revoked_at=now() WHERE id=$1",[t.endpoint]);
 await expect(service().record(t.org,t.key,t.input,idempotency)).rejects.toMatchObject({code:'MEDIA_DESTINATION_NOT_ACTIVE'});
 await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[partial.key]);
 await expect(service().record(partial.org,partial.key,partial.input,randomUUID())).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
});
it('prevents app UPDATE/DELETE and prevents changing an attachment after its receipt',async()=>{
 const t=await fixture(),accepted=await service().record(t.org,t.key,t.input,randomUUID());
 for(const statement of ['UPDATE media_custody_receipts SET byte_size=1 WHERE id=$1','DELETE FROM media_custody_receipts WHERE id=$1']){
  await expect(db.transact(t.org,tx=>tx.query(statement,[accepted.receipt.id]))).rejects.toMatchObject({code:'42501'});
 }
 await expect(db.database.pool.query(`UPDATE messaging_messages SET content='{"type":"TEXT","text":"changed"}'::jsonb WHERE id=$1`,[t.message])).rejects.toMatchObject({code:'23503'});
});
it('keeps receipts specific to each real message reference when several messages share media',async()=>{
 const t=await fixture(),second=randomUUID();
 await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,id,channel_id,conversation_id,direction,source,content,state)
  VALUES($1,$2,$3,$4,'INCOMING','CONTACT',$5,'ACCEPTED')`,[t.org,second,t.channel,t.conversation,JSON.stringify({type:'MEDIA',mediaId:t.media,kind:'document',fileName:'synthetic.txt'})]);
 const first=await service().record(t.org,t.key,t.input,randomUUID());
 const next=await service().record(t.org,t.key,{...t.input,messageId:second,clientReceiptId:randomUUID()},randomUUID());
 expect(next.receipt.id).not.toBe(first.receipt.id);expect(next.receipt.mediaId).toBe(first.receipt.mediaId);
 expect(await service().evaluate(t.org,t.key,first.receipt.id)).toMatchObject({eligibleForDeletion:false});
});
it('enforces integrity/credential/lifecycle fences at direct SQL insertion too',async()=>{
 const t=await fixture();
 const insert=(sha256=hash)=>db.transact(t.org,tx=>tx.query(`INSERT INTO media_custody_receipts(organization_id,authorizing_api_key_id,idempotency_key,request_hash,channel_id,message_id,media_id,endpoint_id,destination_version,client_receipt_id,byte_size,sha256,storage_object_id,attestation)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,'synthetic/asset','DURABLY_STORED')`,[t.org,t.key,randomUUID(),'a'.repeat(64),t.channel,t.message,t.media,t.endpoint,randomUUID(),bytes.length,sha256]));
 await expect(insert('e'.repeat(64))).rejects.toMatchObject({code:'23514'});
 await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:read'] WHERE id=$1",[t.key]);
 await expect(insert()).rejects.toMatchObject({code:'42501'});
 await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['media:archive'] WHERE id=$1",[t.key]);
 await db.database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE id=$1',[t.channel]);
 await expect(insert()).rejects.toMatchObject({code:'23514',constraint:'channel_deletion_in_progress'});
});
it('rechecks wall-clock expiry after waiting on a locked message',async()=>{
 const t=await fixture(),blocker=await db.database.pool.connect();
 const expiry=(await db.database.pool.query("UPDATE api_keys SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at",[t.key])).rows[0]!.expires_at;
 let pending:Promise<unknown>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM messaging_messages WHERE id=$1 FOR UPDATE',[t.message]);
  pending=service().record(t.org,t.key,t.input,randomUUID()).then(()=>({accepted:true}),error=>error);
  const deadline=Date.now()+5000;let waiting=false;
  while(Date.now()<deadline){
   waiting=(await db.database.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF m, a%') AS waiting")).rows[0]!.waiting;
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waiting).toBe(true);
  while(!(await db.database.pool.query('SELECT clock_timestamp()>$1::timestamptz AS expired',[expiry])).rows[0]!.expired)await new Promise(resolve=>setTimeout(resolve,20));
  await blocker.query('COMMIT');expect(await pending).toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM media_custody_receipts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});
