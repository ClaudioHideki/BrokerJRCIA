import {randomUUID} from 'node:crypto';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {interruptChatwootAttendance} from '../attendance/control-service.js';
import {SUPERSEDED_PHYSICAL_CYCLE_PREFIX} from '../attendance/conversation-cycle-fence.js';
import {createPostgresMessagingRepository} from '../messaging/repository.js';
import {IntegrationError} from './integration-error.js';

/** Caller holds the channel and current integration-job lease. No network here.
 * A waiting result must be committed, preserving the human pause, then retried. */
export async function preparePhysicalConversationCycle(tx:TenantTransaction,input:{
 organizationId:string;channelId:string;integrationId:string;conversationId:string;remoteConversationId:number;remoteContactId:number;sourceId:string;humanPublicReply:boolean;
}):Promise<{conversationId:string;waiting?:string}>{
 const a=[input.organizationId,input.integrationId,input.conversationId];
 const old=(await tx.query<{remote_conversation_id:string;contact_id:string;source_id:string;physical_contact:string;mode:string;remote_conversation_key:string|null;transport:string;recipient_kind:string}>(`
  SELECT map.remote_conversation_id,map.contact_id,map.source_id,m.contact_id AS physical_contact,m.mode,m.remote_conversation_key,c.transport,m.recipient_kind
  FROM chatwoot_conversations map JOIN messaging_conversations m ON m.organization_id=map.organization_id AND m.id=map.conversation_id
  JOIN messaging_channels c ON c.organization_id=m.organization_id AND c.id=m.channel_id
  JOIN chatwoot_connections binding ON binding.organization_id=map.organization_id AND binding.id=map.integration_id AND binding.channel_id=c.id
  WHERE map.organization_id=$1 AND map.integration_id=$2 AND map.conversation_id=$3 AND c.id=$4 FOR NO KEY UPDATE OF m`,[...a,input.channelId])).rows[0];
 if(!old||Number(old.remote_conversation_id)===input.remoteConversationId)return {conversationId:input.conversationId};
 if(!input.humanPublicReply)throw new IntegrationError('CHATWOOT_CYCLE_HUMAN_REQUIRED',409);
 if(old.transport!=='BROKER_TRANSPORT'||old.recipient_kind!=='INDIVIDUAL'||old.remote_conversation_key!==null)
  throw new IntegrationError('CHATWOOT_CONVERSATION_ALREADY_BOUND',409);
 if(Number(old.contact_id)!==input.remoteContactId||old.source_id!==input.sourceId)
  throw new IntegrationError('CHATWOOT_CYCLE_CONTACT_CHANGED',409);
 // This is an authenticated human reply, not permission to start another bot.
 await interruptChatwootAttendance(tx,{organizationId:input.organizationId,channelId:input.channelId,conversationId:input.conversationId},true);
 await tx.query(`UPDATE chatwoot_attendance_controls SET state='HUMAN',revision=revision+1,updated_at=now()
  WHERE organization_id=$1 AND conversation_id=$2 AND state<>'HUMAN'`,[input.organizationId,input.conversationId]);
 await tx.query(`UPDATE attendance_resume_operations SET state='CANCELED',last_error='CHATWOOT_CYCLE_SUPERSEDED',updated_at=now()
  WHERE organization_id=$1 AND conversation_id=$2 AND state='PENDING' AND phase='PREPARED'`,[input.organizationId,input.conversationId]);
 await tx.query(`WITH stopped AS (UPDATE attendance_handoff_operations SET state='ACTION_REQUIRED',last_error='CHATWOOT_CYCLE_SUPERSEDED',updated_at=now()
  WHERE organization_id=$1 AND conversation_id=$2 AND phase='PREPARED' AND state IN ('PENDING','UNKNOWN') RETURNING outbox_id)
  UPDATE automation_outbox SET status='CANCELED',last_error='CHATWOOT_CYCLE_SUPERSEDED',updated_at=now()
  WHERE organization_id=$1 AND id IN (SELECT outbox_id FROM stopped) AND status IN ('PENDING','SENDING','UNKNOWN')`,[input.organizationId,input.conversationId]);
 const pending=(await tx.query(`SELECT 1 FROM messaging_messages msg JOIN messaging_conversations m ON m.organization_id=msg.organization_id AND m.id=msg.conversation_id
  WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.contact_id=$3 AND msg.direction='OUTGOING' AND msg.state IN ('ACCEPTED','SENDING','UNKNOWN') LIMIT 1`,
 [input.organizationId,input.channelId,old.physical_contact])).rowCount;
 if(pending)return {conversationId:input.conversationId,waiting:'CHATWOOT_CYCLE_WAITING_PREVIOUS_SEND'};
 if((await tx.query(`SELECT 1 FROM attendance_resume_operations WHERE organization_id=$1 AND conversation_id=$2
   AND (state IN ('PENDING','UNKNOWN') OR (state='ACTION_REQUIRED' AND phase<>'PREPARED'))
  UNION ALL SELECT 1 FROM attendance_handoff_operations WHERE organization_id=$1 AND conversation_id=$2
   AND (state IN ('PENDING','UNKNOWN') OR (state='ACTION_REQUIRED' AND phase<>'PREPARED'))
  UNION ALL SELECT 1 FROM nico_takeover_operations WHERE organization_id=$1 AND conversation_id=$2 AND state='OPEN' LIMIT 1`,
 [input.organizationId,input.conversationId])).rowCount)return {conversationId:input.conversationId,waiting:'CHATWOOT_CYCLE_WAITING_PREVIOUS_CONTROL'};
 await tx.query(`UPDATE messaging_conversations SET remote_conversation_key=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 AND remote_conversation_key IS NULL`,
 [input.organizationId,input.conversationId,`${SUPERSEDED_PHYSICAL_CYCLE_PREFIX}${input.integrationId}:${old.remote_conversation_id}`]);
 const repo=createPostgresMessagingRepository(),next=await repo.getOrCreateConversation(tx,{id:randomUUID(),organizationId:input.organizationId,channelId:input.channelId,contactId:old.physical_contact});
 await repo.setConversationMode(tx,{organizationId:input.organizationId,conversationId:next.id,mode:'HUMAN'});
 return {conversationId:next.id};
}
