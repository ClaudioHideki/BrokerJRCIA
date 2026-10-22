import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatwootControlOptions } from './chatwoot-control-service.js';
import type { ChatwootControlPrincipal } from './chatwoot-control-auth.js';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { chatwootEnvironment } from './chatwoot-service.js';
import { readChatwootAccount } from './chatwoot-context.js';
import { IntegrationError } from './integration-error.js';
import { verifyCanonicalCampaignMessage, type CampaignIntent } from './chatwoot-campaign-authority.js';
import { lockAttendanceChannel } from '../attendance/repository.js';

export const CampaignIntentInputSchema=z.strictObject({conversationId:z.number().int().positive(),messageId:z.number().int().positive(),
 campaignId:z.string().min(1).max(128),kind:z.enum(['text','image','document','video','audio']),text:z.string().max(4096),
 destinationRevision:z.number().int().positive(),identityRevision:z.number().int().positive(),ownerRevision:z.number().int().nonnegative()});
export const CampaignTransportSchema=z.strictObject({protocol:z.literal('chatwoot-campaigns/v1'),integrationId:z.uuid(),inboxId:z.number().int().positive(),instanceId:z.uuid(),
 destinationRevision:z.number().int().positive(),identityRevision:z.number().int().nonnegative(),ownerRevision:z.number().int().nonnegative(),
 ready:z.boolean(),reason:z.enum(['CAMPAIGN_BROKER_TRANSPORT_REQUIRED','CAMPAIGN_CALLBACK_NOT_READY','CAMPAIGN_IDENTITY_NOT_READY','CAMPAIGN_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION']).nullable(),numberSuffix:z.string().regex(/^\d{4}$/).nullable()});
export const CampaignIntentResponseSchema=z.strictObject({protocol:z.literal('chatwoot-campaigns/v1'),intentId:z.uuid(),state:z.literal('RESERVED'),expiresAt:z.iso.datetime(),replayed:z.boolean()});
export const CampaignReceiptSchema=z.strictObject({protocol:z.literal('chatwoot-campaigns/v1'),integrationId:z.uuid(),conversationId:z.number().int().positive(),messageId:z.number().int().positive(),
 status:z.enum(['queued','sent','delivered','read','failed','blocked','unknown']),errorCode:z.string().nullable()});
type Input=z.infer<typeof CampaignIntentInputSchema>;
interface Snapshot {channel_id:string;instance_id:string;inbox_id:string;status:string;instance_status:string;archived_at:Date|null;transport:string;identity_revision:number;observed_connected:boolean;identity_fresh:boolean;access_error:string|null;
 observed_fingerprint:string|null;approved_fingerprint:string|null;identity_error:string|null;observed_last4:string|null;
 callback_verified_at:Date|null;callback_destination_revision:number|null;callback_credential_version:number|null;owner_revision:number;credential_version:number}
