import { randomUUID } from 'node:crypto';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import type { MessageContent } from '../messaging/types.js';
import type { HistorySyncRecord, HistorySyncScope } from './contract.js';

type Fact=Extract<HistorySyncRecord,{kind:'MESSAGE'}>;
type Peer={conversation_id:string;contact_id:string|null};
type Result={disposition:'CREATED'|'DUPLICATE'|'PEER'|'GAP'|'BLOCKED';receiptId:string|null;messageId:string|null;code:string|null};
export const normalizeHistoryJid=(jid:string)=>jid.replace(/:\d+(?=@)/u,'');
/** A recapture can allocate another private object for identical bytes. Storage
 * reference identity is not provider fact identity; content/metadata stay strict. */
const immutableContent=(content:Fact['content'])=>{
  if(content.type==='TEXT')return content;
  const {referenceId:_reference,...immutable}=content;
  return immutable;
};
/** Presentation, provider status and capture epochs are not immutable fact identity. */
export const historyFactHash=(record:Fact)=>hashIdempotencyRequest({recipientKind:record.recipientKind,
  chatJid:normalizeHistoryJid(record.chatJid),providerMessageId:record.providerMessageId,fromMe:record.fromMe,
  participantJid:record.participantJid===null?null:normalizeHistoryJid(record.participantJid),
  messageTimestamp:record.messageTimestamp,content:immutableContent(record.content)});
export type LiveMediaFact=Omit<Fact,'content'>&{content:{type:'LIVE_MEDIA';mediaType:string;filename:string;caption:string}};
/** Provenance of a newly received media observation; never a custody receipt.
 * Adoption separately requires both physical objects to be READY with equal bytes. */
export const historyLiveMediaHash=(record:LiveMediaFact|Fact)=>{
  if(record.content.type==='TEXT')throw Error('HISTORY_SYNC_MEDIA_REQUIRED');
  return hashIdempotencyRequest({protocol:'history-live-media/1',recipientKind:record.recipientKind,chatJid:normalizeHistoryJid(record.chatJid),
    providerMessageId:record.providerMessageId,fromMe:record.fromMe,participantJid:record.participantJid===null?null:normalizeHistoryJid(record.participantJid),
    messageTimestamp:record.messageTimestamp,content:{mediaType:record.content.mediaType,filename:record.content.filename,caption:record.content.caption}});
};
const blocked=(code:string):Result=>({disposition:'BLOCKED',receiptId:null,messageId:null,code});
export async function pendingHistoryMedia(tx:TenantTransaction,scope:HistorySyncScope,records:HistorySyncRecord[]) {
  let pending=0;
  for(const record of records)if(record.kind==='MESSAGE' && record.content.type==='MEDIA') {
    const m=record.content;
    if(!(await tx.query(`SELECT 1 FROM messaging_media WHERE organization_id=$1 AND channel_id=$2 AND id=$3
      AND status='READY' AND sha256=$4 AND byte_size=$5 AND mime_type=$6 AND kind=$7`,[scope.organizationId,scope.channelId,
      m.referenceId,m.sha256,m.byteSize,m.mimeType,m.mediaType.toLowerCase()])).rowCount)pending++;
  }
  return pending;
}

