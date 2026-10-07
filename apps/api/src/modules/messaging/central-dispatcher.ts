import { randomBytes,randomUUID } from 'node:crypto';
import type { OrganizationTransaction,TenantTransaction } from '../../db/tenant-transaction.js';
import type { OutboxRow } from '../automations/repository.js';
import type { Message } from './types.js';
import { readCentralTransportBinding,readCentralTransportContext } from './central-transport.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { runtimeAuthorityAllows } from '../attendance/runtime-authority.js';
import { readChatwootAttendanceGate } from '../attendance/control-service.js';
import { initializeChatwootAttendanceMap,confirmChatwootMirrorAttempt,failChatwootMirrorAttempt } from '../integrations/chatwoot-attendance-store.js';
import type { AccountRow } from '../integrations/chatwoot-context.js';
import { ChatwootClient,ChatwootError } from '../integrations/chatwoot-client.js';
import type { CentralRuntimeEventBinding } from '../integrations/chatwoot-runtime-event.js';

type Receipt={id:string;channel_id:string;integration_id:string;conversation_id:string;message_id:string;remote_conversation_id:string;
 origin:string;destination_revision:number;credential_version:number;owner_revision:number;control_revision:number;cycle:number;
 execution_id:string;automation_id:string;version:number;state:string;ack_message_id:string|null;remote_message_id:string|null;
 lease_token:string;lease_expires_at:Date|null;created_at:Date;reconcile_attempts:number;dispatch_proof:string;sender_id:string|null};
type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;client(account:AccountRow):ChatwootClient;enabled:boolean};
const observationScope=(binding:CentralRuntimeEventBinding)=>({...binding,credentialRevision:binding.credentialVersion});
const authority=(org:string,r:Receipt)=>({organizationId:org,channelId:r.channel_id,conversationId:r.conversation_id,automationId:r.automation_id,version:r.version});
const matches=(r:Receipt,b:CentralRuntimeEventBinding)=>r.channel_id===b.channelId&&r.origin===b.origin&&r.destination_revision===b.destinationRevision&&
 r.credential_version===b.credentialVersion&&r.owner_revision===b.ownerRevision;

/** Caller locks the channel before enqueueOutgoing. Enqueue acknowledgment is not transport delivery. */
export async function reserveCentralAutomationSend(tx:TenantTransaction,item:OutboxRow,message:Message) {
 const integration=(await tx.query<{integration_id:string}>('SELECT integration_id FROM central_transport_bindings WHERE organization_id=$1 AND channel_id=$2',[item.organizationId,item.channelId])).rows[0];
 if(!integration)throw new Error('CENTRAL_BINDING_NOT_FOUND');
 const {binding}=await readCentralTransportBinding(tx,item.organizationId,integration.integration_id,true);
 const execution=(await tx.query<{automation_id:string;version:number}>('SELECT automation_id,version FROM automation_executions WHERE organization_id=$1 AND id=$2 AND channel_id=$3 AND conversation_id=$4',[item.organizationId,item.executionId,item.channelId,item.conversationId])).rows[0];
 const map=(await tx.query<{remote_conversation_id:string}>('SELECT remote_conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3',[item.organizationId,binding.integrationId,item.conversationId])).rows[0];
 const gate=await readChatwootAttendanceGate(tx,{organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId!});
 if(!execution||!map?.remote_conversation_id||!gate.allowed||gate.cycle===null||!await runtimeAuthorityAllows(tx,{organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId,automationId:execution.automation_id,version:execution.version}))
  throw new Error('CENTRAL_ATTENDANCE_BLOCKED');
 await tx.query(`INSERT INTO chatwoot_mirror_attempts(organization_id,channel_id,integration_id,destination_revision,account_id,inbox_id,conversation_id,remote_conversation_id,
 cycle,message_id,job_id,lease_token,state,transport,origin,credential_version,owner_revision,control_revision,execution_id,automation_id,version,dispatch_proof)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,'RESERVED','CENTRAL_TRANSPORT',$12,$13,$14,$15,$16,$17,$18,$19)
 ON CONFLICT(organization_id,message_id) WHERE transport='CENTRAL_TRANSPORT' DO NOTHING`,
 [item.organizationId,item.channelId,binding.integrationId,binding.destinationRevision,binding.accountId,binding.inboxId,item.conversationId,map.remote_conversation_id,gate.cycle,message.id,randomUUID(),binding.origin,binding.credentialVersion,binding.ownerRevision,gate.revision,item.executionId,execution.automation_id,execution.version,randomBytes(32).toString('base64url')]);
}

