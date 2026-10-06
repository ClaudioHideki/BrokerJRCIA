import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import { readCentralTransportBinding } from '../messaging/central-transport.js';
import { createCentralTransportChannel } from '../messaging/central-transport.js';
import { createPostgresMessagingRepository } from '../messaging/repository.js';
import { decodeChatwootRuntimeEvent } from './chatwoot-runtime-event.js';
import { recordChatwootAttendanceEvent } from './chatwoot-attendance-store.js';
import { initializeChatwootAttendanceMap } from './chatwoot-attendance-store.js';
import { createEventRouter } from '../automations/service.js';
import { runtimeAuthorityAllows } from '../attendance/runtime-authority.js';
import type { CentralRuntimeEventBinding } from './chatwoot-runtime-event.js';
export { createCentralTransportChannel };

type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
 resolveIntegration(id:string):Promise<string|null>;secrets:{decrypt(context:string,value:string):string};
 router?:ReturnType<typeof createEventRouter>;
 /** Trusted adapter performs scoped GETs outside the transaction; never webhook metadata. */
 readCanonical?(binding:CentralRuntimeEventBinding,conversationId:number,messageId:number):Promise<{conversation:unknown;message:unknown}>};
type StoredInput={id:string;channel_id:string;integration_id:string;event_key:string;kind:string;destination_revision:number;credential_version:number;owner_revision:number;
 remote_conversation_id:string;remote_message_id:string|null;conversation_id:string|null;message_id:string|null;disposition:string;created_at:Date};
const positiveId=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalMessage=z.object({id:positiveId,conversation_id:positiveId,message_type:z.union([z.literal('incoming'),z.literal(0)]),private:z.literal(false),
 content:z.string().min(1).max(4096),content_type:z.literal('text').optional(),attachments:z.array(z.unknown()).max(0).optional(),
 sender:z.object({id:positiveId,type:z.literal('contact')}),created_at:z.number().finite().nonnegative()});
