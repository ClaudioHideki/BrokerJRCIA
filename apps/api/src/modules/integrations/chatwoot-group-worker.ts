import {createHash,randomUUID} from 'node:crypto';
import {MediaError,type BinaryMedia} from '@jrc/providers';
import {registerPendingMedia} from '../messaging/media-store.js';
import {requireCanonicalHumanIntent} from './chatwoot-human-intent.js';
import type {ChatwootAttendanceEvent} from './chatwoot-attendance-events.js';
import type {MessageContent} from '../messaging/types.js';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {lockAttendanceChannel} from '../attendance/repository.js';
import {currentGroupWebhookBinding} from '../whatsapp-groups/automation-authority.js';
import {readGroupCentralSnapshot,readGroupCentralScopeBlocker,readGroupRemoteMap,saveGroupRemoteMap,type GroupCentralSnapshot} from '../whatsapp-groups/central-group-store.js';
import {groupMirrorText,requireGroupReply} from '../whatsapp-groups/bridge-policy.js';
import {ChatwootError} from './chatwoot-client.js';
import {selectLiveMirrorProtocol,dispatchNativeLiveMirror,assertRejectedNativeRetry} from './chatwoot-live-dispatch.js';
import {LIVE_INGRESS_PROTOCOL,liveIngressLookup,liveIngressProofSchema,type LiveIngressScope,type LiveIngressProof} from './chatwoot-live-ingress.js';
import {chatwootEnvironment,readChatwootAccount,readChatwootConnection,IntegrationError,type ChatwootOptions} from './chatwoot-service.js';
import {beginChatwootMirrorAttempt,confirmChatwootMirrorAttempt,failChatwootMirrorAttempt,initializeChatwootAttendanceMap,type ChatwootObservationScope} from './chatwoot-attendance-store.js';

export interface GroupIntegrationJob {id:string;organization_id:string;integration_id:string;kind:'CHATWOOT_REPLY'|'MIRROR_MESSAGE';attempts:number;message_id:string|null;lease_token:string;payload:Record<string,unknown>}
/** Uses canonical integration jobs, attendance observations and messaging outbox.
 * The remote Contact is a group display envelope, never an individual recipient. */
