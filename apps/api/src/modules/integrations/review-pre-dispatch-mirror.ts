import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {readChatwootAccount} from './chatwoot-context.js';
import {liveIngressLookup} from './chatwoot-live-ingress.js';
import {assertChatwootMirrorContext} from './chatwoot-mirror-context.js';
import {integrationAudit,readChatwootConnection} from './chatwoot-service.js';
import {IntegrationError} from './integration-error.js';
import {readJobFailureDiagnostic} from './job-failure-diagnostics.js';
import {mirrorReviewInput,reviewedMessageHashSql,verifyReviewedContact,type MirrorReviewOptions} from './review-pending-mirror.js';

type Input=z.infer<typeof mirrorReviewInput>;
type Evidence={instance:string;phone:string;source_id:string;contact_id:string;provider:string;message_hash:string;
  media_sha:string|null;content:{type:'TEXT';text:string}|{type:'MEDIA';mediaId:string;caption?:string|null};
  occurred_at:number;diagnostic:unknown;observation:string;captured:unknown};
const refuse=():never=>{throw new IntegrationError('CHATWOOT_PREDISPATCH_UNPROVEN',409);};
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

async function readCandidate(tx:TenantTransaction,input:Input){
  const {organizationId:org,integrationId,jobId,messageId,accountId,inboxId,conversationId}=input;
  const account=await readChatwootAccount(tx,org),connection=await readChatwootConnection(tx,org,integrationId);
  if(!account?.destination||!connection||Number(account.account_id)!==accountId||Number(connection.inbox_id)!==inboxId)return refuse();
  await assertChatwootMirrorContext(tx,account,connection);
  // State updates acquire this same canonical before enqueueing a sibling.
  await tx.query('SELECT id FROM messaging_messages WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,messageId]);
  const row=(await tx.query<Evidence>(`
    SELECT ch.instance_id AS instance,ct.external_id AS phone,map.source_id,map.contact_id::text,
      m.upstream_message_id AS provider,m.content,floor(extract(epoch FROM m.created_at))::float8 AS occurred_at,
      ${reviewedMessageHashSql} AS message_hash,asset.sha256 AS media_sha,
      j.failure_diagnostic AS diagnostic,o.id AS observation,j.payload AS captured
    FROM integration_jobs j
    JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id
    JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
    JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
    JOIN messaging_messages m ON m.organization_id=j.organization_id AND m.id=j.message_id AND m.channel_id=ch.id
    JOIN messaging_conversations cv ON cv.organization_id=m.organization_id AND cv.id=m.conversation_id AND cv.channel_id=ch.id
    JOIN messaging_contacts ct ON ct.organization_id=cv.organization_id AND ct.id=cv.contact_id
    JOIN chatwoot_conversations map ON map.organization_id=c.organization_id AND map.integration_id=c.id AND map.conversation_id=cv.id
    JOIN qr_outbound_observations o ON o.organization_id=m.organization_id AND o.message_id=m.id AND o.channel_id=ch.id
      AND o.conversation_id=cv.id AND o.provider_message_id=m.upstream_message_id AND o.provider_scope=m.provider_scope
    LEFT JOIN messaging_media asset ON asset.organization_id=m.organization_id AND asset.channel_id=m.channel_id
      AND asset.id=m.media_id
    WHERE j.organization_id=$1 AND j.integration_id=$2 AND j.id=$3 AND j.message_id=$4
      AND a.account_id=$5 AND c.inbox_id=$6 AND map.remote_conversation_id=$7
      AND j.kind='MIRROR_MESSAGE' AND j.dedupe_key='message:'||m.id::text||':SENT' AND j.status='UNKNOWN'
      AND j.attempts=1 AND j.lease_token IS NULL AND j.lease_expires_at IS NULL AND j.last_error='INTEGRATION_PROCESSING_FAILED'
      AND ch.provider='BAILEYS' AND ch.transport='BROKER_TRANSPORT' AND chatwoot_channel_identity_ready(j.organization_id,ch.id)
      AND m.source='EXTERNAL_OBSERVED' AND m.direction='OUTGOING' AND NOT m.is_historical AND m.provider_scope=''
      AND m.upstream_message_id<>'' AND m.upstream_message_id !~ '[[:space:][:cntrl:]]' AND m.state IN ('SENT','DELIVERED','READ')
      AND o.disposition='EXTERNAL_OBSERVED' AND NOT o.blocking AND o.content=m.content
      AND cv.recipient_kind='INDIVIDUAL' AND ct.external_id ~ '^[1-9][0-9]{7,14}$'
      AND (m.content->>'type'='TEXT' OR (m.content->>'type'='MEDIA' AND asset.status='READY' AND asset.source='QR'
        AND asset.sha256 ~ '^[a-f0-9]{64}$' AND asset.descriptor->>'messageId'=m.upstream_message_id))
      AND j.payload=jsonb_build_object('requiresNativeReceipt',true,'qrObservationId',o.id,'admittedInboxTarget',
        jsonb_build_object('revision',d.revision,'credentialRevision',a.credential_version,'account',a.account_id::text,
          'inbox',c.inbox_id::text,'instance',ch.instance_id,'conversation',map.remote_conversation_id::text,
          'contact',map.contact_id::text,'sourceHash',encode(sha256(convert_to(map.source_id,'UTF8')),'hex'),
          'phoneHash',encode(sha256(convert_to(ct.external_id,'UTF8')),'hex'),
          'providerHash',encode(sha256(convert_to(m.upstream_message_id,'UTF8')),'hex')))
      AND NOT EXISTS(SELECT 1 FROM chatwoot_messages cm WHERE cm.organization_id=j.organization_id AND cm.integration_id=j.integration_id AND cm.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM messaging_outbox physical WHERE physical.organization_id=j.organization_id AND physical.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM chatwoot_mirror_attempts at WHERE at.organization_id=j.organization_id AND at.integration_id=j.integration_id
        AND (at.message_id=m.id OR at.job_id IN (SELECT member.id FROM integration_jobs member WHERE member.organization_id=j.organization_id
          AND member.integration_id=j.integration_id AND member.message_id=m.id)))
    FOR UPDATE OF j FOR SHARE OF ct,cv,map,o`,[org,integrationId,jobId,messageId,accountId,inboxId,conversationId])).rows[0];
  if(!row)return refuse();
  const diagnostic=readJobFailureDiagnostic(row.diagnostic);
  if(!diagnostic||diagnostic.version!==1||diagnostic.phase!=='UNKNOWN'||diagnostic.method!==null||diagnostic.httpStatus!==null
    ||diagnostic.attempt!==1||diagnostic.settlement!=='UNKNOWN')return refuse();
  const siblings=(await tx.query<{id:string;eligible:boolean}>(`
    SELECT id,(kind='MIRROR_MESSAGE' AND status='PENDING' AND attempts=0 AND lease_token IS NULL AND lease_expires_at IS NULL
      AND dedupe_key IN ('message:'||message_id::text||':DELIVERED','message:'||message_id::text||':READ')
      AND payload=($5::jsonb||jsonb_build_object('reviewedStatusLeader',$4::uuid))) AS eligible
    FROM integration_jobs WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3 AND id<>$4::uuid ORDER BY id FOR UPDATE`,
    [org,integrationId,messageId,jobId,JSON.stringify(row.captured)])).rows;
  if(siblings.some(sibling=>!sibling.eligible))return refuse();
  const fingerprint=hash(JSON.stringify(['native-qr-before-dispatch-v1',input,row.message_hash,row.media_sha,row.provider,row.observation,
    row.captured,diagnostic,account.base_url,...siblings.map(s=>s.id)]));
  return {row,account,fingerprint};
}

/** Review a first QR mirror on its original route. This command never persists a remote message. */
export async function reviewPreDispatchMirror(options:MirrorReviewOptions,raw:Input,approvedDigest?:string){
  const input=mirrorReviewInput.parse(raw),org=input.organizationId;
  const {row,account,fingerprint}=await options.transact(org,tx=>readCandidate(tx,input));
  const client=options.client(account),native=client.liveIngress(),scope={organization_id:org,integration_id:input.integrationId,
    instance_id:row.instance,destination_revision:account.destination!.revision};
  await verifyReviewedContact(client,input.accountId,input.inboxId,input.conversationId,row);
  await client.reviewMirrorHistory(input.accountId,input.inboxId,input.conversationId,input.messageId,row.provider,org);
  if(!await native.capability(input.accountId,input.inboxId,scope))return refuse();
  const file=row.content.type==='MEDIA'&&options.media?await options.media.read(org,row.content.mediaId):undefined;
  if(row.content.type==='MEDIA'&&(!file||hash(file.bytes)!==row.media_sha))return refuse();
  const text=row.content.type==='TEXT'?row.content.text:row.content.caption;
  const envelope=native.prepare(scope,{broker_message_id:input.messageId,conversation_id:input.conversationId,
    message_type:'outgoing',message_origin:'EXTERNAL_OBSERVED',occurred_at:row.occurred_at,
    content:'[Saída observada no WhatsApp]'+(text?'\n'+text:'')},file);
  await client.requireMissingLiveReceipt(input.accountId,input.inboxId,liveIngressLookup(envelope));
  const digest=hash(JSON.stringify([fingerprint,envelope.request_hash]));
  if(approvedDigest===undefined)return {state:'ELIGIBLE' as const,digest};
  if(approvedDigest!==digest)throw new IntegrationError('CHATWOOT_REVIEW_DIGEST_MISMATCH',409);
  await options.transact(org,async tx=>{
    const current=await readCandidate(tx,input);
    if(current.fingerprint!==fingerprint||current.account.encrypted_token!==account.encrypted_token)return refuse();
    const updated=await tx.query("UPDATE integration_jobs SET status='PENDING',available_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='UNKNOWN' RETURNING id",
      [org,input.jobId]);
    if(updated.rowCount!==1)return refuse();
    await integrationAudit(tx,org,'PREDISPATCH_MIRROR_REVIEWED',input.jobId,digest);
  });
  return {state:'QUEUED' as const,digest};
}