async function peer(tx:TenantTransaction,scope:HistorySyncScope,kind:'GROUP'|'INDIVIDUAL',jid:string,now:Date,occurredAt:number):Promise<Peer|null> {
  const org=scope.organizationId,ch=scope.channelId,owner=scope.historyAccountIdentity;
  const bound=(await tx.query<Peer>(`SELECT conversation_id,contact_id FROM history_sync_native_peers
    WHERE organization_id=$1 AND channel_id=$2 AND history_account_identity=$3 AND recipient_kind=$4 AND chat_jid=$5`,[org,ch,owner,kind,jid])).rows[0];
  if(bound)return bound;
  const name=(await tx.query<{display_name:string|null}>('SELECT display_name FROM history_sync_peers WHERE organization_id=$1 AND channel_id=$2 AND history_account_identity=$3 AND recipient_kind=$4 AND peer_jid=$5',[org,ch,owner,kind,jid])).rows[0]?.display_name??null;
  let contact:string|null=null,existing:Peer|undefined;
  if(kind==='GROUP') {
    // A current, server-authorized identity/catalogue is required by the native GROUP namespace.
    if(!(await tx.query('SELECT 1 FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2',[org,ch])).rowCount)return null;
    existing=(await tx.query<Peer>(`SELECT id AS conversation_id,contact_id FROM messaging_conversations WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3 AND recipient_kind='GROUP'`,[org,ch,jid])).rows[0];
  } else {
    const external=jid.endsWith('@lid')?`lid:${jid}`:jid.split('@')[0]!;
    contact=(await tx.query<{id:string}>(`INSERT INTO messaging_contacts(organization_id,external_id,display_name,created_at,updated_at)
      VALUES($1,$2,$3,$4,$4) ON CONFLICT(organization_id,external_id) DO NOTHING RETURNING id`,[org,external,name,now])).rows[0]?.id
      ??(await tx.query<{id:string}>('SELECT id FROM messaging_contacts WHERE organization_id=$1 AND external_id=$2',[org,external])).rows[0]!.id;
    const candidates=(await tx.query<Peer>(`SELECT id AS conversation_id,contact_id FROM messaging_conversations
      WHERE organization_id=$1 AND channel_id=$2 AND contact_id=$3 AND remote_conversation_key IS NULL LIMIT 2`,[org,ch,contact])).rows;
    if(candidates.length>1)return null;
    existing=candidates[0];
  }
  if(existing) {
    // A sole legacy match is not ownership evidence. Reuse only a nonempty
    // peer whose retained messages all have proved custody for this owner.
    const proved=(await tx.query<{proved:boolean}>(`SELECT EXISTS(SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND conversation_id=$3)
      AND NOT EXISTS(SELECT 1 FROM messaging_messages m WHERE m.organization_id=$1 AND m.conversation_id=$3
        AND NOT EXISTS(SELECT 1 FROM history_sync_receipts r WHERE r.organization_id=m.organization_id AND r.message_id=m.id AND r.history_account_identity=$4)
        AND NOT EXISTS(SELECT 1 FROM history_sync_live_proofs p JOIN history_sync_runs s ON s.organization_id=p.organization_id AND s.channel_id=p.channel_id
          AND s.identity_scope_id=p.identity_scope_id AND s.binding_fingerprint=p.binding_fingerprint
          WHERE p.organization_id=m.organization_id AND p.channel_id=$2 AND p.message_id=m.id AND s.history_account_identity=$4)) AS proved`,
    [org,ch,existing.conversation_id,owner])).rows[0]?.proved;
    if(!proved)return null;
  }
  const conversation=existing??(await tx.query<Peer>(`INSERT INTO messaging_conversations(organization_id,channel_id,contact_id,recipient_kind,group_jid,mode,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'HUMAN',$6,$6) RETURNING id AS conversation_id,contact_id`,[org,ch,contact,kind,kind==='GROUP'?jid:null,now])).rows[0]!;
  // Never attach a second logical owner to the old owner's native conversation.
  const other=(await tx.query('SELECT 1 FROM history_sync_native_peers WHERE organization_id=$1 AND channel_id=$2 AND conversation_id=$3 AND history_account_identity<>$4',[org,ch,conversation.conversation_id,owner])).rowCount;
  if(other)return null;
  await tx.query(`INSERT INTO history_sync_native_peers(organization_id,channel_id,history_account_identity,recipient_kind,chat_jid,conversation_id,contact_id,bootstrap_occurred_at,bootstrap_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[org,ch,owner,kind,jid,conversation.conversation_id,conversation.contact_id,occurredAt,name??'WhatsApp']);
  return conversation;
}

async function writeMessage(tx:TenantTransaction,scope:HistorySyncScope,record:Fact,now:Date):Promise<Result> {
  const org=scope.organizationId,ch=scope.channelId,jid=normalizeHistoryJid(record.chatJid),digest=historyFactHash(record);
  const previous=(await tx.query<{id:string;message_id:string;content_hash:string}>(`SELECT id,message_id,content_hash FROM history_sync_receipts
    WHERE organization_id=$1 AND channel_id=$2 AND history_account_identity=$3 AND recipient_kind=$4 AND chat_jid=$5 AND provider_message_id=$6`,
  [org,ch,scope.historyAccountIdentity,record.recipientKind,jid,record.providerMessageId])).rows[0];
  if(previous) {
    if(previous.content_hash!==digest)return blocked('HISTORY_SYNC_FACT_CONFLICT');
    return {disposition:'DUPLICATE',receiptId:previous.id,messageId:previous.message_id,code:null};
  }
  const target=await peer(tx,scope,record.recipientKind,jid,now,record.messageTimestamp);
  if(!target)return blocked('HISTORY_SYNC_PEER_UNPROVEN');
  let content:MessageContent;
  if(record.content.type==='TEXT')content=record.content;
  else {
    const media=(await tx.query<{id:string}>(`SELECT id FROM messaging_media WHERE organization_id=$1 AND channel_id=$2 AND id=$3
      AND status='READY' AND sha256=$4 AND byte_size=$5 AND mime_type=$6 AND kind=$7`,[org,ch,record.content.referenceId,
      record.content.sha256,record.content.byteSize,record.content.mimeType,record.content.mediaType.toLowerCase()])).rows[0];
    if(!media)return blocked('HISTORY_SYNC_MEDIA_NOT_VERIFIED');
    content={type:'MEDIA',mediaId:media.id,kind:record.content.mediaType.toLowerCase() as 'image'|'audio'|'video'|'document'|'sticker',
      fileName:record.content.filename,caption:record.content.caption};
  }
  const providerScope=(await tx.query<{scope:string}>('SELECT whatsapp_group_provider_scope($1,$2) AS scope',[org,target.conversation_id])).rows[0]!.scope;
  const native=(await tx.query<{id:string;content:MessageContent;direction:string;created_at:Date;conversation_id:string}>(`SELECT id,content,direction,created_at,conversation_id
    FROM messaging_messages WHERE organization_id=$1 AND channel_id=$2 AND provider_scope=$3 AND upstream_message_id=$4 FOR UPDATE`,[org,ch,providerScope,record.providerMessageId])).rows[0];
  let messageId:string,disposition:Result['disposition']='CREATED';
  if(native) {
    const proof=(await tx.query(`SELECT 1 FROM history_sync_live_proofs p JOIN history_sync_runs r ON r.organization_id=p.organization_id AND r.channel_id=p.channel_id
      AND r.identity_scope_id=p.identity_scope_id AND r.binding_fingerprint=p.binding_fingerprint
      WHERE p.organization_id=$1 AND p.message_id=$2 AND p.content_hash=ANY($3::text[]) AND r.history_account_identity=$4`,
    [org,native.id,record.content.type==='MEDIA'?[digest,historyLiveMediaHash(record)]:[digest],scope.historyAccountIdentity])).rowCount;
    let sameContent=hashIdempotencyRequest(native.content)===hashIdempotencyRequest(content);
    if(record.content.type==='MEDIA'&&native.content.type==='MEDIA'){
      const m=record.content;
      sameContent=native.content.kind===m.mediaType.toLowerCase()&&native.content.caption===m.caption&&native.content.fileName===m.filename&&Boolean((await tx.query(
        `SELECT 1 FROM messaging_media WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND status='READY'
          AND sha256=$4 AND byte_size=$5 AND mime_type=$6 AND kind=$7`,[org,ch,native.content.mediaId,m.sha256,m.byteSize,m.mimeType,m.mediaType.toLowerCase()])).rowCount);
    }
    if(!proof || native.conversation_id!==target.conversation_id || native.direction!==(record.fromMe?'OUTGOING':'INCOMING')
      || native.created_at.getTime()!==record.messageTimestamp*1000 || !sameContent)return blocked('HISTORY_SYNC_LEGACY_UNPROVEN');
    messageId=native.id;disposition='DUPLICATE';
  } else {
    // Unknown sends remain obligations; historical observation is never a resend decision.
    if(record.fromMe && (await tx.query(`SELECT 1 FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2 AND state IN('DISPATCHED','UNKNOWN','ABANDONED') LIMIT 1`,[org,target.conversation_id])).rowCount)
      return blocked('HISTORY_SYNC_UNKNOWN_SEND');
    messageId=randomUUID();
    await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state,created_at,updated_at,is_historical)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),to_timestamp($10),true)`,
    [messageId,org,ch,target.conversation_id,record.fromMe?'OUTGOING':'INCOMING',record.fromMe?'EXTERNAL_OBSERVED':'CONTACT',record.providerMessageId,JSON.stringify(content),record.state,record.messageTimestamp]);
  }
  const receipt=randomUUID();
  await tx.query(`INSERT INTO history_sync_receipts(organization_id,id,channel_id,history_account_identity,recipient_kind,chat_jid,provider_message_id,content_hash,message_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[org,receipt,ch,scope.historyAccountIdentity,record.recipientKind,jid,record.providerMessageId,digest,messageId]);
  return {disposition,receiptId:receipt,messageId,code:null};
}

/** Caller holds source authority, channel and run fences through COMMIT. No HTTP,
 * bots, sends or live callbacks. Receipts and the page checkpoint share its transaction. */
export async function writeHistoryRecords(tx:TenantTransaction,scope:HistorySyncScope,records:HistorySyncRecord[],now:Date) {
  if(!scope.historyAccountIdentity)throw Error('HISTORY_SYNC_IDENTITY_REQUIRED');
  const results:Result[]=[];
  for(const record of records) {
    if(record.kind==='GAP')results.push({disposition:'GAP',receiptId:null,messageId:null,code:record.reason});
    else if(record.kind==='MESSAGE')results.push(await writeMessage(tx,scope,record,now));
    else if(record.kind==='CHAT')results.push(await peer(tx,scope,record.recipientKind,normalizeHistoryJid(record.chatJid),now,record.lastMessageAt??0)
      ?{disposition:'PEER',receiptId:null,messageId:null,code:null}:blocked('HISTORY_SYNC_PEER_UNPROVEN'));
    else results.push({disposition:'PEER',receiptId:null,messageId:null,code:null});
  }
  return {results,created:results.filter(r=>r.disposition==='CREATED').length,duplicates:results.filter(r=>r.disposition==='DUPLICATE').length,
    blocked:results.filter(r=>r.disposition==='BLOCKED'||r.disposition==='GAP').length,messages:records.filter(r=>r.kind==='MESSAGE').length};
}
