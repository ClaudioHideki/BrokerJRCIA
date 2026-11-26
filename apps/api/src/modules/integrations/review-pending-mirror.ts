import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {ChatwootClient} from './chatwoot-client.js';
import {readChatwootAccount,type AccountRow} from './chatwoot-context.js';
import {assertChatwootMirrorContext} from './chatwoot-mirror-context.js';
import {integrationAudit,readChatwootConnection} from './chatwoot-service.js';
import {IntegrationError} from './integration-error.js';

const remoteId=z.number().int().positive().safe();
export const mirrorReviewInput=z.strictObject({organizationId:z.uuid(),integrationId:z.uuid(),jobId:z.uuid(),
  messageId:z.uuid(),accountId:remoteId,inboxId:remoteId,conversationId:remoteId});
type Input=z.infer<typeof mirrorReviewInput>;
type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;client(account:AccountRow):ChatwootClient};
const reject=(reason:string):never=>{throw new IntegrationError(reason,409);};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
// Excludes mutable delivery/read state. Both observations use PostgreSQL's canonical JSON encoding.
export const reviewedMessageHashSql=`encode(sha256(convert_to(jsonb_build_array(m.content,m.upstream_message_id,m.direction,
  m.source,extract(epoch from m.created_at),m.channel_id,m.conversation_id,(SELECT asset.sha256 FROM messaging_media asset
    WHERE asset.organization_id=m.organization_id AND asset.channel_id=m.channel_id AND asset.id=m.media_id))::text,'UTF8')),'hex')`;

export async function inspectMirrorQueue(transact:Options['transact'],rawInput:Input){
 const input=mirrorReviewInput.parse(rawInput);
 return transact(input.organizationId,async tx=>{
   const result=(await tx.query<{status:string;attempts:number;capturedTarget:boolean;ownAttempts:number;
     siblingJobs:number;mapped:boolean;uncertainInConversation:number;historical:boolean}>(`
     SELECT j.status,j.attempts,j.payload ?| ARRAY['admittedInboxTarget','reviewedInboxTarget'] AS "capturedTarget",
       m.is_historical OR j.status='HISTORY_PENDING' AS historical,
       EXISTS(SELECT 1 FROM chatwoot_messages cm WHERE cm.organization_id=j.organization_id AND
         cm.integration_id=j.integration_id AND cm.message_id=m.id) AS mapped,
       (SELECT count(*)::int FROM chatwoot_mirror_attempts a WHERE a.organization_id=j.organization_id
         AND a.integration_id=j.integration_id AND a.message_id=m.id) AS "ownAttempts",
       (SELECT count(*)::int FROM integration_jobs s WHERE s.organization_id=j.organization_id
         AND s.integration_id=j.integration_id AND s.message_id=m.id AND s.id<>j.id) AS "siblingJobs",
       (SELECT count(*)::int FROM integration_jobs blocked JOIN messaging_messages prev
         ON prev.organization_id=blocked.organization_id AND prev.id=blocked.message_id
         WHERE blocked.organization_id=j.organization_id AND blocked.integration_id=j.integration_id
         AND blocked.status='UNKNOWN' AND blocked.id<>j.id AND prev.conversation_id=m.conversation_id) AS "uncertainInConversation"
       FROM integration_jobs j JOIN messaging_messages m ON m.organization_id=j.organization_id AND m.id=j.message_id
       JOIN chatwoot_accounts a ON a.organization_id=j.organization_id
       JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id AND c.channel_id=m.channel_id
       JOIN chatwoot_conversations map ON map.organization_id=j.organization_id AND map.integration_id=j.integration_id AND map.conversation_id=m.conversation_id
       WHERE j.organization_id=$1 AND j.integration_id=$2 AND j.id=$3 AND m.id=$4 AND a.account_id=$5 AND c.inbox_id=$6 AND map.remote_conversation_id=$7`,
     [input.organizationId,input.integrationId,input.jobId,input.messageId,input.accountId,input.inboxId,input.conversationId])).rows[0];
   if(!result)return reject('CHATWOOT_REVIEW_SCOPE_MISMATCH');
   return {...result,observation:result.status==='PENDING'&&!result.capturedTarget&&result.uncertainInConversation>0
     ?'PENDING_WITHOUT_TARGET_BEHIND_UNKNOWN':'JOB_INSPECTED'};
 });
}