export function createChatwootCampaignService(options:ChatwootControlOptions){
 const tx=options.transact,env=chatwootEnvironment(options);
 async function snapshot(t:TenantTransaction,p:ChatwootControlPrincipal,id:string,write=false){
  await options.auth.revalidate(t,p,write?'chatwoot:manage':'chatwoot:read',id);
  const row=(await t.query<Snapshot>(`SELECT c.channel_id,c.inbox_id,c.status,ch.instance_id,ch.transport,instance.status instance_status,instance.archived_at,
   coalesce(h.identity_revision,0) identity_revision,h.observed_connected,h.observed_fingerprint,h.approved_fingerprint,h.identity_error,h.observed_last4,
   h.callback_verified_at,h.callback_destination_revision,h.callback_credential_version,a.credential_version,h.access_error,coalesce(h.observed_at>now()-interval '90 seconds',false) identity_fresh,
   coalesce(own.revision,0) owner_revision FROM chatwoot_connections c
   JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id AND ch.provider='BAILEYS' AND ch.deleting_at IS NULL
   JOIN instances instance ON instance.organization_id=ch.organization_id AND instance.id=ch.instance_id
   JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
   LEFT JOIN chatwoot_connection_health h ON h.organization_id=c.organization_id AND h.integration_id=c.id
   LEFT JOIN attendance_owners own ON own.organization_id=c.organization_id AND own.channel_id=c.channel_id
   WHERE c.organization_id=$1 AND c.id=$2`,[p.organizationId,id])).rows[0];
  if(!row?.instance_id||!row.inbox_id)throw new IntegrationError('CONTROL_QR_INTEGRATION_NOT_FOUND',404);
  const reason=row.transport!=='BROKER_TRANSPORT'?'CAMPAIGN_BROKER_TRANSPORT_REQUIRED':row.status!=='READY'||!row.callback_verified_at||row.callback_destination_revision!==p.destinationRevision||row.callback_credential_version!==row.credential_version?'CAMPAIGN_CALLBACK_NOT_READY':
   row.instance_status!=='CONNECTED'||row.archived_at||!row.identity_fresh||row.access_error||!row.observed_connected||!row.observed_fingerprint||row.observed_fingerprint!==row.approved_fingerprint||row.identity_error?'CAMPAIGN_IDENTITY_NOT_READY':null;
  return {row,view:{protocol:'chatwoot-campaigns/v1' as const,integrationId:id,inboxId:Number(row.inbox_id),instanceId:row.instance_id,destinationRevision:p.destinationRevision,
   identityRevision:row.identity_revision,ownerRevision:row.owner_revision,ready:reason===null,reason,numberSuffix:row.observed_last4}};
 }
 return {
  async campaignTransport(p:ChatwootControlPrincipal,id:string){
   const {view}=await tx(p.organizationId,t=>snapshot(t,p,id));
   if(!view.ready)return view;
   const account=await tx(p.organizationId,t=>readChatwootAccount(t,p.organizationId));
   if(!account)throw new IntegrationError('CHATWOOT_ACCOUNT_NOT_READY',409);
   const inbox=await env.client(account).attendanceInbox(p.accountId,view.inboxId);
   if(inbox.channel_type!=='Channel::Api'||inbox.greeting_enabled!==false||inbox.enable_auto_assignment!==false)
    return {...view,ready:false,reason:'CAMPAIGN_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION' as const};
   return view;
  },
  async reserveCampaignIntent(p:ChatwootControlPrincipal,id:string,input:Input,key:string){
   if(p.authentication.kind!=='API_KEY'||!p.externalActorId||! /^[1-9]\d{0,15}$/.test(p.externalActorId))throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN',403);
   const apiKeyId=p.authentication.apiKeyId,actorId=p.externalActorId;
   const before=await tx(p.organizationId,t=>snapshot(t,p,id,true));
   if(!before.view.ready)throw new IntegrationError(before.view.reason!,409);
   const account=await tx(p.organizationId,t=>readChatwootAccount(t,p.organizationId));
   if(!account)throw new IntegrationError('CHATWOOT_ACCOUNT_NOT_READY',409);
   const inbox=await env.client(account).attendanceInbox(p.accountId,Number(before.row.inbox_id));
   if(inbox.channel_type!=='Channel::Api'||inbox.greeting_enabled!==false||inbox.enable_auto_assignment!==false)
    throw new IntegrationError('CAMPAIGN_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION',409);
   const canonical=await env.client(account).canonicalMessage(p.accountId,Number(before.row.inbox_id),input.conversationId,input.messageId);
   const remote=await env.client(account).conversation(p.accountId,input.conversationId);
   if(remote.id!==input.conversationId||remote.account_id!==p.accountId||remote.inbox_id!==Number(before.row.inbox_id)||!/^\+[1-9]\d{7,14}$/.test(remote.meta.sender.phone_number??''))
    throw new IntegrationError('CAMPAIGN_RECIPIENT_NOT_PROVEN',409);
   const contact=await env.client(account).contact(p.accountId,remote.meta.sender.id);
   const sources=contact.contact_inboxes.filter(i=>i.inbox.id===remote.inbox_id);
   if(contact.id!==remote.meta.sender.id||contact.phone_number!==remote.meta.sender.phone_number||sources.length!==1||!sources[0]!.source_id)
    throw new IntegrationError('CAMPAIGN_RECIPIENT_NOT_PROVEN',409);
   const intent={id:randomUUID(),actor_id:actorId,campaign_id:input.campaignId,remote_conversation_id:String(input.conversationId),remote_message_id:String(input.messageId),kind:input.kind,text:input.text};
   const attachmentProof=verifyCanonicalCampaignMessage(intent,canonical,{conversationId:input.conversationId,messageId:input.messageId,inboxId:Number(before.row.inbox_id)},false);
   const hash=createHash('sha256').update(JSON.stringify({apiKeyId,actorId,input})).digest('hex');
   return tx(p.organizationId,async t=>{
    await lockAttendanceChannel(t,p.organizationId,before.row.channel_id);
    const current=await snapshot(t,p,id,true),v=current.view;
    if(!v.ready||v.destinationRevision!==input.destinationRevision||v.identityRevision!==input.identityRevision||v.ownerRevision!==input.ownerRevision||current.row.credential_version!==before.row.credential_version)
     throw new IntegrationError('CAMPAIGN_CONTEXT_CHANGED',409);
    await t.query(`SELECT id FROM api_keys WHERE organization_id=$1 AND id=$2 FOR SHARE`,[p.organizationId,apiKeyId]);
    await options.auth.revalidate(t,p,'chatwoot:manage',id);
    const result=await t.query<CampaignIntent & {expires_at:Date;request_hash:string}>(`INSERT INTO chatwoot_campaign_intents
     (organization_id,id,integration_id,channel_id,api_key_id,actor_id,account_id,inbox_id,destination_revision,credential_version,identity_revision,owner_revision,
      remote_conversation_id,remote_message_id,campaign_id,kind,text,idempotency_key,request_hash,attachment_ids,remote_contact_id,recipient_phone,recipient_source_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23)
     ON CONFLICT(organization_id,integration_id,idempotency_key) DO NOTHING RETURNING *`,
     [p.organizationId,intent.id,id,current.row.channel_id,apiKeyId,actorId,p.accountId,v.inboxId,input.destinationRevision,current.row.credential_version,input.identityRevision,input.ownerRevision,
      input.conversationId,input.messageId,input.campaignId,input.kind,input.text,key,hash,JSON.stringify(attachmentProof.attachmentIds),remote.meta.sender.id,contact.phone_number,sources[0]!.source_id]);
    const row=result.rows[0]??(await t.query<CampaignIntent & {expires_at:Date;request_hash:string}>(`SELECT * FROM chatwoot_campaign_intents WHERE organization_id=$1 AND integration_id=$2 AND idempotency_key=$3`,[p.organizationId,id,key])).rows[0];
    if(!row||row.request_hash!==hash)throw new IntegrationError('IDEMPOTENCY_CONFLICT',409);
    if(Number(row.remote_contact_id)!==contact.id||row.recipient_phone!==contact.phone_number||row.recipient_source_id!==sources[0]!.source_id)throw new IntegrationError('CAMPAIGN_RECIPIENT_CHANGED',409);
    verifyCanonicalCampaignMessage(row,canonical,{conversationId:input.conversationId,messageId:input.messageId,inboxId:Number(current.row.inbox_id)},false);
    if(row.expires_at.getTime()<=Date.now())throw new IntegrationError('CAMPAIGN_INTENT_EXPIRED',409);
    return {protocol:'chatwoot-campaigns/v1' as const,intentId:row.id,state:'RESERVED' as const,expiresAt:row.expires_at.toISOString(),replayed:!result.rowCount};
   });
  },
  async campaignReceipt(p:ChatwootControlPrincipal,id:string,conversationId:number,messageId:number){
   return tx(p.organizationId,async t=>{
    await snapshot(t,p,id);
    const rows=(await t.query<{state:string|null;canonical_error_code:string|null;disposition:string;job_status:string|null;last_error:string|null}>(`SELECT m.state,m.canonical_error_code,o.disposition,j.status job_status,j.last_error
     FROM chatwoot_attendance_observations o
     LEFT JOIN chatwoot_messages cm ON cm.organization_id=o.organization_id AND cm.integration_id=o.integration_id AND cm.remote_message_id=$6
     LEFT JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id AND m.channel_id=o.channel_id AND m.direction='OUTGOING'
     LEFT JOIN chatwoot_conversations cv ON cv.organization_id=o.organization_id AND cv.integration_id=o.integration_id AND cv.conversation_id=m.conversation_id AND cv.remote_conversation_id=$5
     LEFT JOIN integration_jobs j ON j.organization_id=o.organization_id AND j.integration_id=o.integration_id AND j.kind='CHATWOOT_REPLY' AND j.payload->>'attendanceObservationId'=o.id::text
     WHERE o.organization_id=$1 AND o.integration_id=$2 AND o.account_id=$3 AND o.destination_revision=$4
      AND o.remote_conversation_id=$5 AND o.event->>'remoteMessageId'=$6::text AND o.event->>'kind'='AUTOMATED_REPLY'
      AND (m.id IS NULL OR cv.conversation_id IS NOT NULL)`,[p.organizationId,id,p.accountId,p.destinationRevision,conversationId,messageId])).rows;
    let status:'queued'|'sent'|'delivered'|'read'|'failed'|'blocked'|'unknown'='queued';
    const states=rows.map(r=>r.state);
    if(states.length)status=states.some(s=>s==='FAILED')||rows.some(r=>r.job_status==='FAILED')?'failed':states.some(s=>s==='UNKNOWN')||rows.some(r=>r.job_status==='UNKNOWN'||r.disposition==='RECONCILE')?'unknown':rows.some(r=>r.disposition==='IGNORED')?'blocked':states.every(s=>s==='READ')?'read':states.every(s=>s!==null&&['READ','DELIVERED'].includes(s))?'delivered':states.every(s=>s!==null&&['READ','DELIVERED','SENT'].includes(s))?'sent':'queued';
    return {protocol:'chatwoot-campaigns/v1' as const,integrationId:id,conversationId,messageId,status,errorCode:rows.find(r=>r.canonical_error_code)?.canonical_error_code??rows.find(r=>r.last_error)?.last_error??null};
   });
  },
 };
}