export function createChatwootGroupWorker(options:ChatwootOptions,hooks:{before(job:GroupIntegrationJob,operation:string):Promise<void>;progress(job:GroupIntegrationJob,patch:Record<string,unknown>):Promise<void>;finish(job:GroupIntegrationJob):Promise<void>}){
 const env=chatwootEnvironment(options),tx=options.transact;
 const fail=()=>new IntegrationError('GROUP_CENTRAL_SCOPE_CHANGED',409);
 async function snapshot(t:TenantTransaction,job:GroupIntegrationJob,channel:string,conversation:string,providerScope?:string){
  if(!options.groupPolicy)throw fail();
  await lockAttendanceChannel(t,job.organization_id,channel);
  const current=await readGroupCentralSnapshot(t,{organizationId:job.organization_id,channelId:channel,conversationId:conversation,
   expectedWebhookBinding:await currentGroupWebhookBinding(t,job.organization_id,channel,options.groupPolicy),...(providerScope===undefined?{}:{providerScope})});
  if(!current||current.scope.integrationId!==job.integration_id)throw fail();
  const lease=(await t.query(`SELECT id FROM integration_jobs WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>clock_timestamp() FOR UPDATE`,[job.organization_id,job.id,job.lease_token])).rowCount;
  if(!lease)throw new IntegrationError('INTEGRATION_LEASE_LOST',409);
  return current;
 }
 async function assertCurrent(t:TenantTransaction,job:GroupIntegrationJob,expected:GroupCentralSnapshot,providerScope?:string){
  const current=await snapshot(t,job,expected.scope.channelId,expected.conversationId,providerScope);
  if(current.envelope.scopeKey!==expected.envelope.scopeKey||current.credentialRevision!==expected.credentialRevision||current.accountId!==expected.accountId||current.inboxId!==expected.inboxId)throw fail();
  return current;
 }
 const attendance=(s:GroupCentralSnapshot):ChatwootObservationScope=>({organizationId:s.scope.organizationId,channelId:s.scope.channelId,integrationId:s.scope.integrationId,destinationRevision:s.scope.destinationRevision,credentialRevision:s.credentialRevision,accountId:s.accountId,inboxId:s.inboxId});
 return {
  async mirror(job:GroupIntegrationJob):Promise<boolean>{
   const org=job.organization_id,originalOperation=job.payload.operation;
   const message=await tx(org,async t=>(await t.query<{id:string;conversation_id:string;channel_id:string;recipient_kind:string;direction:string;source:string;state:string;upstream_message_id:string|null;provider_scope:string;content:MessageContent;created_at:Date;is_historical:boolean;participant_jid:string|null}>(`SELECT m.id,m.conversation_id,m.channel_id,m.direction,m.source,m.state,m.upstream_message_id,m.provider_scope,m.content,m.created_at,m.is_historical,c.recipient_kind,f.participant_jid
    FROM messaging_messages m JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
    LEFT JOIN LATERAL(SELECT participant_jid FROM whatsapp_group_transport_facts f WHERE f.organization_id=m.organization_id AND f.message_id=m.id ORDER BY f.received_at LIMIT 1)f ON true
    WHERE m.organization_id=$1 AND m.id=$2`,[org,job.message_id])).rows[0]);
   if(message?.recipient_kind!=='GROUP')return false;
   if(message.is_historical)throw new IntegrationError('GROUP_CENTRAL_HISTORY_REQUIRES_HISTORY_SYNC',409);
   if(message.direction==='OUTGOING'&&['ACCEPTED','SENDING','UNKNOWN'].includes(message.state)){await hooks.finish(job);return true;}
   if(message.content.type!=='MEDIA'&&(message.content.type!=='TEXT'||!message.content.text))throw new IntegrationError('GROUP_CENTRAL_CONTENT_UNSUPPORTED',409);
   const current=await tx(org,t=>snapshot(t,job,message.channel_id,message.conversation_id,message.provider_scope)).catch(async error=>{
    if(error instanceof IntegrationError&&error.code==='GROUP_CENTRAL_SCOPE_CHANGED'){
     // A later read explains the observed failure, never replaces the admission
     // guard or asserts that a configuration change made this job safe to replay.
     const blocker=options.groupPolicy?await tx(org,async t=>readGroupCentralScopeBlocker(t,{organizationId:org,channelId:message.channel_id,
      conversationId:message.conversation_id,integrationId:job.integration_id,expectedWebhookBinding:await currentGroupWebhookBinding(t,org,message.channel_id,options.groupPolicy!)})).catch(()=>null):'GROUP_RUNTIME_POLICY_MISSING';
     if(blocker)await hooks.progress(job,{groupScopeBlocker:blocker});
    }
    throw error;
   });
   if(job.payload.groupScopeKey!==undefined&&job.payload.groupScopeKey!==current.envelope.scopeKey)throw fail();
   await hooks.progress(job,{groupScopeKey:current.envelope.scopeKey});
   const mapped=await tx(org,async t=>(await t.query<{remote_message_id:string}>('SELECT remote_message_id FROM chatwoot_messages WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3',[org,job.integration_id,message.id])).rows[0]);
   const hasPriorAttempt=Boolean((await tx(org,t=>t.query('SELECT id FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3 LIMIT 1',[org,job.integration_id,message.id]))).rowCount);
   const resumingNative=!mapped&&typeof job.payload.remoteMessageId==='number'&&job.payload.mirrorProtocol===LIVE_INGRESS_PROTOCOL;
   const rejectedPriorState=async(t:TenantTransaction,proof:LiveIngressProof)=>{
    await assertCurrent(t,job,current,message.provider_scope);
    return(await t.query<{state:string}>("SELECT a.state FROM chatwoot_mirror_attempts a WHERE a.organization_id=$1 AND a.id=$2 AND a.job_id=$3 AND a.integration_id=$4 AND a.channel_id=$5 AND a.message_id=$6 AND a.conversation_id=$7 AND a.remote_conversation_id=$8 AND a.destination_revision=$9 AND a.account_id=$10 AND a.inbox_id=$11 AND a.state='REJECTED' AND NOT EXISTS(SELECT 1 FROM chatwoot_mirror_attempts other WHERE other.organization_id=a.organization_id AND other.integration_id=a.integration_id AND other.message_id=a.message_id AND other.state IN('DISPATCHED','UNKNOWN')) FOR UPDATE OF a",
     [org,proof.attempt_id,job.id,job.integration_id,message.channel_id,message.id,message.conversation_id,proof.conversation_id,proof.destination_revision,proof.account_id,proof.inbox_id])).rows[0]?.state;
   };
   let rejectedRetryProof:LiveIngressProof|undefined;
   if(!mapped&&typeof job.payload.remoteMessageId!=='number'&&(job.payload.liveIngressProof!==undefined||job.payload.mirrorProtocol===LIVE_INGRESS_PROTOCOL)){
    const parsed=liveIngressProofSchema.safeParse(job.payload.liveIngressProof);
    if(job.payload.mirrorProtocol!==LIVE_INGRESS_PROTOCOL||!parsed.success||parsed.data.receipt_id!==undefined
     ||await tx(org,t=>rejectedPriorState(t,parsed.data))!=='REJECTED')throw new ChatwootError('CHATWOOT_LIVE_CONFIRMATION_PENDING',false,true);
    rejectedRetryProof=parsed.data;
   }

   let media:BinaryMedia|undefined;
   if(message.content.type==='MEDIA'&&!mapped&&typeof job.payload.remoteMessageId!=='number'){
    if(!options.media)throw new MediaError('MEDIA_NOT_CONFIGURED');
    const mediaId=message.content.mediaId;
    const authorize=async(t:TenantTransaction)=>{
     await assertCurrent(t,job,current,message.provider_scope);
     if(!(await t.query('SELECT id FROM messaging_media WHERE organization_id=$1 AND channel_id=$2 AND id=$3',[org,message.channel_id,mediaId])).rowCount)
      throw new MediaError('MEDIA_NOT_FOUND');
    };
    media={...(await options.media.read(org,mediaId,{authorize:t=>authorize(t as TenantTransaction)})),
     ...(message.content.caption?{caption:message.content.caption}:{})};
    await tx(org,t=>authorize(t));
   }
   const a=await tx(org,t=>readChatwootAccount(t,org));if(!a)throw fail();
   const client=env.client(a),scope=attendance(current);
   const guarded=async<T>(operation:string,mutation:boolean,work:()=>Promise<T>):Promise<T>=>{
    await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));await hooks.before(job,operation);
    await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));
    const value=await work();
    try{await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));}catch(error){if(mutation)throw new ChatwootError('GROUP_CENTRAL_CONFIRMATION_PENDING',false,true);throw error;}
    return value;
   };
   const liveScope:LiveIngressScope={organization_id:org,integration_id:job.integration_id,instance_id:current.scope.instanceId,destination_revision:current.scope.destinationRevision};
   // Capture the prior operation before any guard hook can record a new phase.
   const protocol=!mapped&&typeof job.payload.remoteMessageId!=='number'
    ?await guarded('GROUP_LIVE_CAPABILITY',false,()=>selectLiveMirrorProtocol({client,scope:liveScope,accountId:current.accountId,inboxId:current.inboxId,
      recorded:job.payload.mirrorProtocol,hasPriorAttempt,operation:originalOperation})):'GENERIC';
   let map=await tx(org,t=>readGroupRemoteMap(t,current));
   if(rejectedRetryProof&&(!map||Number(map.remote_conversation_id)!==rejectedRetryProof.conversation_id))
    throw new IntegrationError('CHATWOOT_LIVE_REQUEST_CONFLICT',409);
   if(!map){
    let contactId=typeof job.payload.contactId==='number'?job.payload.contactId:await guarded('GROUP_FIND_CONTACT',false,()=>client.findGroupContact(current.accountId,current.envelope.contact.identifier,current.envelope.scopeKey));
    if(!contactId)contactId=await guarded('GROUP_CREATE_CONTACT',true,()=>client.createGroupContact(current.accountId,current.envelope.contact));
    await hooks.progress(job,{contactId});
    const sourceId=typeof job.payload.sourceId==='string'?job.payload.sourceId:await guarded('GROUP_LINK_CONTACT',true,()=>client.linkContactInbox(current.accountId,contactId!,current.inboxId,current.envelope.sourceId));
    if(sourceId!==current.envelope.sourceId)throw new ChatwootError('GROUP_CENTRAL_SOURCE_MISMATCH',false,true);
    await hooks.progress(job,{sourceId});
    const inbox=await guarded('GROUP_INBOX_POLICY',false,()=>client.attendanceInbox(current.accountId,current.inboxId));
    if(inbox.id!==current.inboxId||inbox.channel_type!=='Channel::Api')throw new IntegrationError('CHATWOOT_BINDING_MISMATCH',409);
    if(inbox.greeting_enabled!==false||inbox.enable_auto_assignment!==false)throw new IntegrationError('CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION',409);
    if(await guarded('GROUP_EXECUTOR_POLICY',false,()=>client.inboxFlowBot(current.accountId,current.inboxId)))throw new IntegrationError('ATTENDANCE_REMOTE_EXECUTOR_CONFLICT',409);
    const conversationId=typeof job.payload.conversationId==='number'?job.payload.conversationId:await guarded('GROUP_CREATE_CONVERSATION',true,()=>client.createConversation(current.accountId,{inboxId:current.inboxId,contactId:contactId!,sourceId,status:'pending'}));
    await hooks.progress(job,{conversationId});
    const canonical=await guarded('GROUP_READ_CONVERSATION',false,()=>client.attendanceConversation(current.accountId,conversationId));
    if(canonical.id!==conversationId||canonical.account_id!==current.accountId||canonical.inbox_id!==current.inboxId)throw fail();
    await tx(org,async t=>{await assertCurrent(t,job,current,message.provider_scope);await saveGroupRemoteMap(t,current,{contactId:contactId!,sourceId,conversationId});await initializeChatwootAttendanceMap(t,scope,{conversationId:current.conversationId,remoteConversationId:conversationId,canonical});});
    map={contact_id:String(contactId),source_id:sourceId,remote_conversation_id:String(conversationId)};
   }
   const remote=Number(map.remote_conversation_id);
   let remoteMessageId=mapped?Number(mapped.remote_message_id):typeof job.payload.remoteMessageId==='number'?job.payload.remoteMessageId:undefined;
   if(!remoteMessageId){
    const text=groupMirrorText({direction:message.direction,source:message.source,
     text:message.content.type==='TEXT'?message.content.text:message.content.type==='MEDIA'?message.content.caption||'[Anexo]':'',participant:message.participant_jid});
    const occurredAt=protocol===LIVE_INGRESS_PROTOCOL?(rejectedRetryProof?rejectedRetryProof.occurred_at:Math.floor(message.created_at.getTime()/1000)):undefined;
    const body=protocol===LIVE_INGRESS_PROTOCOL?client.liveIngress().prepare(liveScope,{broker_message_id:message.id,conversation_id:remote,
     message_type:message.direction==='INCOMING'?'incoming':'outgoing',message_origin:message.source==='EXTERNAL_OBSERVED'?'EXTERNAL_OBSERVED':'LIVE',content:text,...(occurredAt===undefined?{}:{occurred_at:occurredAt})},media):undefined;
    await hooks.before(job,'GROUP_SEND_MESSAGE');
    const started=await tx(org,async t=>{
     await assertCurrent(t,job,current,message.provider_scope);
     if(rejectedRetryProof){
      if(!body)throw new IntegrationError('CHATWOOT_LIVE_REQUEST_CONFLICT',409);
      assertRejectedNativeRetry(rejectedRetryProof,body,{account_id:current.accountId,inbox_id:current.inboxId,credential_revision:current.credentialRevision,base_url:a.base_url},await rejectedPriorState(t,rejectedRetryProof));
     }
     const attempt=await beginChatwootMirrorAttempt(t,scope,{jobId:job.id,leaseToken:job.lease_token,messageId:message.id,conversationId:message.conversation_id,remoteConversationId:remote});
     const proof:LiveIngressProof|undefined=body?{...liveIngressLookup(body),attempt_id:attempt.id,account_id:current.accountId,inbox_id:current.inboxId,
      credential_revision:current.credentialRevision,base_url:a.base_url,...(body.occurred_at===undefined?{}:{occurred_at:body.occurred_at})}:undefined;
     const patch={mirrorProtocol:protocol,conversationId:remote,...(proof?{liveIngressProof:proof}:{})};
     const saved=await t.query("UPDATE integration_jobs SET payload=payload||$4::jsonb,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>clock_timestamp() RETURNING id",[org,job.id,job.lease_token,JSON.stringify(patch)]);
     if(!saved.rowCount)throw new IntegrationError('INTEGRATION_LEASE_LOST',409);
     return{attempt,proof,patch};
    });
    Object.assign(job.payload,started.patch);
    const attempt=started.attempt;
    const presentation={incoming:message.direction==='INCOMING',brokerMessageId:message.id,...(message.source==='EXTERNAL_OBSERVED'?{messageOrigin:'EXTERNAL_OBSERVED' as const}:{})};
    try{remoteMessageId=body&&started.proof?await dispatchNativeLiveMirror({client,body,proof:started.proof,accountId:current.accountId,...(media?{file:media}:{}),
     guard:(_operation,mutation,work)=>guarded('GROUP_SEND_MESSAGE',mutation,work),
     pin:async proof=>{await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));await hooks.progress(job,{liveIngressProof:proof});await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));}})
     :await guarded('GROUP_SEND_MESSAGE',true,()=>media?client.sendMedia(current.accountId,remote,media,{...presentation,presentationText:text})
      :client.sendMessage(current.accountId,remote,{...presentation,text}));}
    catch(error){try{await tx(org,t=>failChatwootMirrorAttempt(t,scope,{attemptId:attempt.id,uncertain:!(error instanceof ChatwootError)||error.uncertain}));}catch{}throw error;}
    try{await tx(org,async t=>{await assertCurrent(t,job,current,message.provider_scope);await confirmChatwootMirrorAttempt(t,scope,{attemptId:attempt.id,remoteMessageId:remoteMessageId!});await t.query('INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[org,job.integration_id,message.id,remoteMessageId]);});}
    catch{throw new ChatwootError('GROUP_CENTRAL_CONFIRMATION_PENDING',false,true);}
    await hooks.progress(job,{remoteMessageId});
   }
   if(resumingNative){
    const parsed=liveIngressProofSchema.safeParse(job.payload.liveIngressProof);
    if(!parsed.success)throw new IntegrationError('CHATWOOT_MIRROR_EVIDENCE_REQUIRED',409);
    const proof=parsed.data;
    if(proof.organization_id!==org||proof.integration_id!==job.integration_id||proof.instance_id!==current.scope.instanceId
     ||proof.destination_revision!==current.scope.destinationRevision||proof.credential_revision!==current.credentialRevision||proof.base_url!==a.base_url
     ||proof.account_id!==current.accountId||proof.inbox_id!==current.inboxId||proof.broker_message_id!==message.id||proof.conversation_id!==remote)
     throw new IntegrationError('CHATWOOT_LIVE_CONTEXT_CHANGED',409);
    await tx(org,async t=>{
     await assertCurrent(t,job,current,message.provider_scope);
     const confirmed=await t.query("SELECT id FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND id=$2 AND job_id=$3 AND integration_id=$4 AND channel_id=$5 AND message_id=$6 AND conversation_id=$7 AND remote_conversation_id=$8 AND remote_message_id=$9 AND destination_revision=$10 AND account_id=$11 AND inbox_id=$12 AND state='CONFIRMED' FOR UPDATE",
      [org,proof.attempt_id,job.id,job.integration_id,message.channel_id,message.id,message.conversation_id,remote,remoteMessageId,current.scope.destinationRevision,current.accountId,current.inboxId]);
     if(!confirmed.rowCount)throw new IntegrationError('CHATWOOT_MIRROR_EVIDENCE_REQUIRED',409);
     const linked=await t.query('INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,integration_id,message_id) DO UPDATE SET remote_message_id=chatwoot_messages.remote_message_id WHERE chatwoot_messages.remote_message_id=EXCLUDED.remote_message_id RETURNING remote_message_id',[org,job.integration_id,message.id,remoteMessageId]);
     if(!linked.rowCount)throw new IntegrationError('CHATWOOT_MIRROR_EVIDENCE_CONFLICT',409);
    });
   }
   if(message.direction==='OUTGOING'&&['SENT','DELIVERED','READ','FAILED'].includes(message.state)){
    const siblings=(await tx(org,t=>t.query<{id:string;state:string;canonical_error_code:string|null;upstream_message_id:string|null}>(
     'SELECT m.id,m.state,m.canonical_error_code,m.upstream_message_id FROM chatwoot_messages cm JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id WHERE cm.organization_id=$1 AND cm.integration_id=$2 AND cm.remote_message_id=$3 ORDER BY m.created_at,m.id',[org,job.integration_id,remoteMessageId]))).rows;
    const states=siblings.map(m=>m.state),state=states.includes('FAILED')?'failed':states.some(s=>['ACCEPTED','SENDING','UNKNOWN'].includes(s))?undefined:
     states.every(s=>s==='READ')?'read':states.every(s=>['READ','DELIVERED'].includes(s))?'delivered':'sent';
    if(!state){await hooks.finish(job);return true;}
    const representative=siblings[0],proof=representative&&(representative.upstream_message_id||state==='failed')
     ?{version:1 as const,canonical_message_id:representative.id,provider_message_id:representative.upstream_message_id,state:state.toUpperCase() as 'SENT'|'DELIVERED'|'READ'|'FAILED'}:undefined;
    await guarded('GROUP_UPDATE_STATUS',true,()=>client.updateMessageStatus(current.accountId,remote,remoteMessageId!,state,
     siblings.find(m=>m.canonical_error_code)?.canonical_error_code??undefined,proof));
   }
   await hooks.finish(job);return true;
  },
  async receiveReply(job:GroupIntegrationJob):Promise<boolean>{
   const org=job.organization_id,remote=job.payload.conversationId;
   if(typeof remote!=='number')return false;
   const mapped=await tx(org,async t=>(await t.query<{conversation_id:string;channel_id:string}>(`SELECT c.conversation_id,m.channel_id FROM chatwoot_conversations c JOIN messaging_conversations m ON m.organization_id=c.organization_id AND m.id=c.conversation_id WHERE c.organization_id=$1 AND c.integration_id=$2 AND c.remote_conversation_id=$3 AND m.recipient_kind='GROUP'`,[org,job.integration_id,remote])).rows[0]);
   if(!mapped)return false;
   if(Array.isArray(job.payload.attachments)&&typeof job.payload.caption==='string'&&job.payload.caption.length>1024)throw new IntegrationError('GROUP_CENTRAL_MEDIA_CAPTION_LIMIT',409);
   let data:ReturnType<typeof requireGroupReply>;try{data=requireGroupReply(job.payload);}catch{throw new IntegrationError(Array.isArray(job.payload.attachments)?'GROUP_CENTRAL_MEDIA_PROOF_REQUIRED':'GROUP_CENTRAL_PUBLIC_TEXT_REQUIRED',409);}
   let mediaScope:GroupCentralSnapshot|undefined,humanCanonical:unknown;
   if(data.attachments){
    const captured=await tx(org,async t=>{const current=await snapshot(t,job,mapped.channel_id,mapped.conversation_id),map=await readGroupRemoteMap(t,current);
     if(!map||Number(map.remote_conversation_id)!==remote||data.destinationRevision!==current.scope.destinationRevision)throw fail();
     const account=await readChatwootAccount(t,org);if(!account)throw fail();return{current,account};});
    mediaScope=captured.current;
    humanCanonical=await env.client(captured.account).canonicalMessage(mediaScope.accountId,mediaScope.inboxId,remote,data.messageId);
    await tx(org,t=>assertCurrent(t,job,captured.current));
   }
   await tx(org,async t=>{
    const current=mediaScope?await assertCurrent(t,job,mediaScope):await snapshot(t,job,mapped.channel_id,mapped.conversation_id),map=await readGroupRemoteMap(t,current);
    if(!map||Number(map.remote_conversation_id)!==remote||data.destinationRevision!==current.scope.destinationRevision)throw fail();
    const evidence=(await t.query<{attendance_revision:number;event:ChatwootAttendanceEvent;credential_revision:number;channel_id:string}>(`SELECT m.attendance_revision,o.event,o.credential_revision,o.channel_id FROM messaging_conversations m
     JOIN chatwoot_attendance_observations o ON o.organization_id=m.organization_id AND o.conversation_id=m.id
     JOIN chatwoot_attendance_controls c ON c.organization_id=m.organization_id AND c.conversation_id=m.id
     WHERE m.organization_id=$1 AND m.id=$2 AND m.mode='HUMAN' AND o.id=$3 AND o.disposition='APPLIED' AND o.event->>'kind'='HUMAN_PUBLIC'
      AND o.event->>'mayForwardReply'='true' AND o.event->>'remoteMessageId'=$4::text AND o.integration_id=$5 AND o.destination_revision=$6
      AND o.account_id=$7 AND o.inbox_id=$8 AND o.remote_conversation_id=$9 AND c.state='HUMAN' AND c.integration_id=o.integration_id AND c.destination_revision=o.destination_revision
      AND c.remote_conversation_id=o.remote_conversation_id AND c.cycle=o.cycle`,[org,mapped.conversation_id,data.attendanceObservationId,data.messageId,job.integration_id,current.scope.destinationRevision,current.accountId,current.inboxId,remote])).rows[0];
    if(!evidence)throw new IntegrationError('ATTENDANCE_CONTROL_RECONCILIATION_REQUIRED',409);
    if(data.attachments){
     const event=evidence.event;
     if(event.kind!=='HUMAN_PUBLIC'||event.outboundIntentId!==data.outboundIntentId||event.senderId===undefined||
      event.remoteMessageId!==data.messageId||event.remoteConversationId!==remote||evidence.credential_revision!==current.credentialRevision||evidence.channel_id!==mapped.channel_id)
      throw new IntegrationError('CHATWOOT_HUMAN_INTENT_NOT_PROVEN',409);
     requireCanonicalHumanIntent(humanCanonical,{intentId:data.outboundIntentId,integrationId:job.integration_id,accountId:current.accountId,inboxId:current.inboxId,
      conversationId:remote,messageId:data.messageId,senderId:event.senderId,attachments:data.attachments,...(data.caption!==undefined?{caption:data.caption}:{})});
    }
    const contents:MessageContent[]=[];
    if(data.content)contents.push(data.content);
    else for(const[index,attachment]of data.attachments.entries()){
     const mediaId=await registerPendingMedia(t,org,mapped.channel_id,{source:'CHATWOOT',sourceKey:['group',job.integration_id,current.scope.destinationRevision,current.credentialRevision,data.messageId,attachment.id].join(':'),kind:attachment.kind,fileName:attachment.kind,
      descriptor:{integrationId:job.integration_id,conversationId:remote,messageId:data.messageId,attachmentId:attachment.id,groupReply:true,destinationRevision:current.scope.destinationRevision,credentialRevision:current.credentialRevision}});
     contents.push({type:'MEDIA',mediaId,kind:attachment.kind,fileName:attachment.kind,...(index===0&&data.caption?{caption:data.caption}:{})});
    }
    const requestHash=createHash('sha256').update(JSON.stringify(['group-media-reply-v1',current.envelope.scopeKey,current.credentialRevision,data])).digest('hex');let firstId:string|undefined;
    for(const[index,content]of contents.entries()){
     const key=['chatwoot-group',job.integration_id,data.destinationRevision,data.messageId].join(':')+(content.type==='MEDIA'?':'+index:''),
      hash=content.type==='TEXT'?createHash('sha256').update(JSON.stringify(content)).digest('hex'):requestHash;
     const message=(await t.query<{id:string;idempotency_body_hash:string}>("INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR',$5,'ACCEPTED',$6,$7) ON CONFLICT(organization_id,channel_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,idempotency_body_hash",[randomUUID(),org,mapped.channel_id,mapped.conversation_id,content,key,hash])).rows[0]!;
     if(message.idempotency_body_hash!==hash)throw new IntegrationError('IDEMPOTENCY_CONFLICT',409);firstId??=message.id;
     await t.query('INSERT INTO chatwoot_group_replies(organization_id,message_id,scope_key,channel_id,conversation_id,observation_id,attendance_revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[org,message.id,current.envelope.scopeKey,mapped.channel_id,mapped.conversation_id,data.attendanceObservationId,evidence.attendance_revision]);
     await t.query('INSERT INTO messaging_outbox(organization_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[org,message.id]);
     await t.query('INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[org,job.integration_id,message.id,data.messageId]);
    }
    await t.query("UPDATE integration_jobs SET status='SUCCEEDED',message_id=$4,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND lease_token=$3",[org,job.id,job.lease_token,firstId]);
   });return true;
  },
 };
}