async function candidate(tx:TenantTransaction,input:Input){
 const row=(await tx.query<{instance_id:string;phone:string;contact_id:string;source_id:string;content_hash:string;provider_id:string}>(
   `SELECT ch.instance_id,ct.external_id AS phone,map.contact_id,map.source_id,
     ${reviewedMessageHashSql} AS content_hash,m.upstream_message_id AS provider_id
    FROM integration_jobs j JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id
    JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
    JOIN messaging_messages m ON m.organization_id=j.organization_id AND m.id=j.message_id AND m.channel_id=ch.id
    JOIN messaging_conversations cv ON cv.organization_id=m.organization_id AND cv.id=m.conversation_id AND cv.channel_id=ch.id
    JOIN messaging_contacts ct ON ct.organization_id=cv.organization_id AND ct.id=cv.contact_id
    JOIN chatwoot_conversations map ON map.organization_id=c.organization_id AND map.integration_id=c.id AND map.conversation_id=cv.id
    WHERE j.organization_id=$1 AND j.id=$2 AND j.message_id=$3 AND j.integration_id=$4 AND c.inbox_id=$5 AND map.remote_conversation_id=$6
      AND ch.provider='BAILEYS' AND ch.transport='BROKER_TRANSPORT' AND ch.instance_id IS NOT NULL
      AND chatwoot_channel_identity_ready(j.organization_id,ch.id)
      AND cv.recipient_kind='INDIVIDUAL' AND ct.external_id ~ '^[1-9][0-9]{7,14}$'
      AND j.kind='MIRROR_MESSAGE' AND j.status='PENDING' AND j.attempts=0 AND j.available_at<=now()
      AND j.payload='{}'::jsonb AND j.lease_token IS NULL
      AND m.upstream_message_id IS NOT NULL AND NOT m.is_historical AND m.content->>'type' IN('TEXT','MEDIA')
      AND (m.media_id IS NULL OR EXISTS(SELECT 1 FROM messaging_media asset WHERE asset.organization_id=m.organization_id
        AND asset.channel_id=ch.id AND asset.id=m.media_id AND asset.status='READY'))
      AND ((m.direction='INCOMING' AND m.source='CONTACT') OR (m.direction='OUTGOING' AND m.source='EXTERNAL_OBSERVED'))
      AND j.dedupe_key IN('message:'||m.id::text||':DELIVERED','message:'||m.id::text||':SENT','message:'||m.id::text||':READ')
      AND NOT EXISTS(SELECT 1 FROM chatwoot_messages cm WHERE cm.organization_id=j.organization_id
        AND cm.integration_id=c.id AND cm.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM chatwoot_mirror_attempts a WHERE a.organization_id=j.organization_id
        AND a.integration_id=c.id AND a.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM integration_jobs other WHERE other.organization_id=j.organization_id
        AND other.integration_id=c.id AND other.message_id=m.id AND other.id<>j.id)
    FOR UPDATE OF j FOR SHARE OF m,ct,cv,map`,
   [input.organizationId,input.jobId,input.messageId,input.integrationId,input.inboxId,input.conversationId])).rows[0];
 return row??reject('CHATWOOT_REVIEW_NOT_ELIGIBLE');
}

