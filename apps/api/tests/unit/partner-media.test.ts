import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createPartnerMediaService } from '../../src/modules/messaging/partner-media.js';
import { assertPartnerMessageAuthority, requireCurrentPartnerKey } from '../../src/modules/messaging/partner-authority.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import type { MediaStore } from '../../src/modules/messaging/media-store.js';

const org=randomUUID(), channel=randomUUID(), key=randomUUID(), mediaId=randomUUID(), conversation=randomUUID();
const file={bytes:new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex')),mimeType:'image/png',kind:'image' as const,fileName:'synthetic.png'};
function harness() {
 const state={scopes:['media:upload','media:send','messaging:send'],expiresDuringChannelLock:false,expiresDuringEnqueue:false,expired:false,open:true,archived:false,active:true,status:'READY',channel:{id:channel,organizationId:org,provider:'BAILEYS',transport:'BROKER_TRANSPORT'},row:{id:mediaId,channelId:channel,status:'READY',kind:'image',fileName:file.fileName,mimeType:file.mimeType,byteSize:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex')},message:{authorizingApiKeyId:key,contentType:'MEDIA',channelId:channel}};
 const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
  if(sql.includes('tenant_is_active'))return {rows:[{active:state.active}]};
  if(sql.includes('FROM api_keys'))return {rows:(!state.expired||!sql.includes('clock_timestamp()'))&&(params[2] as string[]??[]).every(scope=>state.scopes.includes(scope))?[{id:key}]:[]};
  if(sql.toLowerCase().includes('from messaging_channels')&&sql.toLowerCase().includes('for ')){if(state.expiresDuringChannelLock)state.expired=true;return {rows:[{id:channel}],rowCount:1};}
  if(sql.includes('media_private_channel_open'))return {rows:[{open:state.open,archived:state.archived}]};
  if(sql.includes('for no key update'))return {rows:[{id:channel}],rowCount:1};
  if(sql.includes('FROM messaging_media'))return {rows:params[2]===mediaId?[{...state.row,status:state.status}]:[]};
  if(sql.includes('authorizing_api_key_id AS'))return {rows:[state.message]};
  return {rows:[]};
 });
 const tx={query} as unknown as TenantTransaction;
 const repository={findChannel:async()=>state.channel,findConversation:async()=>({id:conversation,channelId:channel,organizationId:org}),setConversationMode:vi.fn(),enqueueOutgoing:vi.fn(async(_tx,input)=>{if(state.expiresDuringEnqueue)state.expired=true;return {message:{id:randomUUID(),direction:'OUTGOING',state:'ACCEPTED',...input}};})} as unknown as MessagingRepository;
 const media={writeUpload:vi.fn(async(_org,_channel,_identity,_file,control)=>{await control.authorize(tx);return mediaId;})} as unknown as MediaStore;
 const service=createPartnerMediaService({repository,media,transact:async(_org,work)=>work(tx)});
 return {state,tx,repository,media,service};
}
it('returns sanitized upload integrity without storage identities and checks authority again after I/O',async()=>{
 const h=harness();
 expect(await h.service.upload(org,channel,{...file,idempotencyKey:randomUUID()},key)).toEqual(h.state.row);
 (h.media.writeUpload as ReturnType<typeof vi.fn>).mockImplementationOnce(async()=>{h.state.scopes=[];return mediaId;});
 await expect(h.service.upload(org,channel,{...file,idempotencyKey:randomUUID()},key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
});
it.each([[['media:send']], [['messaging:send']]])('refuses incomplete send scopes %j before creating outbox effects',async scopes=>{
 const h=harness();h.state.scopes=scopes;
 await expect(h.service.send(org,channel,{conversationId:conversation,mediaId},randomUUID(),key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
 expect(h.repository.enqueueOutgoing).not.toHaveBeenCalled();
});
it.each(['STORING','FAILED'])('refuses %s references without changing attendance',async status=>{
 const h=harness();h.state.status=status;
 await expect(h.service.send(org,channel,{conversationId:conversation,mediaId},randomUUID(),key)).rejects.toMatchObject({code:'MEDIA_NOT_READY'});
 expect(h.repository.setConversationMode).not.toHaveBeenCalled();
});
it('derives canonical send content from the stored reference',async()=>{
 const h=harness();const result=await h.service.send(org,channel,{conversationId:conversation,mediaId,caption:'Synthetic caption'},randomUUID(),key);
 expect(result).toMatchObject({conversationId:conversation,state:'ACCEPTED',media:{id:mediaId,kind:'image',fileName:file.fileName},text:'Synthetic caption'});
 const stored=(h.repository.enqueueOutgoing as ReturnType<typeof vi.fn>).mock.calls[0]![1];
 expect(stored.content).toEqual({type:'MEDIA',mediaId,kind:'image',fileName:file.fileName,caption:'Synthetic caption'});
 expect(stored.authorizingApiKeyId).toBe(key);
});
it('gets metadata without reading or writing bytes and fences closed channels',async()=>{
 const h=harness();expect(await h.service.get(org,channel,mediaId,key)).toEqual(h.state.row);
 expect(h.media.writeUpload).not.toHaveBeenCalled();h.state.open=false;
 await expect(h.service.get(org,channel,mediaId,key)).rejects.toMatchObject({code:'RESOURCE_DELETING'});
});
it('requires both scopes only for partner MEDIA and preserves legacy authority',async()=>{
 const h=harness();h.state.scopes=['messaging:send'];
 await expect(assertPartnerMessageAuthority(h.tx,org,randomUUID())).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
 h.state.message.contentType='TEXT';await expect(assertPartnerMessageAuthority(h.tx,org,randomUUID())).resolves.toBeUndefined();
 h.state.message.authorizingApiKeyId=null as unknown as string;await expect(assertPartnerMessageAuthority(h.tx,org,randomUUID())).resolves.toBeUndefined();
 await expect(requireCurrentPartnerKey(h.tx,org,key,['media:upload'])).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
});
it('refuses archived instances even when the legacy private-media lifecycle helper reports open',async()=>{
 const h=harness();h.state.archived=true;
 await expect(h.service.get(org,channel,mediaId,key)).rejects.toMatchObject({code:'CHANNEL_ARCHIVED'});
 await expect(assertPartnerMessageAuthority(h.tx,org,randomUUID())).rejects.toMatchObject({code:'CHANNEL_ARCHIVED'});
});
it('does not return upload metadata when its key expires while waiting for the channel lock',async()=>{
 const h=harness();h.state.expiresDuringChannelLock=true;
 await expect(h.service.get(org,channel,mediaId,key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
});
it('rechecks a queued partner MEDIA key after the channel lock before authorizing its physical effect',async()=>{
 const h=harness();h.state.expiresDuringChannelLock=true;
 await expect(assertPartnerMessageAuthority(h.tx,org,randomUUID())).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
});
it('refuses an admitted media result if the key expires while later outbox locks are acquired',async()=>{
 const h=harness();h.state.expiresDuringEnqueue=true;
 await expect(h.service.send(org,channel,{conversationId:conversation,mediaId},randomUUID(),key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
});
