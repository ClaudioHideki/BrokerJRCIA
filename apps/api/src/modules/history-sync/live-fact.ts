import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { HistorySyncRecord } from './contract.js';
import { historyFactHash, historyLiveMediaHash, normalizeHistoryJid,type LiveMediaFact } from './writer.js';
import type {QrContactEvent,QrEvent} from '../messaging/qr-events.js';
type Fact=Extract<HistorySyncRecord,{kind:'MESSAGE'}>;
async function capture(tx:TenantTransaction,org:string,channel:string) {
  return (await tx.query<{scope_id:string;binding_fingerprint:string}>(`SELECT s.scope_id,s.binding_fingerprint FROM qr_identity_scopes s
    JOIN messaging_channels c ON c.organization_id=s.organization_id AND c.id=s.channel_id AND c.instance_id=s.instance_id
    JOIN instances i ON i.organization_id=s.organization_id AND i.id=s.instance_id AND i.upstream_instance_key=s.upstream_instance_key
    WHERE s.organization_id=$1 AND s.channel_id=$2 AND s.owner_fingerprint IS NOT NULL
      AND c.provider='BAILEYS' AND c.transport='BROKER_TRANSPORT' AND c.deleting_at IS NULL AND i.archived_at IS NULL`,[org,channel])).rows[0];
}

/** Called only for a newly created live fact inside authenticated QR ingress.
 * Never retroactively stamp an unproved legacy row. */
export async function recordLiveHistoryFact(tx:TenantTransaction,org:string,channel:string,messageId:string,record:Fact|LiveMediaFact) {
  const source=await capture(tx,org,channel);if(!source)return;
  await tx.query(`INSERT INTO history_sync_live_proofs(organization_id,channel_id,message_id,identity_scope_id,binding_fingerprint,content_hash)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,message_id) DO NOTHING`,
  [org,channel,messageId,source.scope_id,source.binding_fingerprint,record.content.type==='LIVE_MEDIA'?historyLiveMediaHash(record as LiveMediaFact):historyFactHash(record as Fact)]);
}

/** History-first and same-owner reconnections reuse the original fact, including
 * groups whose legacy g3 namespace changes across a physical identity epoch. */
export function qrLiveMediaFact(event:QrContactEvent|Extract<QrEvent,{kind:'group-media'}>):LiveMediaFact{
  if(!('media'in event))throw Error('HISTORY_SYNC_MEDIA_REQUIRED');
  const group=event.kind==='group-media';
  return{kind:'MESSAGE',recipientKind:group?'GROUP':'INDIVIDUAL',chatJid:group?event.groupJid:`${event.externalId}@s.whatsapp.net`,
    providerMessageId:event.upstreamMessageId,fromMe:group?event.fromMe:event.kind==='outbound-media',
    participantJid:group?event.participantJid:null,displayName:null,messageTimestamp:Math.floor(event.occurredAt.getTime()/1000),state:'DELIVERED',
    content:{type:'LIVE_MEDIA',mediaType:event.media.kind.toUpperCase(),filename:event.media.fileName,caption:event.caption}};
}
export async function reuseHistoryForLive(tx:TenantTransaction,org:string,channel:string,record:Fact|LiveMediaFact,qrMediaId?:string):Promise<string|null> {
  const source=await capture(tx,org,channel);if(!source)return null;
  const rows=(await tx.query<{message_id:string;content_hash:string}>(`SELECT DISTINCT r.message_id,r.content_hash FROM history_sync_receipts r
    JOIN history_sync_runs c ON c.organization_id=r.organization_id AND c.channel_id=r.channel_id AND c.history_account_identity=r.history_account_identity
    WHERE r.organization_id=$1 AND r.channel_id=$2 AND r.recipient_kind=$3 AND r.chat_jid=$4 AND r.provider_message_id=$5
      AND c.identity_scope_id=$6 AND c.binding_fingerprint=$7 LIMIT 2`,
  [org,channel,record.recipientKind,normalizeHistoryJid(record.chatJid),record.providerMessageId,source.scope_id,source.binding_fingerprint])).rows;
  if(!rows.length)return null;
  let fact:Fact;
  if(record.content.type==='LIVE_MEDIA'){
    const m=(await tx.query<{sha256:string;byte_size:string;mime_type:string;kind:string}>(`SELECT sha256,byte_size,mime_type,kind FROM messaging_media
      WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND source='QR' AND status='READY'`,[org,channel,qrMediaId])).rows[0];
    if(!m)throw Error('HISTORY_SYNC_MEDIA_PENDING');
    if(m.kind!==record.content.mediaType.toLowerCase())throw Error('HISTORY_SYNC_LIVE_FACT_CONFLICT');
    fact={...record,content:{type:'MEDIA',referenceId:qrMediaId!,mediaType:record.content.mediaType as Extract<Fact['content'],{type:'MEDIA'}>['mediaType'],
      filename:record.content.filename,caption:record.content.caption,sha256:m.sha256,byteSize:Number(m.byte_size),mimeType:m.mime_type}};
  }else fact=record as Fact;
  if(rows.length>1 || rows[0]!.content_hash!==historyFactHash(fact))throw Error('HISTORY_SYNC_LIVE_FACT_CONFLICT');
  return rows[0]?.message_id??null;
}
