import type {OrganizationTransaction} from '../../db/tenant-transaction.js';
import type {ConversationEffectConfig} from '@jrc/contracts';
import {randomUUID} from 'node:crypto';
import {createPostgresAutomationRepository,type OutboxRow} from './repository.js';
import {lockAttendanceChannel} from '../attendance/repository.js';
import type {MediaStore} from '../messaging/media-store.js';
import type {AccountRow} from '../integrations/chatwoot-context.js';
import type {ChatwootClient} from '../integrations/chatwoot-client.js';
import {createConversationEffectDispatcher} from './conversation-effect.js';
import {assertEffectAuthority,assertActionResource,readActionResource,readConversationActionValue,assertMediaAsset,readMediaAsset,commitLocalConversationEffect,type EffectAuthority} from './conversation-effects-repository.js';
import {createConversationCentralAdapter} from './conversation-central.js';
import {createAutomationMediaBridge} from './conversation-media.js';
import {assertConversationResourcePolicies} from './conversation-resources.js';
export function createConversationEffectRuntime(options:{transact<T>(org:string,op:OrganizationTransaction<T>):Promise<T>;media?:Pick<MediaStore,'writeUpload'|'read'>;client?:(account:AccountRow)=>ChatwootClient}){
 const central=options.client?createConversationCentralAdapter({...options,client:options.client}):undefined,bridge=createAutomationMediaBridge(options);
 // Every P3 mutation persists its admission before HTTP or transport enqueue. An
 // expired claim with no admission therefore proves that nothing was dispatched.
 async function reconcileUnadmitted(org:string){
  const items=await options.transact(org,async tx=>(await tx.query<OutboxRow>(`select o.id,o.organization_id as "organizationId",
   o.execution_id as "executionId",e.channel_id as "channelId",e.conversation_id as "conversationId",o.node_id as "nodeId",
   o.ordinal,o.kind,o.payload,o.attempts,o.lease_token as "leaseToken" from automation_outbox o
   join automation_executions e on e.organization_id=o.organization_id and e.id=o.execution_id
   where o.organization_id=$1 and o.status='UNKNOWN' and (o.lease_expires_at is null or o.lease_expires_at<clock_timestamp())
   and o.payload->>'waitId'=o.id::text and
   ((o.kind='IO_CONVERSATION' and o.payload->>'conversationEffectVersion'='2' and o.payload->>'operation' in ('tag','attribute','note','resolve'))
    or (o.kind='SEND_MEDIA' and o.payload->>'mediaEffectVersion'='2'))
   and not exists(select 1 from automation_conversation_effects r where r.organization_id=o.organization_id and r.outbox_id=o.id)
   order by o.created_at,o.id limit 20`,[org])).rows);
  for(const item of items)await options.transact(org,async tx=>{
   await lockAttendanceChannel(tx,org,item.channelId);
   await tx.query('select id from automation_executions where organization_id=$1 and id=$2 for update',[org,item.executionId]);
   const expired=(await tx.query(`select id from automation_outbox where organization_id=$1 and id=$2 and status='UNKNOWN'
    and (lease_expires_at is null or lease_expires_at<clock_timestamp()) for update`,[org,item.id])).rowCount;
   if(!expired||(await tx.query('select id from automation_conversation_effects where organization_id=$1 and outbox_id=$2',[org,item.id])).rowCount)return;
   await tx.query(`insert into automation_conversation_effects(organization_id,outbox_id,channel_id,conversation_id,execution_id,
    automation_id,version,operation,profile,state,owner_revision,control_revision,cycle,protocol_version)
    select e.organization_id,$2,e.channel_id,e.conversation_id,e.id,e.automation_id,e.version,$3,
     case when exists(select 1 from chatwoot_connections c where c.organization_id=e.organization_id and c.channel_id=e.channel_id)
      then 'CENTRAL' else 'STANDALONE' end,'REJECTED',coalesce(own.revision,0),coalesce(control.revision,0),control.cycle,2
    from automation_executions e left join attendance_owners own on own.organization_id=e.organization_id and own.channel_id=e.channel_id
    left join chatwoot_attendance_controls control on control.organization_id=e.organization_id and control.conversation_id=e.conversation_id
    where e.organization_id=$1 and e.id=$4`,[org,item.id,item.kind==='SEND_MEDIA'?'media':item.payload.operation,item.executionId]);
   let authorized=false;
   try{await assertEffectAuthority(tx,item,undefined,false);authorized=true;}
   catch(error){if(!(error instanceof Error)||error.message!=='AUTOMATION_EFFECT_AUTHORITY_LOST')throw error;}
   if(authorized)await createPostgresAutomationRepository().resumeExecution(tx,{org,id:item.executionId,eventId:randomUUID(),
    eventKey:`io:${item.id}`,effectReceiptId:item.id,payload:{waitId:item.id,outcome:'error',output:{error:'AUTOMATION_EFFECT_NOT_ADMITTED'}}});
   await tx.query(`update automation_outbox set status='FAILED',lease_token=null,lease_expires_at=null,
    last_error='AUTOMATION_EFFECT_NOT_ADMITTED',updated_at=now() where organization_id=$1 and id=$2 and status='UNKNOWN'`,[org,item.id]);
  });
 }
 const authorityOf=async(item:OutboxRow)=>options.transact(item.organizationId,async tx=>{const authority=await assertEffectAuthority(tx,item);if((await tx.query('select id from automation_conversation_effects where organization_id=$1 and outbox_id=$2',[item.organizationId,item.id])).rowCount)throw Error('AUTOMATION_EFFECT_INTENT_EXISTS');return authority;});
 const dispatcher=createConversationEffectDispatcher({
  async prepare(item,config){let authority=await authorityOf(item);if(authority.profile==='CENTRAL'){if(!central)throw Error('AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE');await central.catalog.refresh(item.organizationId,item.channelId);}
   authority=await options.transact(item.organizationId,async tx=>{const current=await assertEffectAuthority(tx,item,authority);
    if('mediaEffectVersion' in config){if(!options.media)throw Error('AUTOMATION_MEDIA_UNAVAILABLE');assertMediaAsset(item.organizationId,current.definitionAutomationId,item.channelId,config,await readMediaAsset(tx,item.organizationId,config.mediaId,true));}
    else if(config.operation==='tag'||config.operation==='attribute'){const row=assertActionResource(item.organizationId,item.channelId,config,await readActionResource(tx,item.organizationId,config.resourceId,true));if(row.source!==(current.profile==='CENTRAL'?'CENTRAL':'LOCAL'))throw Error('AUTOMATION_RESOURCE_UNAVAILABLE');if(config.operation==='attribute')readConversationActionValue(config,item.payload.variables as Record<string,unknown>,row);}
    await assertConversationResourcePolicies(tx,item.organizationId,current.definitionAutomationId,[{nodes:[{id:item.nodeId,type:String(item.payload.nodeType),label:item.nodeId,position:{x:0,y:0},data:config}],edges:[]}]);return current;});
   return {profile:authority.profile,authority};
  },
  commitLocal:(tx,item,config,prepared)=>commitLocalConversationEffect(tx,item,config,prepared.authority as EffectAuthority),
  dispatchCentral:async(item,config,prepared)=>{if(!central)throw Error('AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE');return central.dispatch(item,config,prepared.authority as EffectAuthority);},
  enqueueMedia:(item,config,prepared)=>bridge.enqueue(item,config,prepared.authority as EffectAuthority),
  async rejectBeforeDispatch(item,config,code){
   return {kind:'FAILED',error:code,resumePayload:{waitId:item.id,outcome:'error',output:{error:code}},commit:async tx=>{
    const current=await assertEffectAuthority(tx,item);
    await tx.query(`insert into automation_conversation_effects(organization_id,outbox_id,channel_id,conversation_id,execution_id,
     automation_id,version,operation,profile,state,owner_revision,control_revision,cycle,protocol_version)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,'REJECTED',$10,$11,$12,2)`,[item.organizationId,item.id,item.channelId,item.conversationId,
     item.executionId,current.automationId,current.version,'operation' in config?config.operation:'media',current.profile,current.ownerRevision,current.controlRevision,current.cycle]);
   }};
  },
 });return {dispatcher,catalog:central?.catalog,async reconcileOnce(org:string){await reconcileUnadmitted(org);await central?.reconcileOnce(org);await bridge.reconcileOnce(org);}};
}