/** No provider resolver exists here. Every mutation uses only the tenant's approved central client. */
export function createCentralDispatcher(options:Options) {
 const {transact}=options;
 async function context(org:string,r:Receipt) {
  return transact(org,async tx=>{
   const {binding,account}=await readCentralTransportContext(tx,org,r.integration_id);
   if(!matches(r,binding))throw new Error('CENTRAL_CONTEXT_CHANGED');
   const message=(await tx.query<{content:{type:string;text?:string};state:string}>('SELECT content,state FROM messaging_messages WHERE organization_id=$1 AND id=$2 AND channel_id=$3 AND conversation_id=$4',[org,r.message_id,r.channel_id,r.conversation_id])).rows[0];
   if(!message||message.content.type!=='TEXT'||typeof message.content.text!=='string')throw new Error('CENTRAL_TEXT_REQUIRED');
   return {binding,account,text:message.content.text};
  });
 }
 async function uncertain(org:string,r:Receipt,ack?:number) {
  await transact(org,async tx=>{
   await tx.query(`UPDATE chatwoot_mirror_attempts SET state='UNKNOWN',ack_message_id=coalesce(ack_message_id,$3),available_at=now()+interval '30 seconds',error_code='CENTRAL_OUTCOME_UNKNOWN',updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND state IN ('DISPATCHED','UNKNOWN')`,[org,r.id,ack??null]);
   await tx.query("UPDATE messaging_messages SET state='UNKNOWN',canonical_error_code='CENTRAL_OUTCOME_UNKNOWN',updated_at=now() WHERE organization_id=$1 AND id=$2 AND state='SENDING'",[org,r.message_id]);
  });
 }
 async function rejectReservation(org:string,r:Receipt) {
  await transact(org,async tx=>{
   await lockAttendanceChannel(tx,org,r.channel_id);
   const owned=(await tx.query("UPDATE chatwoot_mirror_attempts SET state='REJECTED',error_code='CENTRAL_CONTEXT_OR_CONTROL_CHANGED',updated_at=now() WHERE organization_id=$1 AND id=$2 AND state='RESERVED' AND lease_token=$3 RETURNING message_id",[org,r.id,r.lease_token])).rowCount;
   if(!owned)return;
   await tx.query("UPDATE messaging_messages SET state='FAILED',canonical_error_code='CENTRAL_CONTEXT_OR_CONTROL_CHANGED',updated_at=now() WHERE organization_id=$1 AND id=$2 AND state='ACCEPTED'",[org,r.message_id]);
   await tx.query('DELETE FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2',[org,r.message_id]);
  });
 }
 async function confirm(org:string,r:Receipt,remoteId:number,canonical:Awaited<ReturnType<ChatwootClient['canonicalMessage']>>) {
  await transact(org,async tx=>{
   const {binding}=await readCentralTransportBinding(tx,org,r.integration_id,true);
   if(!matches(r,binding))throw new Error('CENTRAL_CONTEXT_CHANGED');
   const current=(await tx.query<Receipt>('SELECT * FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,r.id])).rows[0];
   if(!current||current.state==='CONFIRMED')return;
   if(!['DISPATCHED','UNKNOWN'].includes(current.state)||current.ack_message_id!==null&&Number(current.ack_message_id)!==remoteId)throw new Error('CENTRAL_RECEIPT_CONFLICT');
   const message=(await tx.query<{content:{type:string;text:string}}>('SELECT content FROM messaging_messages WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,r.message_id])).rows[0];
   if(canonical.id!==remoteId||canonical.message_type!=='outgoing'||canonical.private||canonical.content_type!==undefined&&canonical.content_type!=='text'||canonical.attachments?.length||
    canonical.content!==message?.content.text||canonical.content_attributes.jrc_broker_message_id!==r.message_id||
    canonical.content_attributes.jrc_broker_dispatch_proof!==current.dispatch_proof||!current.sender_id||canonical.sender?.id!==Number(current.sender_id)||
    canonical.sender.type!==undefined&&canonical.sender.type!=='user'||!['sent','delivered','read'].includes(canonical.status??'')||
    canonical.created_at*1000<r.created_at.getTime()-300000)throw new Error('CENTRAL_RECEIPT_NOT_PROVEN');
   await confirmChatwootMirrorAttempt(tx,observationScope(binding),{attemptId:r.id,remoteMessageId:remoteId});
   await tx.query(`INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(organization_id,integration_id,message_id) DO NOTHING`,[org,r.integration_id,r.message_id,remoteId]);
   await tx.query(`UPDATE messaging_messages SET state=$3,upstream_message_id=$4,canonical_error_code=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2 AND state IN ('SENDING','UNKNOWN')`,[org,r.message_id,canonical.status==='read'?'READ':canonical.status==='delivered'?'DELIVERED':'SENT',`central:${r.integration_id}:${remoteId}`]);
   await tx.query('DELETE FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2',[org,r.message_id]);
  });
 }
 async function reconcile(org:string) {
  const r=await transact(org,async tx=>{
   const row=(await tx.query<Receipt>(`SELECT * FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND transport='CENTRAL_TRANSPORT'
    AND available_at<=now() AND (state='UNKNOWN' OR state='DISPATCHED' AND lease_expires_at<=now()) ORDER BY available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[org])).rows[0];
   if(row)await tx.query("UPDATE chatwoot_mirror_attempts SET available_at=now()+interval '60 seconds',reconcile_attempts=reconcile_attempts+1 WHERE organization_id=$1 AND id=$2",[org,row.id]);
   return row;
  });
  if(!r)return false;
  await uncertain(org,r);
  try{
   const c=await context(org,r),client=options.client(c.account),conversationId=Number(r.remote_conversation_id);
   const conversation=await client.attendanceConversation(c.binding.accountId,conversationId);
   if(conversation.inbox_id!==c.binding.inboxId)throw new Error('CENTRAL_CONTEXT_CHANGED');
   const candidates=r.ack_message_id!==null?[await client.canonicalMessage(c.binding.accountId,c.binding.inboxId,conversationId,Number(r.ack_message_id))]:
    (await client.centralMessages(c.binding.accountId,c.binding.inboxId,conversationId)).filter(m=>m.content_attributes.jrc_broker_message_id===r.message_id&&
     m.content_attributes.jrc_broker_dispatch_proof===r.dispatch_proof&&m.sender?.id===Number(r.sender_id)&&m.content===c.text&&m.message_type==='outgoing'&&!m.private);
   if(candidates.length!==1)throw new Error('CENTRAL_RECEIPT_NOT_PROVEN');
   await confirm(org,r,candidates[0]!.id,candidates[0]!);
  }catch{
   await transact(org,tx=>tx.query("UPDATE chatwoot_mirror_attempts SET available_at=now()+(LEAST(900,30*power(2,LEAST(reconcile_attempts,5)))*interval '1 second') WHERE organization_id=$1 AND id=$2 AND state='UNKNOWN'",[org,r.id]));
  }
  return true;
 }
 async function dispatch(org:string) {
  const r=await transact(org,async tx=>{
   const row=(await tx.query<Receipt>(`SELECT a.* FROM chatwoot_mirror_attempts a JOIN messaging_messages m ON m.organization_id=a.organization_id AND m.id=a.message_id
   WHERE a.organization_id=$1 AND a.transport='CENTRAL_TRANSPORT' AND a.state='RESERVED' AND m.state='ACCEPTED'
   AND a.available_at<=now() AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=now())
   AND NOT EXISTS(SELECT 1 FROM messaging_messages p WHERE p.organization_id=m.organization_id AND p.conversation_id=m.conversation_id AND p.direction='OUTGOING'
    AND p.state IN ('ACCEPTED','SENDING','UNKNOWN') AND (p.created_at,p.id)<(m.created_at,m.id)) ORDER BY a.available_at,a.created_at,a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,[org])).rows[0];
   if(!row)return undefined;
   return (await tx.query<Receipt>(`UPDATE chatwoot_mirror_attempts SET lease_token=$3,lease_expires_at=now()+interval '120 seconds',
    reconcile_attempts=reconcile_attempts+1 WHERE organization_id=$1 AND id=$2 RETURNING *`,[org,row.id,randomUUID()])).rows[0];
  });
  if(!r)return false;
  let c:Awaited<ReturnType<typeof context>>,client:ChatwootClient;
  try{c=await context(org,r);client=options.client(c.account);
   const senderId=await client.centralSender(c.binding.accountId);
   const canonical=await client.attendanceConversation(c.binding.accountId,Number(r.remote_conversation_id));
   const claimed=await transact(org,async tx=>{
    const {binding}=await readCentralTransportBinding(tx,org,r.integration_id,true);
    if(!matches(r,binding))throw new Error('CENTRAL_CONTEXT_CHANGED');
    await initializeChatwootAttendanceMap(tx,observationScope(binding),{conversationId:r.conversation_id,remoteConversationId:Number(r.remote_conversation_id),canonical});
    const gate=await readChatwootAttendanceGate(tx,authority(org,r));
    if(gate.cycle!==r.cycle||gate.state==='HUMAN'||gate.state==='PAUSED'||!await runtimeAuthorityAllows(tx,authority(org,r)))throw new Error('CENTRAL_ATTENDANCE_BLOCKED');
    if(!gate.allowed)throw new ChatwootError('CENTRAL_CONTROL_PENDING',true);
    const own=(await tx.query(`UPDATE chatwoot_mirror_attempts SET state='DISPATCHED',sender_id=$4,lease_expires_at=now()+interval '120 seconds',updated_at=now()
     WHERE organization_id=$1 AND id=$2 AND state='RESERVED' AND lease_token=$3 AND lease_expires_at>now() RETURNING id`,[org,r.id,r.lease_token,senderId])).rowCount;
    if(!own)return false;
    const outbox=(await tx.query(`UPDATE messaging_outbox SET lease_token=$3,lease_expires_at=now()+interval '120 seconds',attempt_count=attempt_count+1,updated_at=now()
     WHERE organization_id=$1 AND message_id=$2 RETURNING message_id`,[org,r.message_id,r.lease_token])).rowCount;
    const marked=(await tx.query("UPDATE messaging_messages SET state='SENDING',updated_at=now() WHERE organization_id=$1 AND id=$2 AND state='ACCEPTED' RETURNING id",[org,r.message_id])).rowCount;
    if(!outbox||!marked)throw new Error('CENTRAL_OUTBOX_LOST');
    return true;
   });
   if(!claimed)return false;
  }catch(error){
   // A leased, bounded preflight may retry. It must yield to other conversations.
   if(error instanceof ChatwootError&&error.retrySafe&&r.reconcile_attempts<10){
    await transact(org,tx=>tx.query(`UPDATE chatwoot_mirror_attempts SET lease_expires_at=NULL,
     available_at=now()+(LEAST(900,30*power(2,LEAST(reconcile_attempts,5)))*interval '1 second'),error_code='CENTRAL_PREFLIGHT_RETRY'
     WHERE organization_id=$1 AND id=$2 AND state='RESERVED' AND lease_token=$3`,[org,r.id,r.lease_token]));
    return true;
   }
   await rejectReservation(org,r);return true;
  }
  let ack:number|undefined;
  try{
   ack=await client.sendMessage(c.binding.accountId,Number(r.remote_conversation_id),{text:c.text,incoming:false,brokerMessageId:r.message_id,dispatchProof:r.dispatch_proof});
   await transact(org,tx=>tx.query('UPDATE chatwoot_mirror_attempts SET ack_message_id=$3 WHERE organization_id=$1 AND id=$2 AND state=\'DISPATCHED\'',[org,r.id,ack]));
   const remote=await client.canonicalMessage(c.binding.accountId,c.binding.inboxId,Number(r.remote_conversation_id),ack);
   await confirm(org,r,ack,remote);
  }catch(error){
   if(ack===undefined&&error instanceof ChatwootError&&!error.uncertain){
    try{await transact(org,async tx=>{const {binding}=await readCentralTransportBinding(tx,org,r.integration_id,true);if(!matches(r,binding))throw new Error('CENTRAL_CONTEXT_CHANGED');
     await failChatwootMirrorAttempt(tx,observationScope(binding),{attemptId:r.id,uncertain:false});
     await tx.query("UPDATE messaging_messages SET state='FAILED',canonical_error_code='CENTRAL_SEND_REJECTED',updated_at=now() WHERE organization_id=$1 AND id=$2 AND state='SENDING'",[org,r.message_id]);
     await tx.query('DELETE FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2',[org,r.message_id]);
    });}catch{await uncertain(org,r);}
   }else await uncertain(org,r,ack);
  }
  return true;
 }
 return {async runOnce(org:string){if(!options.enabled)return {processed:false};
  await transact(org,tx=>tx.query(`UPDATE chatwoot_mirror_attempts a SET state='REJECTED',error_code='CENTRAL_MESSAGE_CANCELED',updated_at=now()
   FROM messaging_messages m WHERE a.organization_id=$1 AND a.transport='CENTRAL_TRANSPORT' AND a.state='RESERVED'
   AND m.organization_id=a.organization_id AND m.id=a.message_id AND m.state='FAILED'`,[org]));
  const reconciled=await reconcile(org);const dispatched=await dispatch(org);return {processed:reconciled||dispatched};}};
}