const sameContext=(left:CentralRuntimeEventBinding,right:CentralRuntimeEventBinding)=>JSON.stringify(left)===JSON.stringify(right);
export function createChatwootRuntimeIngress(options:Options) {
 const messaging=createPostgresMessagingRepository();
 return {async receive(input:{integrationId:string;raw:Buffer;timestamp:string|undefined;signature:string|undefined}) {
  const id=z.uuid().parse(input.integrationId);
  if(!Buffer.isBuffer(input.raw)||input.raw.length>256*1024)throw new Error('CENTRAL_EVENT_INVALID');
  const org=await options.resolveIntegration(id);
  if(!org)throw new Error('CENTRAL_SIGNATURE_INVALID');
  // Signature/context snapshot precedes admission. The second transaction owns
  // the channel lock and rejects a token, destination or owner changed meanwhile.
  const snapshot=await options.transact(org,tx=>readCentralTransportBinding(tx,org,id));
  const secret=options.secrets.decrypt(`${org}:chatwoot-webhook:${id}`,snapshot.encryptedWebhookSecret);
  return options.transact(org,async tx=>{
   const current=await readCentralTransportBinding(tx,org,id,true);
   if(current.encryptedWebhookSecret!==snapshot.encryptedWebhookSecret)throw new Error('CENTRAL_CONTEXT_CHANGED');
   const event=decodeChatwootRuntimeEvent({...input,secret,binding:snapshot.binding,current:current.binding});
   if(event.kind==='IGNORED'||!event.dedupeKey)return {duplicate:false,eventId:null,conversationId:null,disposition:'IGNORED' as const};
   const prior=(await tx.query<{id:string;conversation_id:string|null;disposition:string}>(`SELECT id,conversation_id,disposition FROM central_runtime_events
    WHERE organization_id=$1 AND channel_id=$2 AND event_key=$3`,[org,event.scope.channelId,event.dedupeKey])).rows[0];
   if(prior)return {duplicate:true,eventId:prior.id,conversationId:prior.conversation_id,disposition:prior.disposition};
   const eventId=randomUUID();
   await tx.query(`INSERT INTO central_runtime_events(organization_id,id,channel_id,integration_id,event_key,kind,destination_revision,credential_version,owner_revision,remote_conversation_id,remote_message_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[org,eventId,event.scope.channelId,id,event.dedupeKey,event.kind,event.scope.destinationRevision,event.scope.credentialVersion,event.scope.ownerRevision,event.remoteConversationId,event.remoteMessageId??null]);
   let conversationId:string|null=null;
   if(event.kind==='CONTACT_TEXT') {
    const contact=await messaging.upsertContact(tx,{id:randomUUID(),organizationId:org,externalId:`central:${id}:${event.contactId}`,displayName:null,consentStatus:'UNKNOWN',consentUpdatedAt:null});
    const conversation=(await tx.query<{id:string}>(`INSERT INTO messaging_conversations(organization_id,channel_id,contact_id,remote_conversation_key,bot_public_id,bot_origin_reference)
     SELECT $1,$2,$3,$4,bot_public_id,bot_origin_reference FROM messaging_channels WHERE organization_id=$1 AND id=$2
     ON CONFLICT(organization_id,channel_id,remote_conversation_key) WHERE remote_conversation_key IS NOT NULL
     DO UPDATE SET updated_at=messaging_conversations.updated_at RETURNING id`,[org,event.scope.channelId,contact.id,`${id}:${event.remoteConversationId}`])).rows[0]!;
    conversationId=conversation.id;
    const existing=(await tx.query<{contact_id:string}>(`SELECT contact_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND remote_conversation_id=$3`,[org,id,event.remoteConversationId])).rows[0];
    if(existing&&Number(existing.contact_id)!==event.contactId)throw new Error('CENTRAL_CONTACT_CHANGED');
    await tx.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,integration_id,remote_conversation_id) DO NOTHING`,[org,id,conversationId,event.contactId,`central:${event.contactId}`,event.remoteConversationId]);
    const message=await messaging.recordIncoming(tx,{id:randomUUID(),organizationId:org,channelId:event.scope.channelId,conversationId,
     webhookEventKey:event.dedupeKey,upstreamMessageId:event.dedupeKey,content:{type:'TEXT',text:event.text},scheduleBot:false});
    await tx.query(`INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4)`,[org,id,message.message.id,event.remoteMessageId]);
    await tx.query('UPDATE central_runtime_events SET conversation_id=$3,message_id=$4 WHERE organization_id=$1 AND id=$2',[org,eventId,conversationId,message.message.id]);
   }else{
    // Observations retain human precedence and never create a CHATWOOT_REPLY.
    // Preserve the decoder's safe decimal ID normalization. Reclassifying raw
    // JSON would reject an authenticated human observation with string IDs.
    await recordChatwootAttendanceEvent(tx,{...event.scope,credentialRevision:event.scope.credentialVersion},event.observationPayload);
    await tx.query("UPDATE central_runtime_events SET disposition='OBSERVED' WHERE organization_id=$1 AND id=$2",[org,eventId]);
   }
   return {duplicate:false,eventId,conversationId,disposition:event.kind==='CONTACT_TEXT'?'RECEIVED' as const:'OBSERVED' as const};
  });
 },async process(organizationId:string,eventId:string){
  const org=z.uuid().parse(organizationId),eventKey=z.uuid().parse(eventId);
  if(!options.readCanonical||!options.router)throw new Error('CENTRAL_RUNTIME_NOT_CONFIGURED');
  const readCanonical=options.readCanonical,router=options.router;
  const snapshot=await options.transact(org,async tx=>{
   const event=(await tx.query<StoredInput>('SELECT * FROM central_runtime_events WHERE organization_id=$1 AND id=$2',[org,eventKey])).rows[0];
   if(!event)throw new Error('CENTRAL_EVENT_NOT_FOUND');
   return {event,context:await readCentralTransportBinding(tx,org,event.integration_id)};
  });
  if(snapshot.event.disposition!=='RECEIVED'||snapshot.event.kind!=='CONTACT_TEXT')return {duplicate:true,disposition:snapshot.event.disposition};
  if(!snapshot.event.remote_message_id||!snapshot.event.conversation_id||!snapshot.event.message_id)throw new Error('CENTRAL_EVENT_INVALID');
  const remoteConversationId=Number(snapshot.event.remote_conversation_id),remoteMessageId=Number(snapshot.event.remote_message_id);
  const canonical=await readCanonical(snapshot.context.binding,remoteConversationId,remoteMessageId);
  // Canonical checks and the event's immutable expected revisions are both
  // checked after GET. A mutable token/destination/owner cannot authorize an old input.
  return options.transact(org,async tx=>{
   const current=await readCentralTransportBinding(tx,org,snapshot.event.integration_id,true);
   const event=(await tx.query<StoredInput>('SELECT * FROM central_runtime_events WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,eventKey])).rows[0]!;
   if(!sameContext(snapshot.context.binding,current.binding)||event.destination_revision!==current.binding.destinationRevision||
    event.credential_version!==current.binding.credentialVersion||event.owner_revision!==current.binding.ownerRevision)throw new Error('CENTRAL_CONTEXT_CHANGED');
   if(event.disposition!=='RECEIVED')return {duplicate:true,disposition:event.disposition};
   const message=canonicalMessage.parse(canonical.message);
   if(message.id!==remoteMessageId||message.conversation_id!==remoteConversationId)throw new Error('CENTRAL_CANONICAL_MISMATCH');
   const saved=(await tx.query<{content:{type:string;text:string};contact_id:string}>(`SELECT m.content,c.contact_id FROM messaging_messages m
    JOIN chatwoot_conversations c ON c.organization_id=m.organization_id AND c.conversation_id=m.conversation_id AND c.integration_id=$3
    WHERE m.organization_id=$1 AND m.id=$2`,[org,event.message_id,event.integration_id])).rows[0];
   if(!saved||saved.content.type!=='TEXT'||saved.content.text!==message.content||Number(saved.contact_id)!==message.sender.id)throw new Error('CENTRAL_CANONICAL_MISMATCH');
   await initializeChatwootAttendanceMap(tx,{...current.binding,credentialRevision:current.binding.credentialVersion},{conversationId:event.conversation_id!,remoteConversationId,canonical:canonical.conversation});
   const owner=(await tx.query<{automation_id:string|null;version:number|null}>('SELECT automation_id,version FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',[org,event.channel_id])).rows[0];
   const fresh=Math.abs(event.created_at.getTime()-message.created_at*1000)<=300000;
   const allowed=fresh&&owner?.automation_id&&owner.version!==null&&await runtimeAuthorityAllows(tx,{organizationId:org,channelId:event.channel_id,conversationId:event.conversation_id,automationId:owner.automation_id,version:owner.version});
   const routed=allowed?await router.routeWithinTransaction(tx,org,{channelId:event.channel_id,conversationId:event.conversation_id,eventKey:event.event_key,text:message.content}):null;
   const disposition=routed?.execution?'ROUTED':'IGNORED';
   await tx.query('UPDATE central_runtime_events SET disposition=$3,updated_at=now() WHERE organization_id=$1 AND id=$2',[org,eventKey,disposition]);
   return {duplicate:false,disposition};
  });
 }};
}
