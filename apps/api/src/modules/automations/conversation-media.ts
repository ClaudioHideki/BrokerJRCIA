import {randomUUID,createHash} from 'node:crypto';
import {MediaEffectConfigSchema,type MediaEffectConfig} from '@jrc/contracts';
import type {TenantTransaction,OrganizationTransaction} from '../../db/tenant-transaction.js';
import type {OutboxRow} from './repository.js';
import {createPostgresAutomationRepository} from './repository.js';
import {createPostgresMessagingRepository} from '../messaging/repository.js';
import {reserveCentralAutomationSend} from '../messaging/central-dispatcher.js';
import {assertEffectAuthority,assertMediaAsset,readMediaAsset,type EffectAuthority} from './conversation-effects-repository.js';
import {effectRevisionMatches} from './conversation-effect-proof.js';
import {lockAttendanceChannel} from '../attendance/repository.js';
type Intent={outboxId:string;ownerRevision:number;controlRevision:number;cycle:number|null;automationId:string;version:number;profile:'STANDALONE'|'CENTRAL';state:string};
export async function assertQueuedMediaAuthority(tx:TenantTransaction,org:string,messageId:string):Promise<OutboxRow|null>{
 const row=(await tx.query<OutboxRow&Intent>(`select o.id,o.organization_id as "organizationId",o.execution_id as "executionId",e.channel_id as "channelId",e.conversation_id as "conversationId",o.node_id as "nodeId",o.ordinal,o.kind,o.payload,o.attempts,o.lease_token as "leaseToken",r.outbox_id as "outboxId",r.owner_revision as "ownerRevision",r.control_revision as "controlRevision",r.cycle,r.automation_id as "automationId",r.version,r.profile,r.state from automation_conversation_effects r join automation_outbox o on o.organization_id=r.organization_id and o.id=r.outbox_id join automation_executions e on e.organization_id=o.organization_id and e.id=o.execution_id where r.organization_id=$1 and r.messaging_message_id=$2`,[org,messageId])).rows[0];
 if(!row)return null;
 if(!['QUEUED','UNKNOWN','CONFIRMED','REJECTED'].includes(row.state))throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 const authority=await assertEffectAuthority(tx,row,undefined,false);
 if(authority.ownerRevision!==row.ownerRevision||!await effectRevisionMatches(tx,row,row.controlRevision,authority.controlRevision)||authority.cycle!==row.cycle||authority.automationId!==row.automationId||authority.version!==row.version||authority.profile!==row.profile)throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 const config=MediaEffectConfigSchema.parse(Object.fromEntries(Object.entries(row.payload).filter(([k])=>!['variables','runtimeStateVersion','nodeType','definitionAutomationId','definitionVersion','waitId'].includes(k))));
 assertMediaAsset(org,authority.definitionAutomationId,row.channelId,config,await readMediaAsset(tx,org,config.mediaId,true));return row;
}
/** Called after a canonical transport updates its message. Enqueue alone has no proof. */
export async function confirmQueuedMedia(tx:TenantTransaction,org:string,messageId:string):Promise<void>{
 const intent=(await tx.query<{state:string;outbox_id:string;channel_id:string}>('select state,outbox_id,channel_id from automation_conversation_effects where organization_id=$1 and messaging_message_id=$2 and protocol_version=2',[org,messageId])).rows[0];if(!intent)return;
 await lockAttendanceChannel(tx,org,intent.channel_id);
 const message=(await tx.query<{state:string;upstream:string|null}>('select state,upstream_message_id as upstream from messaging_messages where organization_id=$1 and id=$2',[org,messageId])).rows[0];
 if(!message)return;
 if(message.state==='FAILED'&&!message.upstream){
  if((await tx.query('select message_id from messaging_outbox where organization_id=$1 and message_id=$2',[org,messageId])).rowCount)return;
  if((await tx.query(`select 1 from qr_dispatch_attempts where organization_id=$1 and message_id=$2 and state in ('DISPATCHED','UNKNOWN','ABANDONED')
   union all select 1 from chatwoot_mirror_attempts where organization_id=$1 and message_id=$2 and state in ('DISPATCHED','UNKNOWN')`,[org,messageId])).rowCount)return;
  await tx.query("update automation_conversation_effects set state='REJECTED',updated_at=now() where organization_id=$1 and messaging_message_id=$2 and state in ('QUEUED','UNKNOWN')",[org,messageId]);
  let item:OutboxRow|null=null;try{item=await assertQueuedMediaAuthority(tx,org,messageId);}catch(error){if(!(error instanceof Error)||!error.message.startsWith('AUTOMATION_'))throw error;}
  if(item)await createPostgresAutomationRepository().resumeExecution(tx,{org,id:item.executionId,eventId:randomUUID(),eventKey:`io:${item.id}`,effectReceiptId:item.id,payload:{waitId:item.id,outcome:'error',output:{operation:'media',error:'AUTOMATION_MEDIA_REJECTED'}}});
  await tx.query("update automation_outbox set status='FAILED',lease_token=null,lease_expires_at=null,last_error='AUTOMATION_MEDIA_REJECTED',updated_at=now() where organization_id=$1 and id=$2 and status='UNKNOWN'",[org,intent.outbox_id]);return;
 }
 if(!['SENT','DELIVERED','READ'].includes(message.state)||!message.upstream)return;
 await tx.query("update automation_conversation_effects set state='CONFIRMED',remote_reference=$3,updated_at=now() where organization_id=$1 and messaging_message_id=$2 and state in ('QUEUED','UNKNOWN')",[org,messageId,message.upstream]);
 let item:OutboxRow|null=null;try{item=await assertQueuedMediaAuthority(tx,org,messageId);}catch(error){if(!(error instanceof Error)||!error.message.startsWith('AUTOMATION_'))throw error;}
 if(item)await createPostgresAutomationRepository().resumeExecution(tx,{org,id:item.executionId,eventId:randomUUID(),eventKey:`io:${item.id}`,effectReceiptId:item.id,payload:{waitId:item.id,outcome:'success',output:{operation:'media',confirmed:true}}});
 await tx.query("update automation_outbox set status='SENT',remote_reference=$3,lease_token=null,lease_expires_at=null,last_error=null,updated_at=now() where organization_id=$1 and id=$2 and status='UNKNOWN'",[org,intent.outbox_id,message.upstream]);
}
export function createAutomationMediaBridge(options:{transact<T>(org:string,op:OrganizationTransaction<T>):Promise<T>}){return {
 async enqueue(item:OutboxRow,config:MediaEffectConfig,expected:EffectAuthority){return options.transact(item.organizationId,async tx=>{
  const current=await assertEffectAuthority(tx,item,expected),asset=assertMediaAsset(item.organizationId,current.definitionAutomationId,item.channelId,config,await readMediaAsset(tx,item.organizationId,config.mediaId,true));
  if((await tx.query('select id from automation_conversation_effects where organization_id=$1 and outbox_id=$2',[item.organizationId,item.id])).rowCount)throw Error('AUTOMATION_EFFECT_INTENT_EXISTS');
  const content={type:'MEDIA' as const,mediaId:asset.mediaId,kind:asset.kind,fileName:asset.name,...(config.caption?{caption:config.caption}:{})};
  const queued=await createPostgresMessagingRepository().enqueueOutgoing(tx,{id:randomUUID(),organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId!,source:'AUTOMATION',content,idempotencyKey:`automation-media:${item.id}`,bodyHash:createHash('sha256').update(JSON.stringify(content)).digest('hex'),policy:{requireOptIn:false}});
  await tx.query(`insert into automation_conversation_effects(organization_id,outbox_id,channel_id,conversation_id,execution_id,automation_id,version,operation,profile,state,owner_revision,control_revision,cycle,media_asset_id,media_revision,messaging_message_id,protocol_version,scope) values($1,$2,$3,$4,$5,$6,$7,'media',$8,'QUEUED',$9,$10,$11,$12,$13,$14,2,$15::jsonb)`,[item.organizationId,item.id,item.channelId,item.conversationId,item.executionId,current.automationId,current.version,current.profile,current.ownerRevision,current.controlRevision,current.cycle,asset.id,asset.revision,queued.message.id,JSON.stringify(current.scope)]);
  if(current.channelTransport==='CENTRAL_TRANSPORT')await reserveCentralAutomationSend(tx,item,queued.message);
  return {kind:'UNKNOWN' as const,error:'AUTOMATION_MEDIA_TRANSPORT_PENDING'};
 });},
 async reconcileOnce(org:string){const ids=await options.transact(org,async tx=>(await tx.query<{id:string}>(`select r.messaging_message_id as id
  from automation_conversation_effects r join messaging_messages m on m.organization_id=r.organization_id and m.id=r.messaging_message_id
  join automation_executions e on e.organization_id=r.organization_id and e.id=r.execution_id
  where r.organization_id=$1 and r.operation='media' and r.protocol_version=2
  and (r.state in ('QUEUED','UNKNOWN') or r.state='CONFIRMED' and e.status='WAITING' and e.state->'waiting'->>'waitId'=r.outbox_id::text)
  and m.state in ('SENT','DELIVERED','READ','FAILED') order by r.created_at limit 20`,[org])).rows);
  for(const row of ids)await options.transact(org,tx=>confirmQueuedMedia(tx,org,row.id));return ids.length;},
};}
