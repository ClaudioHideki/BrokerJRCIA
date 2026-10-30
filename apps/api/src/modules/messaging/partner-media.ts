import {createHash,randomUUID} from 'node:crypto';
import {PartnerMediaRequestSchema,PartnerMediaMetadataSchema,type PartnerMediaRequest,type PartnerMediaMetadata,type MessageView} from '@jrc/contracts';
import type {BinaryMedia} from '@jrc/providers';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {MessagingRepository} from './repository.js';
import {partnerMediaUploadRequestHash,type MediaStore} from './media-store.js';
import {requireCurrentPartnerKey,recheckCurrentPartnerKey,requirePartnerMediaChannelOpen,partnerError} from './partner-authority.js';
import {requireActiveOrganization} from '../tenancy/operational-limits.js';
import {recordManualAttendanceTakeover} from '../attendance/manual-takeover.js';
import type {MediaMessageContent,Message} from './types.js';

function view(message:Pick<Message,'id'|'direction'|'state'|'content'>,conversationId:string):MessageView & {conversationId:string} {
 const content=message.content as MediaMessageContent;
 return {id:message.id,conversationId,direction:message.direction,state:message.state,text:content.caption||content.fileName,
   media:{id:content.mediaId,kind:content.kind,fileName:content.fileName}};
}
/** Public upload references have service authority, independent from automation roots. */
export function createPartnerMediaService(options:{repository:MessagingRepository;media:MediaStore;
 transact<T>(organizationId:string,operation:OrganizationTransaction<T>):Promise<T>}) {
 const {repository,media,transact}=options;
 async function authorize(tx:TenantTransaction,org:string,channelId:string,key:string,scopes:readonly string[],lock:'read'|'write'='read') {
  await requireActiveOrganization(tx,org);await requireCurrentPartnerKey(tx,org,key,scopes);
  const channel=await repository.findChannel(tx,org,channelId);
  if(!channel||channel.organizationId!==org)throw partnerError('CHANNEL_NOT_FOUND',404);
  if(channel.transport!=='BROKER_TRANSPORT')throw partnerError('BROKER_CHANNEL_REQUIRED',422);
  if(channel.provider!=='BAILEYS')throw partnerError('PARTNER_QR_CHANNEL_REQUIRED',422);
  await requirePartnerMediaChannelOpen(tx,org,channelId,lock);
  await recheckCurrentPartnerKey(tx,org,key,scopes);
 }
 async function metadata(tx:TenantTransaction,org:string,channelId:string,id:string):Promise<PartnerMediaMetadata> {
  const row=(await tx.query(`SELECT id,channel_id AS "channelId",
    CASE WHEN status='READY' THEN 'READY' WHEN status='FAILED' THEN 'FAILED' ELSE 'STORING' END AS status,
    kind,file_name AS "fileName",coalesce(mime_type,descriptor->>'mimeType') AS "mimeType",
    coalesce(byte_size,(descriptor->>'byteSize')::bigint)::int AS "byteSize",coalesce(sha256,descriptor->>'sha256') AS sha256,
    CASE WHEN status='FAILED' THEN 'MEDIA_UPLOAD_FAILED' ELSE NULL END AS "errorCode"
    FROM messaging_media WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND source='UPLOAD'
    AND descriptor->>'uploadKind'='PARTNER'`,[org,channelId,id])).rows[0];
  if(!row)throw partnerError('MEDIA_NOT_FOUND',404);
  const {errorCode,...metadata}=row;
  return PartnerMediaMetadataSchema.parse({...metadata,...(errorCode?{errorCode}:{})});
 }
 return {
  async upload(org:string,channelId:string,input:BinaryMedia&{idempotencyKey:string},apiKeyId:string):Promise<PartnerMediaMetadata> {
   await transact(org,tx=>authorize(tx,org,channelId,apiKeyId,['media:upload']));
   const id=await media.writeUpload(org,channelId,{uploadKind:'PARTNER',apiKeyId,idempotencyKey:input.idempotencyKey,
    sha256:createHash('sha256').update(input.bytes).digest('hex'),requestHash:partnerMediaUploadRequestHash(org,channelId,apiKeyId,input)},input,
    {authorize:tx=>authorize(tx as TenantTransaction,org,channelId,apiKeyId,['media:upload'])});
   return transact(org,async tx=>{await authorize(tx,org,channelId,apiKeyId,['media:upload']);return metadata(tx,org,channelId,id);});
  },
  async get(org:string,channelId:string,id:string,apiKeyId:string):Promise<PartnerMediaMetadata> {
   return transact(org,async tx=>{await authorize(tx,org,channelId,apiKeyId,['media:upload']);return metadata(tx,org,channelId,id);});
  },
  async send(org:string,channelId:string,raw:PartnerMediaRequest,idempotencyKey:string,apiKeyId:string):Promise<MessageView&{conversationId:string}> {
   const input=PartnerMediaRequestSchema.parse(raw);
   return transact(org,async tx=>{
    await authorize(tx,org,channelId,apiKeyId,['messaging:send','media:send'],'write');
    const key=`partner-media:${apiKeyId}:${idempotencyKey}`;
    const bodyHash=createHash('sha256').update(JSON.stringify({operation:'partner-media',apiKeyId,input})).digest('hex');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['partner-media',org,channelId,key])]);
    const existing=(await tx.query<{id:string;conversationId:string;state:Message['state'];bodyHash:string;content:MediaMessageContent}>(
     `SELECT id,conversation_id AS "conversationId",state,idempotency_body_hash AS "bodyHash",content FROM messaging_messages
      WHERE organization_id=$1 AND channel_id=$2 AND idempotency_key=$3`,[org,channelId,key])).rows[0];
    if(existing){if(existing.bodyHash!==bodyHash)throw partnerError('IDEMPOTENCY_CONFLICT',409);
     await recheckCurrentPartnerKey(tx,org,apiKeyId,['messaging:send','media:send']);
     return view({...existing,direction:'OUTGOING'},existing.conversationId);}
    const asset=await metadata(tx,org,channelId,input.mediaId);
    if(asset.status!=='READY')throw partnerError('MEDIA_NOT_READY',409);
    let conversationId:string;
    if('conversationId' in input){
     const conversation=await repository.findConversation(tx,org,input.conversationId);
     if(!conversation||conversation.organizationId!==org||conversation.channelId!==channelId)throw partnerError('CONVERSATION_NOT_FOUND',404);
     conversationId=conversation.id;
    }else{
     const contact=await repository.upsertContact(tx,{id:randomUUID(),organizationId:org,externalId:input.phoneNumber.slice(1),displayName:null,consentStatus:'UNKNOWN',consentUpdatedAt:null});
     conversationId=(await repository.getOrCreateConversation(tx,{id:randomUUID(),organizationId:org,channelId,contactId:contact.id})).id;
    }
    await recordManualAttendanceTakeover(tx,org,conversationId);
    await repository.setConversationMode(tx,{organizationId:org,conversationId,mode:'HUMAN'});
    const content:MediaMessageContent={type:'MEDIA',mediaId:asset.id,kind:asset.kind,fileName:asset.fileName,...(input.caption!==undefined?{caption:input.caption}:{})};
    const result=await repository.enqueueOutgoing(tx,{id:randomUUID(),organizationId:org,channelId,conversationId,source:'OPERATOR',content,
     idempotencyKey:key,authorizingApiKeyId:apiKeyId,bodyHash,policy:{requireOptIn:false}});
    await recheckCurrentPartnerKey(tx,org,apiKeyId,['messaging:send','media:send']);
    return view(result.message,conversationId);
   });
  },
 };
}
