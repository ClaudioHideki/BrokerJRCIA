import {createHash,randomUUID} from 'node:crypto';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {lockAttendanceChannel} from '../attendance/repository.js';
import {currentGroupWebhookBinding} from '../whatsapp-groups/automation-authority.js';
import {readGroupCentralSnapshot,readGroupRemoteMap,saveGroupRemoteMap,type GroupCentralSnapshot} from '../whatsapp-groups/central-group-store.js';
import {groupMirrorText,requireGroupReply} from '../whatsapp-groups/bridge-policy.js';
import {ChatwootError} from './chatwoot-client.js';
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
   const org=job.organization_id;
   const message=await tx(org,async t=>(await t.query<{id:string;conversation_id:string;channel_id:string;recipient_kind:string;direction:string;source:string;state:string;provider_scope:string;content:{type:string;text?:string};participant_jid:string|null}>(`SELECT m.id,m.conversation_id,m.channel_id,m.direction,m.source,m.state,m.provider_scope,m.content,c.recipient_kind,f.participant_jid
    FROM messaging_messages m JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
    LEFT JOIN LATERAL(SELECT participant_jid FROM whatsapp_group_transport_facts f WHERE f.organization_id=m.organization_id AND f.message_id=m.id ORDER BY f.received_at LIMIT 1)f ON true
    WHERE m.organization_id=$1 AND m.id=$2`,[org,job.message_id])).rows[0]);
   if(message?.recipient_kind!=='GROUP')return false;
   if(message.direction==='OUTGOING'&&['ACCEPTED','SENDING','UNKNOWN'].includes(message.state)){await hooks.finish(job);return true;}
   if(message.content.type!=='TEXT'||!message.content.text)throw new IntegrationError('GROUP_CENTRAL_CONTENT_UNSUPPORTED',409);
   const current=await tx(org,t=>snapshot(t,job,message.channel_id,message.conversation_id,message.provider_scope));
   if(job.payload.groupScopeKey!==undefined&&job.payload.groupScopeKey!==current.envelope.scopeKey)throw fail();
   await hooks.progress(job,{groupScopeKey:current.envelope.scopeKey});
   const a=await tx(org,t=>readChatwootAccount(t,org));if(!a)throw fail();
   const client=env.client(a),scope=attendance(current);
   const guarded=async<T>(operation:string,mutation:boolean,work:()=>Promise<T>):Promise<T>=>{
    await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));await hooks.before(job,operation);
    await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));
    const value=await work();
    try{await tx(org,t=>assertCurrent(t,job,current,message.provider_scope));}catch(error){if(mutation)throw new ChatwootError('GROUP_CENTRAL_CONFIRMATION_PENDING',false,true);throw error;}
    return value;
   };
   let map=await tx(org,t=>readGroupRemoteMap(t,current));
   if(!map){
    let contactId=typeof job.payload.contactId==='number'?job.payload.contactId:await guarded('GROUP_FIND_CONTACT',false,()=>client.findGroupContact(current.accountId,current.envelope.contact.identifier,current.envelope.scopeKey));
    if(!contactId)contactId=await guarded('GROUP_CREATE_CONTACT',true,()=>client.createGroupContact(current.accountId,current.envelope.contact));
    await hooks.progress(job,{contactId});
    const sourceId=typeof job.payload.sourceId==='string'?job.payload.sourceId:await guarded('GROUP_LINK_CONTACT',true,()=>client.linkContactInbox(current.accountId,contactId!,current.inboxId,current.envelope.sourceId));
    if(sourceId!==current.envelope.sourceId)throw new ChatwootError('GROUP_CENTRAL_SOURCE_MISMATCH',false,true);
    await hooks.progress(job,{sourceId});
    const inbox=await guarded('GROUP_INBOX_POLICY',false,()=>client.attendanceInbox(current.accountId,current.inboxId));
    if(inbox.id!==current.inboxId||inbox.channel_type!=='Channel::Api'||inbox.greeting_enabled!==false||inbox.enable_auto_assignment!==false)throw new IntegrationError('CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION',409);
    if(await guarded('GROUP_EXECUTOR_POLICY',false,()=>client.inboxFlowBot(current.accountId,current.inboxId)))throw new IntegrationError('ATTENDANCE_REMOTE_EXECUTOR_CONFLICT',409);
    const conversationId=typeof job.payload.conversationId==='number'?job.payload.conversationId:await guarded('GROUP_CREATE_CONVERSATION',true,()=>client.createConversation(current.accountId,{inboxId:current.inboxId,contactId:contactId!,sourceId,status:'pending'}));
    await hooks.progress(job,{conversationId});
    const canonical=await guarded('GROUP_READ_CONVERSATION',false,()=>client.attendanceConversation(current.accountId,conversationId));
    if(canonical.id!==conversationId||canonical.account_id!==current.accountId||canonical.inbox_id!==current.inboxId)throw fail();
    await tx(org,async t=>{await assertCurrent(t,job,current,message.provider_scope);await saveGroupRemoteMap(t,current,{contactId:contactId!,sourceId,conversationId});await initializeChatwootAttendanceMap(t,scope,{conversationId:current.conversationId,remoteConversationId:conversationId,canonical});});
    map={contact_id:String(contactId),source_id:sourceId,remote_conversation_id:String(conversationId)};
   }
   const remote=Number(map.remote_conversation_id);
   const mapped=await tx(org,async t=>(await t.query<{remote_message_id:string}>('SELECT remote_message_id FROM chatwoot_messages WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3',[org,job.integration_id,message.id])).rows[0]);
   let remoteMessageId=mapped?Number(mapped.remote_message_id):typeof job.payload.remoteMessageId==='number'?job.payload.remoteMessageId:undefined;
   if(!remoteMessageId){
    const text=groupMirrorText({direction:message.direction,source:message.source,text:message.content.text,participant:message.participant_jid});
    await hooks.before(job,'GROUP_SEND_MESSAGE');
    const attempt=await tx(org,async t=>{await assertCurrent(t,job,current,message.provider_scope);return beginChatwootMirrorAttempt(t,scope,{jobId:job.id,leaseToken:job.lease_token,messageId:message.id,conversationId:message.conversation_id,remoteConversationId:remote});});
    try{remoteMessageId=await guarded('GROUP_SEND_MESSAGE',true,()=>client.sendMessage(current.accountId,remote,{text,incoming:message.direction==='INCOMING',brokerMessageId:message.id,...(message.source==='EXTERNAL_OBSERVED'?{messageOrigin:'EXTERNAL_OBSERVED' as const}:{})}));}
    catch(error){try{await tx(org,t=>failChatwootMirrorAttempt(t,scope,{attemptId:attempt.id,uncertain:!(error instanceof ChatwootError)||error.uncertain}));}catch{}throw error;}
    try{await tx(org,async t=>{await assertCurrent(t,job,current,message.provider_scope);await confirmChatwootMirrorAttempt(t,scope,{attemptId:attempt.id,remoteMessageId:remoteMessageId!});await t.query('INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[org,job.integration_id,message.id,remoteMessageId]);});}
    catch{throw new ChatwootError('GROUP_CENTRAL_CONFIRMATION_PENDING',false,true);}
    await hooks.progress(job,{remoteMessageId});
   }
   if(message.direction==='OUTGOING'&&['SENT','DELIVERED','READ','FAILED'].includes(message.state))await guarded('GROUP_UPDATE_STATUS',true,()=>client.updateMessageStatus(current.accountId,remote,remoteMessageId!,message.state.toLowerCase() as 'sent'|'delivered'|'read'|'failed'));
   await hooks.finish(job);return true;
  },
  async receiveReply(job:GroupIntegrationJob):Promise<boolean>{
   const org=job.organization_id,remote=job.payload.conversationId;
   if(typeof remote!=='number')return false;
   const mapped=await tx(org,async t=>(await t.query<{conversation_id:string;channel_id:string}>(`SELECT c.conversation_id,m.channel_id FROM chatwoot_conversations c JOIN messaging_conversations m ON m.organization_id=c.organization_id AND m.id=c.conversation_id WHERE c.organization_id=$1 AND c.integration_id=$2 AND c.remote_conversation_id=$3 AND m.recipient_kind='GROUP'`,[org,job.integration_id,remote])).rows[0]);
   if(!mapped)return false;
   let data:ReturnType<typeof requireGroupReply>;try{data=requireGroupReply(job.payload);}catch{throw new IntegrationError('GROUP_CENTRAL_PUBLIC_TEXT_REQUIRED',409);}
   await tx(org,async t=>{
    const current=await snapshot(t,job,mapped.channel_id,mapped.conversation_id),map=await readGroupRemoteMap(t,current);
    if(!map||Number(map.remote_conversation_id)!==remote||data.destinationRevision!==current.scope.destinationRevision)throw fail();
    const evidence=(await t.query<{attendance_revision:number}>(`SELECT m.attendance_revision FROM messaging_conversations m
     JOIN chatwoot_attendance_observations o ON o.organization_id=m.organization_id AND o.conversation_id=m.id
     JOIN chatwoot_attendance_controls c ON c.organization_id=m.organization_id AND c.conversation_id=m.id
     WHERE m.organization_id=$1 AND m.id=$2 AND m.mode='HUMAN' AND o.id=$3 AND o.disposition='APPLIED' AND o.event->>'kind'='HUMAN_PUBLIC'
      AND o.event->>'mayForwardReply'='true' AND o.event->>'remoteMessageId'=$4::text AND o.integration_id=$5 AND o.destination_revision=$6
      AND o.account_id=$7 AND o.inbox_id=$8 AND o.remote_conversation_id=$9 AND c.state='HUMAN' AND c.integration_id=o.integration_id AND c.destination_revision=o.destination_revision
      AND c.remote_conversation_id=o.remote_conversation_id AND c.cycle=o.cycle`,[org,mapped.conversation_id,data.attendanceObservationId,data.messageId,job.integration_id,current.scope.destinationRevision,current.accountId,current.inboxId,remote])).rows[0];
    if(!evidence)throw new IntegrationError('ATTENDANCE_CONTROL_RECONCILIATION_REQUIRED',409);
    const key=`chatwoot-group:${job.integration_id}:${data.destinationRevision}:${data.messageId}`,hash=createHash('sha256').update(JSON.stringify(data.content)).digest('hex');
    const message=(await t.query<{id:string;idempotency_body_hash:string}>(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
     VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR',$5,'ACCEPTED',$6,$7) ON CONFLICT(organization_id,channel_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,idempotency_body_hash`,[randomUUID(),org,mapped.channel_id,mapped.conversation_id,data.content,key,hash])).rows[0]!;
    if(message.idempotency_body_hash!==hash)throw new IntegrationError('IDEMPOTENCY_CONFLICT',409);
    await t.query(`INSERT INTO chatwoot_group_replies(organization_id,message_id,scope_key,channel_id,conversation_id,observation_id,attendance_revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[org,message.id,current.envelope.scopeKey,mapped.channel_id,mapped.conversation_id,data.attendanceObservationId,evidence.attendance_revision]);
    await t.query('INSERT INTO messaging_outbox(organization_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[org,message.id]);
    await t.query('INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[org,job.integration_id,message.id,data.messageId]);
    await t.query("UPDATE integration_jobs SET status='SUCCEEDED',message_id=$4,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND lease_token=$3",[org,job.id,job.lease_token,message.id]);
   });return true;
  },
 };
}
