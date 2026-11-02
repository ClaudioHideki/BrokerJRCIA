import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {QrContactEvent} from './qr-events.js';

export interface OriginReceiptInput {sourceEventId:string;contentSha256:string}
export class OriginReceiptError extends Error {
  constructor(public readonly code:string,public readonly status:number){super(code);}
}
const inputSchema=z.strictObject({sourceEventId:z.uuid(),contentSha256:z.string().regex(/^[a-f0-9]{64}$/u)});
// Version 1 captures only the origin journal's individual TEXT projection. Never ACK ignored facts.
const projectionSchema=z.strictObject({event:z.literal('messages.upsert'),instance:z.string().min(1).max(255),
  data:z.strictObject({key:z.strictObject({id:z.string().min(1).max(256),fromMe:z.boolean(),remoteJid:z.string().regex(/^[1-9]\d{7,14}@s\.whatsapp\.net$/u)}),
    message:z.strictObject({conversation:z.string().min(1).max(4096)}),messageTimestamp:z.number().int().positive().max(253402300799)})});

/** Route verifies hash over raw bytes; canonical projection binds the immutable SQL receipt to content. */
export async function admitOriginReceipt(tx:TenantTransaction,scope:{organizationId:string;channelId:string;instanceId:string;bindingFingerprint:string},
  metadata:OriginReceiptInput,payload:unknown):Promise<'accepted'|'duplicate'> {
  if(!inputSchema.safeParse(metadata).success)throw new OriginReceiptError('ORIGIN_RECEIPT_INVALID',400);
  const parsed=projectionSchema.safeParse(payload);
  if(!parsed.success)throw new OriginReceiptError('ORIGIN_EVENT_UNSUPPORTED',422);
  const canonicalHash=createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
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
export async function assertOriginFactPersisted(tx:TenantTransaction,scope:{organizationId:string;channelId:string},event:QrContactEvent):Promise<void> {
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
