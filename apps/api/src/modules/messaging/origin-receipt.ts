import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {QrContactEvent,QrEvent} from './qr-events.js';
import type {MessageContent} from './types.js';
import {qrLiveMediaFact,reuseHistoryForLive} from '../history-sync/live-fact.js';

export interface OriginReceiptInput {sourceEventId:string;contentSha256:string;projectionVersion?:2;
 sourceIdentity?:{sessionId:string;identityScopeId:string;ownerPhone:string}}
export class OriginReceiptError extends Error {
  constructor(public readonly code:string,public readonly status:number){super(code);}
}
const inputSchema=z.strictObject({sourceEventId:z.uuid(),contentSha256:z.string().regex(/^[a-f0-9]{64}$/u),projectionVersion:z.literal(2).optional(),
 sourceIdentity:z.strictObject({sessionId:z.uuid(),identityScopeId:z.uuid(),ownerPhone:z.string().regex(/^[1-9]\d{7,14}$/u)}).optional()})
 .refine(v=>!v.sourceIdentity||v.projectionVersion===2);
// Version 1 captures only the origin journal's individual TEXT projection. Never ACK ignored facts.
const projectionSchema=z.strictObject({event:z.literal('messages.upsert'),instance:z.string().min(1).max(255),
  data:z.strictObject({key:z.strictObject({id:z.string().min(1).max(256),fromMe:z.boolean(),remoteJid:z.string().regex(/^[1-9]\d{7,14}@s\.whatsapp\.net$/u)}),
    message:z.strictObject({conversation:z.string().min(1).max(4096)}),messageTimestamp:z.number().int().positive().max(253402300799)})});

/** Route verifies hash over raw bytes; canonical projection binds the immutable SQL receipt to content. */
export async function admitOriginReceipt(tx:TenantTransaction,scope:{organizationId:string;channelId:string;instanceId:string;bindingFingerprint:string},
  metadata:OriginReceiptInput,payload:unknown):Promise<'accepted'|'duplicate'> {
  if(!inputSchema.safeParse(metadata).success)throw new OriginReceiptError('ORIGIN_RECEIPT_INVALID',400);
  let canonical:unknown;
  if(metadata.projectionVersion===2){
    // Private headless host contract; the public V1 route/header stays unchanged.
    const {canonicalLive}=await import(new URL('../../../../../integrations/evolution-origin-journal/src/live-projection.mjs',import.meta.url).href);
    try{canonical=[2,canonicalLive({instanceName:(payload as {instance?:unknown})?.instance},payload)];}
    catch{throw new OriginReceiptError('ORIGIN_EVENT_UNSUPPORTED',422);}
  }else{
    const parsed=projectionSchema.safeParse(payload);
    if(!parsed.success)throw new OriginReceiptError('ORIGIN_EVENT_UNSUPPORTED',422);canonical=parsed.data;
  }
  const canonicalHash=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  // A successful response takes durable responsibility even if the caller pool defaults to async commits.
  await tx.query('SET LOCAL synchronous_commit = on');
  const values=[scope.organizationId,scope.channelId,metadata.sourceEventId,scope.instanceId,scope.bindingFingerprint,canonicalHash];
  const inserted=await tx.query(`INSERT INTO qr_origin_receipts(organization_id,channel_id,source_event_id,instance_id,binding_fingerprint,content_hash)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,channel_id,source_event_id) DO NOTHING RETURNING source_event_id`,values);
  if(inserted.rowCount)return 'accepted';
  const previous=(await tx.query<{instance_id:string;binding_fingerprint:string;content_hash:string}>(
    'SELECT instance_id,binding_fingerprint,content_hash FROM qr_origin_receipts WHERE organization_id=$1 AND channel_id=$2 AND source_event_id=$3',values.slice(0,3))).rows[0];
  if(!previous||previous.instance_id!==scope.instanceId||previous.binding_fingerprint!==scope.bindingFingerprint||previous.content_hash!==canonicalHash)
    throw new OriginReceiptError('ORIGIN_EVENT_CONFLICT',409);
  return 'duplicate';
}

/** A new journal UUID is not proof of a new provider fact. Legacy dedupe can retain an older body.
 * Verify the durable representation before COMMIT/ACK; an observation is custody, not delivery proof.
 */
