import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createPartnerMediaService} from '../../src/modules/messaging/partner-media.js';
import {assertPartnerMessageAuthority} from '../../src/modules/messaging/partner-authority.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {createPartnerTextSender} from '../../src/modules/messaging/partner-text.js';
import {dispatchClaim} from '../../src/modules/messaging/dispatcher.js';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const repository=createPostgresMessagingRepository();
const file={bytes:new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex')),mimeType:'image/png',kind:'image' as const,fileName:'synthetic.png'};
const store=()=>createMediaStore({encryptionKey:Buffer.alloc(32,7).toString('base64'),transact:db.transact,download:async()=>{throw Error('UPLOAD_MUST_NOT_DOWNLOAD');}});
const service=()=>createPartnerMediaService({repository,media:store(),transact:db.transact});
beforeAll(async()=>{db=await attendanceDatabase();},60_000);
afterAll(async()=>{await db?.dispose();});
async function tenant(scopes=['messaging:send','media:send','media:upload']) {
 const t=await seedAttendanceTenant(db.database,false),key=randomUUID(),instance=randomUUID();
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
 await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
  VALUES($1,$2,$3,$4,$4,'CONNECTED')`,[instance,t.org,provider,randomUUID()]);
 await db.database.pool.query(`UPDATE messaging_channels SET provider='BAILEYS',instance_id=$3,phone_number_id=NULL,waba_id=NULL
  WHERE organization_id=$1 AND id=$2`,[t.org,t.channel,instance]);
 await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes)
  VALUES($1,$2,'Synthetic media partner',$3,$4,$5)`,[key,t.org,randomUUID(),'c'.repeat(64),scopes]);
 return {...t,key,instance,provider};
}
const upload=(t:Awaited<ReturnType<typeof tenant>>)=>service().upload(t.org,t.channel,{...file,idempotencyKey:randomUUID()},t.key);

