import {randomUUID} from 'node:crypto';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {interruptChatwootAttendance} from '../attendance/control-service.js';
import {SUPERSEDED_PHYSICAL_CYCLE_PREFIX} from '../attendance/conversation-cycle-fence.js';
import {createPostgresMessagingRepository} from '../messaging/repository.js';
import {IntegrationError} from './integration-error.js';

/** Under the channel lock, an unresolved mirror may be isolated only after
 * canonical GETs prove the prior route for this physical contact. */
export async function mayStartIndependentHumanCycle(tx:TenantTransaction,input:{
  organizationId:string;integrationId:string;channelId:string;remoteContactId:number;sourceId:string;phone:string;
}){
  const result=await tx.query<{allowed:boolean}>(`SELECT NOT EXISTS(
    SELECT 1 FROM integration_jobs blocked WHERE blocked.organization_id=$1 AND blocked.integration_id=$2 AND blocked.status='UNKNOWN'
  ) OR EXISTS (
    SELECT 1 FROM chatwoot_conversations prior
    JOIN messaging_conversations active ON active.organization_id=prior.organization_id AND active.id=prior.conversation_id
      AND active.channel_id=$3 AND active.remote_conversation_key IS NULL AND active.recipient_kind='INDIVIDUAL'
    JOIN messaging_contacts contact ON contact.organization_id=active.organization_id AND contact.id=active.contact_id
    JOIN messaging_channels channel ON channel.organization_id=active.organization_id AND channel.id=$3 AND channel.transport='BROKER_TRANSPORT'
    WHERE prior.organization_id=$1 AND prior.integration_id=$2 AND prior.contact_id=$4 AND prior.source_id=$5 AND contact.external_id=$6
      AND NOT EXISTS (
        SELECT 1 FROM integration_jobs blocked
        LEFT JOIN messaging_messages msg ON msg.organization_id=blocked.organization_id AND msg.id=blocked.message_id AND msg.channel_id=$3
        LEFT JOIN messaging_conversations route ON route.organization_id=msg.organization_id AND route.id=msg.conversation_id AND route.channel_id=$3
        LEFT JOIN chatwoot_conversations map ON map.organization_id=route.organization_id AND map.conversation_id=route.id
          AND map.integration_id=$2 AND map.remote_conversation_id::text=blocked.payload->>'conversationId'
        WHERE blocked.organization_id=$1 AND blocked.integration_id=$2 AND blocked.status='UNKNOWN' AND (
          blocked.kind<>'MIRROR_MESSAGE' OR blocked.payload->>'operation' IS DISTINCT FROM 'SEND_MESSAGE'
          OR map.conversation_id IS NULL OR route.contact_id IS NULL OR route.contact_id=active.contact_id))
  ) OR (
    -- The first mapping has no prior route to prove. Reject partial matches to
    -- existing mappings and require a distinct proven route for every UNKNOWN.
    EXISTS (SELECT 1 FROM messaging_channels WHERE organization_id=$1 AND id=$3 AND transport='BROKER_TRANSPORT')
    AND NOT EXISTS (
      SELECT 1 FROM chatwoot_conversations prior
      JOIN messaging_conversations route ON route.organization_id=prior.organization_id AND route.id=prior.conversation_id
      LEFT JOIN messaging_contacts contact ON contact.organization_id=route.organization_id AND contact.id=route.contact_id
      WHERE prior.organization_id=$1 AND prior.integration_id=$2
        AND (prior.contact_id=$4 OR prior.source_id=$5 OR contact.external_id=$6)
    )
    AND NOT EXISTS (
      SELECT 1 FROM integration_jobs blocked
      WHERE blocked.organization_id=$1 AND blocked.integration_id=$2 AND blocked.status='UNKNOWN'
        AND NOT EXISTS (
          SELECT 1 FROM messaging_messages msg
          JOIN messaging_conversations route ON route.organization_id=msg.organization_id AND route.id=msg.conversation_id
          JOIN messaging_contacts contact ON contact.organization_id=route.organization_id AND contact.id=route.contact_id
          JOIN chatwoot_conversations map ON map.organization_id=route.organization_id AND map.conversation_id=route.id
          WHERE msg.organization_id=$1 AND msg.id=blocked.message_id AND msg.channel_id=$3 AND route.channel_id=$3
            AND blocked.kind='MIRROR_MESSAGE' AND blocked.payload->>'operation'='SEND_MESSAGE'
            AND map.integration_id=$2 AND map.remote_conversation_id::text=blocked.payload->>'conversationId'
            AND route.recipient_kind='INDIVIDUAL' AND map.contact_id>0 AND map.contact_id<>$4
            AND btrim(map.source_id)<>'' AND map.source_id<>$5
            AND contact.external_id ~ '^[1-9][0-9]{7,14}$' AND contact.external_id<>$6
        )
    )
  ) AS allowed`,[input.organizationId,input.integrationId,input.channelId,input.remoteContactId,input.sourceId,input.phone.slice(1)]);
  return result.rows[0]?.allowed===true;
}

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