export async function assertOriginFactPersisted(tx:TenantTransaction,scope:{organizationId:string;channelId:string},
  event:QrContactEvent|Extract<QrEvent,{kind:'group-text'|'group-media'}>,version?:2):Promise<void> {
  if(version===2)return assertV2FactPersisted(tx,scope,event);
  if(event.kind==='group-text'||event.kind==='group-media')throw new OriginReceiptError('ORIGIN_EVENT_UNSUPPORTED',422);
  if(!['message','outbound'].includes(event.kind)||!('content' in event)||event.content.type!=='TEXT')
    throw new OriginReceiptError('ORIGIN_EVENT_UNSUPPORTED',422);
  const outgoing=event.kind==='outbound';
  const row=(await tx.query<{content:{type:string;text?:string};external_id:string;occurred_at:Date;direction:string}>(outgoing
    ? `SELECT o.content,c.external_id,o.occurred_at,'OUTGOING' AS direction
       FROM qr_outbound_observations o JOIN messaging_conversations v ON v.organization_id=o.organization_id AND v.id=o.conversation_id
       JOIN messaging_contacts c ON c.organization_id=v.organization_id AND c.id=v.contact_id
       WHERE o.organization_id=$1 AND o.channel_id=$2 AND o.provider_scope='' AND o.provider_message_id=$3`
    : `SELECT m.content,c.external_id,m.created_at AS occurred_at,m.direction
       FROM messaging_messages m JOIN messaging_conversations v ON v.organization_id=m.organization_id AND v.id=m.conversation_id
       JOIN messaging_contacts c ON c.organization_id=v.organization_id AND c.id=v.contact_id
       WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.provider_scope='' AND m.upstream_message_id=$3`,
    [scope.organizationId,scope.channelId,event.upstreamMessageId])).rows[0];
  if(!row||row.direction!==(outgoing?'OUTGOING':'INCOMING')||row.external_id!==event.externalId||
    row.content?.type!=='TEXT'||row.content.text!==event.content.text||row.occurred_at.getTime()!==event.occurredAt.getTime())
    throw new OriginReceiptError('ORIGIN_EVENT_CONFLICT',409);
}

async function assertV2FactPersisted(tx:TenantTransaction,scope:{organizationId:string;channelId:string},
 event:QrContactEvent|Extract<QrEvent,{kind:'group-text'|'group-media'}>):Promise<void>{
 if('media'in event){
  const qr=(await tx.query<{id:string}>(`SELECT id FROM messaging_media WHERE organization_id=$1 AND channel_id=$2 AND source='QR' AND source_key=$3`,
   [scope.organizationId,scope.channelId,event.media.sourceKey])).rows[0];
  if(qr&&await reuseHistoryForLive(tx,scope.organizationId,scope.channelId,qrLiveMediaFact(event),qr.id))return;
 }
 const group=event.kind==='group-text'||event.kind==='group-media',outgoing=group?event.fromMe:event.kind==='outbound'||event.kind==='outbound-media';
 const values=[scope.organizationId,scope.channelId,event.upstreamMessageId];
 const row=(await tx.query<{content:MessageContent;peer:string;occurred_at:Date;direction:string;participant_jid?:string|null}>(group
  ? `SELECT f.content,f.group_jid AS peer,f.occurred_at,CASE WHEN f.from_me THEN 'OUTGOING' ELSE 'INCOMING' END AS direction,f.participant_jid
     FROM whatsapp_group_transport_facts f JOIN whatsapp_group_catalogs k ON k.organization_id=f.organization_id AND k.channel_id=f.channel_id
      AND k.identity_revision=f.identity_revision AND k.identity_fingerprint=f.identity_fingerprint
     WHERE f.organization_id=$1 AND f.channel_id=$2 AND f.provider_message_id=$3 AND f.group_jid=$4 AND f.from_me=$5`
  : outgoing
   ? `SELECT o.content,c.external_id AS peer,o.occurred_at,'OUTGOING' AS direction FROM qr_outbound_observations o
      JOIN messaging_conversations v ON v.organization_id=o.organization_id AND v.id=o.conversation_id
      JOIN messaging_contacts c ON c.organization_id=v.organization_id AND c.id=v.contact_id
      WHERE o.organization_id=$1 AND o.channel_id=$2 AND o.provider_scope='' AND o.provider_message_id=$3`
   : `SELECT m.content,c.external_id AS peer,m.created_at AS occurred_at,m.direction FROM messaging_messages m
      JOIN messaging_conversations v ON v.organization_id=m.organization_id AND v.id=m.conversation_id
      JOIN messaging_contacts c ON c.organization_id=v.organization_id AND c.id=v.contact_id
      WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.provider_scope='' AND m.upstream_message_id=$3`,
  group?[...values,event.groupJid,event.fromMe]:values)).rows[0];
 const conflict=()=>{throw new OriginReceiptError('ORIGIN_EVENT_CONFLICT',409);};
 if(!row||row.peer!==(group?event.groupJid:event.externalId)||row.direction!==(outgoing?'OUTGOING':'INCOMING')
   ||row.occurred_at.getTime()!==event.occurredAt.getTime()||group&&row.participant_jid!==event.participantJid)return conflict();
 if('media' in event){
  if(row.content.type!=='MEDIA'||row.content.kind!==event.media.kind||row.content.fileName!==event.media.fileName||row.content.caption!==event.caption)return conflict();
  if(!(await tx.query(`SELECT 1 FROM messaging_media WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND source='QR'
    AND source_key=$4 AND descriptor->>'messageId'=$5`,[scope.organizationId,scope.channelId,row.content.mediaId,event.media.sourceKey,event.upstreamMessageId])).rowCount)return conflict();
 }else if(!('content' in event)||event.content.type!=='TEXT'||row.content.type!=='TEXT'||row.content.text!==event.content.text)return conflict();
}