it('admits one canonical media message under concurrent requests and preserves UNKNOWN on replay',async()=>{
 const t=await tenant(),asset=await upload(t),idempotencyKey=randomUUID(),input={conversationId:t.conversation,mediaId:asset.id,caption:'Synthetic caption'};
 const results=await Promise.all(Array.from({length:4},()=>service().send(t.org,t.channel,input,idempotencyKey,t.key)));
 expect(new Set(results.map(result=>result.id)).size).toBe(1);
 const row=(await db.database.pool.query(`SELECT content,authorizing_api_key_id,
  (SELECT count(*)::int FROM messaging_outbox WHERE message_id=m.id) AS queued FROM messaging_messages m WHERE id=$1`,[results[0]!.id])).rows[0]!;
 expect(row).toMatchObject({authorizing_api_key_id:t.key,queued:1,content:{type:'MEDIA',mediaId:asset.id,fileName:file.fileName,kind:'image',caption:input.caption}});
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0]?.mode).toBe('HUMAN');
 await db.database.pool.query("UPDATE messaging_messages SET state='UNKNOWN',canonical_error_code='SYNTHETIC_ACK_LOST' WHERE id=$1",[results[0]!.id]);
 expect(await service().send(t.org,t.channel,input,idempotencyKey,t.key)).toMatchObject({id:results[0]!.id,state:'UNKNOWN'});
 await expect(service().send(t.org,t.channel,{...input,caption:'Changed'},idempotencyKey,t.key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('separates the media namespace from partner text and supports same-tenant channel-scoped key rotation',async()=>{
 const t=await tenant(),asset=await upload(t),idempotencyKey=randomUUID();
 const text=await createPartnerTextSender({repository,transact:db.transact})(t.org,t.channel,{conversationId:t.conversation,text:'Synthetic text'},idempotencyKey,t.key);
 const next=randomUUID();await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes)
  VALUES($1,$2,'Synthetic rotated partner',$3,$4,ARRAY['messaging:send','media:send','media:upload'])`,[next,t.org,randomUUID(),'d'.repeat(64)]);
 await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[t.key]);
 expect(await service().get(t.org,t.channel,asset.id,next)).toEqual(asset);
 const media=await service().send(t.org,t.channel,{phoneNumber:'+12025550123',mediaId:asset.id},idempotencyKey,next);
 expect(media.id).not.toBe(text.id);expect(media.conversationId).toBeTruthy();
});
it.each([['messaging:send'],['media:send']])('requires the complete current send grant: %j',async scope=>{
 const t=await tenant(),asset=await upload(t);
 await db.database.pool.query('UPDATE api_keys SET scopes=$2 WHERE id=$1',[t.key,[scope]]);
 await expect(service().send(t.org,t.channel,{conversationId:t.conversation,mediaId:asset.id},randomUUID(),t.key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
 expect((await db.database.pool.query('SELECT count(*)::int AS count FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0]?.count).toBe(0);
});
it('refuses foreign and other-channel media without creating an outbox row',async()=>{
 const t=await tenant(),foreign=await tenant(),asset=await upload(t),foreignAsset=await upload(foreign);
 await expect(service().send(t.org,t.channel,{conversationId:t.conversation,mediaId:foreignAsset.id},randomUUID(),t.key)).rejects.toMatchObject({code:'MEDIA_NOT_FOUND'});
 await expect(service().send(t.org,t.channel,{conversationId:foreign.conversation,mediaId:asset.id},randomUUID(),t.key)).rejects.toMatchObject({code:'CONVERSATION_NOT_FOUND'});
 const other=randomUUID(),instance=randomUUID();
 await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
  VALUES($1,$2,$3,$4,$4,'CONNECTED')`,[instance,t.org,t.provider,randomUUID()]);
 await db.database.pool.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference)
  VALUES($1,$2,$3,'BAILEYS',$4,'synthetic')`,[other,t.org,t.provider,instance]);
 // The channel is open but has no ownership of this reference.
 await expect(service().get(t.org,other,asset.id,t.key)).rejects.toMatchObject({code:'MEDIA_NOT_FOUND'});
});
it.each(['STORING','FAILED'])('requires READY before admission instead of %s',async status=>{
 const t=await tenant(),asset=await upload(t);
 // Inline non-READY cannot retain ciphertext under the existing storage CHECK.
 await db.database.pool.query('UPDATE messaging_media SET status=$2,encrypted_data=NULL WHERE id=$1',[asset.id,status==='STORING'?'PENDING':status]);
 await expect(service().send(t.org,t.channel,{conversationId:t.conversation,mediaId:asset.id},randomUUID(),t.key)).rejects.toMatchObject({code:'MEDIA_NOT_READY'});
});
it('revalidates media:send during read and blocks claim after admission without blocking text',async()=>{
 const t=await tenant(),asset=await upload(t),message=await service().send(t.org,t.channel,{conversationId:t.conversation,mediaId:asset.id},randomUUID(),t.key);
 const claims=await db.transact(t.org,tx=>repository.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:120_000,limit:1}));
 expect(claims).toHaveLength(1);
 let checks=0;
 await expect(store().read(t.org,asset.id,{authorize:async tx=>{
  if(++checks===2)await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:send','media:upload'] WHERE id=$1",[t.key]);
  await assertPartnerMessageAuthority(tx,t.org,message.id);
 }})).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
 expect(checks).toBe(2);
 expect(await db.transact(t.org,tx=>repository.validateClaim(tx,{organizationId:t.org,messageId:message.id,leaseToken:claims[0]!.leaseToken})))
  .toEqual({eligible:false,reason:'PARTNER_CREDENTIAL_REVOKED'});
 expect(await createPartnerTextSender({repository,transact:db.transact})(t.org,t.channel,{conversationId:t.conversation,text:'Still authorized text'},randomUUID(),t.key)).toMatchObject({state:'ACCEPTED'});
});

it.each(['media-scope','archive','deletion'] as const)('blocks the physical effect after bytes prepare when current %s authority changes before final validation',async change=>{
 const t=await tenant(),asset=await upload(t),message=await service().send(t.org,t.channel,{conversationId:t.conversation,mediaId:asset.id},randomUUID(),t.key);
 const [claim]=await db.transact(t.org,tx=>repository.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:120_000,limit:1}));
 expect(claim?.message.id).toBe(message.id);
 let effects=0;
 await dispatchClaim(claim!,{
  resolveClient:async()=>({sendText:async()=>{throw Error('UNEXPECTED_TEXT');},sendTemplate:async()=>{throw Error('UNEXPECTED_TEMPLATE');},listTemplates:async()=>[]}),
  prepareMedia:async()=>{
   await store().read(t.org,asset.id,{authorize:tx=>assertPartnerMessageAuthority(tx as import('../../src/db/tenant-transaction.js').TenantTransaction,t.org,message.id)});
   if(change==='media-scope')await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:send','media:upload'] WHERE id=$1",[t.key]);
   else if(change==='archive')await db.database.pool.query('UPDATE instances SET archived_at=now() WHERE id=$1',[t.instance]);
   else await db.database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE id=$1',[t.channel]);
   return async()=>{effects++;return {upstreamMessageId:'synthetic-unreachable'};};
  },
  validate:async()=>{
   const checked=await db.transact(t.org,tx=>repository.validateClaim(tx,{organizationId:t.org,messageId:message.id,leaseToken:claim!.leaseToken}));
   expect(checked).toEqual({eligible:false,reason:'PARTNER_CREDENTIAL_REVOKED'});return checked.eligible;
  },
  complete:async()=>{throw Error('BLOCKED_POLICY_MUST_NOT_COMPLETE_PROVIDER_EFFECT');},
 });
 expect(effects).toBe(0);
 expect((await db.database.pool.query('SELECT state,canonical_error_code FROM messaging_messages WHERE id=$1',[message.id])).rows[0])
  .toMatchObject({state:'FAILED',canonical_error_code:'PARTNER_CREDENTIAL_REVOKED'});
});