export async function verifyReviewedContact(client:ChatwootClient,accountId:number,inboxId:number,conversationId:number,
  expected:{contact_id:string;source_id:string;phone:string}){
 const remote=await client.conversation(accountId,conversationId);
 if(remote.account_id!==accountId||remote.inbox_id!==inboxId||remote.id!==conversationId
   ||String(remote.meta.sender.id)!==expected.contact_id||remote.meta.sender.phone_number?.replace(/\D/g,'')!==expected.phone
   ||(remote.contact_inbox && (String(remote.contact_inbox.contact_id)!==expected.contact_id
     ||remote.contact_inbox.inbox_id!==inboxId||remote.contact_inbox.source_id!==expected.source_id)))
   return reject('CHATWOOT_REVIEW_REMOTE_MISMATCH');
 if(!remote.contact_inbox){
   const contact=await client.contact(accountId,Number(expected.contact_id));
   const bindings=contact.contact_inboxes.filter(binding=>binding.inbox.id===inboxId);
   if(contact.id!==remote.meta.sender.id||contact.phone_number?.replace(/\D/g,'')!==expected.phone||
     bindings.length!==1||bindings[0]!.source_id!==expected.source_id)return reject('CHATWOOT_REVIEW_REMOTE_MISMATCH');
 }
}

/** An operator supplies one canonical delivery and the intended remote tuple. Review never creates a provider send. */
export async function reviewPendingMirror(options:Options,rawInput:Input,approvedDigest?:string){
 const input=mirrorReviewInput.parse(rawInput);
 const org=input.organizationId;
 const context=await options.transact(org,async tx=>{
   const a=await readChatwootAccount(tx,org),c=await readChatwootConnection(tx,org,input.integrationId);
   if(!a?.destination||!c||Number(a.account_id)!==input.accountId||Number(c.inbox_id)!==input.inboxId)
     return reject('CHATWOOT_REVIEW_SCOPE_MISMATCH');
   await assertChatwootMirrorContext(tx,a,c);
   return {a,c,row:await candidate(tx,input)};
 });
 const {a,c,row}=context;
 const client=options.client(a);
 await verifyReviewedContact(client,input.accountId,input.inboxId,input.conversationId,row);
 await client.reviewMirrorHistory(input.accountId,input.inboxId,input.conversationId,input.messageId,row.provider_id,org);
 const revision=a.destination!.revision;
 if(!await client.liveIngress().capability(input.accountId,input.inboxId,{organization_id:org,
   integration_id:c.id,instance_id:row.instance_id,destination_revision:revision}))return reject('CHATWOOT_NATIVE_RECEIPT_REQUIRED');
 const target={revision,account:String(input.accountId),inbox:String(input.inboxId),instance:row.instance_id,
   conversation:String(input.conversationId),contact:row.contact_id,sourceHash:hash(row.source_id),
   phoneHash:hash(row.phone),messageHash:row.content_hash,credentialRevision:a.credential_version};
 const digest=hash(JSON.stringify([input,target,row.content_hash,row.provider_id,row.phone,a.base_url]));
 if(approvedDigest===undefined)return {state:'ELIGIBLE' as const,digest};
 if(!/^[a-f0-9]{64}$/.test(approvedDigest)||approvedDigest!==digest)return reject('CHATWOOT_REVIEW_DIGEST_MISMATCH');
 await options.transact(org,async tx=>{
   await assertChatwootMirrorContext(tx,a,c,row.instance_id);
   const current=await candidate(tx,input);
   if(current.source_id!==row.source_id||current.contact_id!==row.contact_id||current.phone!==row.phone||
      current.provider_id!==row.provider_id||current.content_hash!==row.content_hash||current.instance_id!==row.instance_id)
     return reject('CHATWOOT_REVIEW_SCOPE_MISMATCH');
   await tx.query(`UPDATE integration_jobs SET payload=jsonb_build_object('reviewedInboxTarget',$3::jsonb,
      'requiresNativeReceipt',true),updated_at=now() WHERE organization_id=$1 AND id=$2`,[org,input.jobId,JSON.stringify(target)]);
   await integrationAudit(tx,org,'PENDING_MIRROR_REVIEWED',input.jobId,digest);
 });
 return {state:'QUEUED' as const,digest};
}
