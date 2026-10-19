import {randomUUID} from 'node:crypto';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {MessagingChannel,MessageState,MessageContent} from './types.js';
import type {QrContactEvent} from './qr-events.js';
import {createPostgresMessagingRepository} from './repository.js';
import {canAdvanceMessageState,lockMessageStatusKey} from './message-state.js';
import {lockAttendanceChannel} from '../attendance/repository.js';
import {SUPERSEDED_PHYSICAL_CYCLE_PREFIX} from '../attendance/conversation-cycle-fence.js';
import {registerPendingMedia} from './media-store.js';
import {recordQrOutboundObservation} from './qr-outbound-observation.js';
const error=(code:string,status=422)=>Object.assign(new Error(code),{code,status});
/** Shared SQL path. Callers own the tenant transaction and historical/live flag. */
export async function persistQrContactEvent(tx:TenantTransaction,channel:MessagingChannel,event:QrContactEvent){
  const repository=createPostgresMessagingRepository();
  const org=channel.organizationId,channelId=channel.id;
  const observed=event.kind==='outbound'||event.kind==='outbound-media';
  if(observed)await lockAttendanceChannel(tx,org,channelId);
  else await repository.findChannel(tx,org,channelId,{lock:true});
  // An old pushName cannot replace the current contact identity/name.
  const contact=event.historical
    ? (await tx.query<{id:string}>(`INSERT INTO messaging_contacts(id,organization_id,external_id,display_name,consent_status)
        VALUES($1,$2,$3,$4,'UNKNOWN') ON CONFLICT(organization_id,external_id) DO NOTHING RETURNING id`,[randomUUID(),org,event.externalId,event.displayName])).rows[0]
      ?? (await tx.query<{id:string}>('SELECT id FROM messaging_contacts WHERE organization_id=$1 AND external_id=$2',[org,event.externalId])).rows[0]!
    : await repository.upsertContact(tx,{id:randomUUID(),organizationId:org,externalId:event.externalId,
        displayName:event.displayName,consentStatus:'UNKNOWN',consentUpdatedAt:null});
  const conversation=await repository.getOrCreateConversation(tx,{id:randomUUID(),organizationId:org,channelId,contactId:contact.id});
  if(event.historical){
    await lockMessageStatusKey(tx,org,channelId,event.upstreamMessageId);
    const existing=(await tx.query<{direction:string;conversation_id:string;contact_id:string|null;remote_conversation_key:string|null}>(`SELECT m.direction,m.conversation_id,c.contact_id,c.remote_conversation_key
      FROM messaging_messages m JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
      WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.provider_scope='' AND m.upstream_message_id=$3`,[org,channelId,event.upstreamMessageId])).rows[0];
    if(existing){
      const samePhysicalHistory=existing.contact_id===contact.id&&existing.remote_conversation_key?.startsWith(SUPERSEDED_PHYSICAL_CYCLE_PREFIX);
      if(existing.direction!==(observed?'OUTGOING':'INCOMING')||(existing.conversation_id!==conversation.id&&!samePhysicalHistory))throw error('QR_HISTORY_ID_CONFLICT',409);
      return false;
    }
    if(observed){
      const uncertain=(await tx.query(`SELECT 1 FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('DISPATCHED','UNKNOWN','ABANDONED') LIMIT 1`,[org,conversation.id])).rowCount;
      if(uncertain)throw error('QR_HISTORY_ACK_PENDING',503);
      let state:MessageState=event.historicalState??'SENT';
      const statuses=(await tx.query<{state:MessageState}>(`SELECT state FROM messaging_status_events
        WHERE organization_id=$1 AND channel_id=$2 AND upstream_message_id=$3 AND provider_scope='' ORDER BY occurred_at,id`,[org,channelId,event.upstreamMessageId])).rows;
      for(const status of statuses)if(canAdvanceMessageState(state,status.state))state=status.state;
      await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state,created_at,updated_at,is_historical)
        VALUES($1,$2,$3,$4,'OUTGOING','EXTERNAL_OBSERVED',$5,$6,$8,$7,$7,true)`,
      [randomUUID(),org,channelId,conversation.id,event.upstreamMessageId,'content' in event?event.content:null,event.occurredAt,state]);
      return true;
    }
  }
  const content:MessageContent='media' in event?{type:'MEDIA',mediaId:await registerPendingMedia(tx,org,channelId,event.media),
    kind:event.media.kind,fileName:event.media.fileName,caption:event.caption}:event.content;
  if(observed){await recordQrOutboundObservation(tx,{organizationId:org,channelId,conversationId:conversation.id,
    upstreamMessageId:event.upstreamMessageId,content,occurredAt:event.occurredAt});return;}
  const outcome=await repository.recordIncoming(tx,{id:randomUUID(),organizationId:org,channelId,conversationId:conversation.id,
    webhookEventKey:`qr:${event.upstreamMessageId}`,upstreamMessageId:event.upstreamMessageId,content,occurredAt:event.occurredAt,
    ...(event.recoveredIdentity||event.historical?{scheduleBot:false}:{}),...(event.historical?{historical:true}:{})});
  return outcome.kind==='created';
}
