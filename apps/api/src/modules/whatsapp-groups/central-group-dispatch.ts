import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {currentGroupWebhookBinding,type GroupPhysicalPolicy} from './automation-authority.js';
import {readGroupCentralSnapshot,readGroupRemoteMap} from './central-group-store.js';
/** Reads durable observations; no browser/remote payload grants send authority. */
export async function readGroupHumanDispatch(tx:TenantTransaction,input:{organizationId:string;channelId:string;conversationId:string;messageId:string},policy:GroupPhysicalPolicy){
 const current=await readGroupCentralSnapshot(tx,{...input,expectedWebhookBinding:await currentGroupWebhookBinding(tx,input.organizationId,input.channelId,policy)});
 if(!current||!await readGroupRemoteMap(tx,current))return null;
 const evidence=(await tx.query(`SELECT m.id FROM chatwoot_group_replies r
  JOIN messaging_messages m ON m.organization_id=r.organization_id AND m.id=r.message_id AND m.conversation_id=r.conversation_id AND m.channel_id=r.channel_id
  JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
  JOIN chatwoot_attendance_observations o ON o.organization_id=r.organization_id AND o.id=r.observation_id
  JOIN chatwoot_attendance_controls a ON a.organization_id=c.organization_id AND a.conversation_id=c.id
  JOIN chatwoot_group_scopes s ON s.organization_id=r.organization_id AND s.scope_key=r.scope_key
  JOIN whatsapp_group_catalog_items i ON i.organization_id=c.organization_id AND i.channel_id=c.channel_id AND i.group_jid=c.group_jid
  WHERE r.organization_id=$1 AND r.channel_id=$2 AND r.conversation_id=$3 AND r.message_id=$4 AND r.scope_key=$5
   AND m.source='OPERATOR' AND m.direction='OUTGOING' AND m.content->>'type'='TEXT' AND m.provider_scope=$6
   AND c.mode='HUMAN' AND c.attendance_revision>=r.attendance_revision AND o.disposition='APPLIED' AND o.event->>'kind'='HUMAN_PUBLIC'
   AND o.event->>'mayForwardReply'='true' AND o.integration_id=s.integration_id AND o.destination_revision=s.destination_revision
   AND o.account_id=s.remote_account_id AND o.inbox_id=s.remote_inbox_id AND o.remote_conversation_id=s.remote_conversation_id
   AND a.state='HUMAN' AND a.integration_id=s.integration_id AND a.destination_revision=s.destination_revision AND a.account_id=s.remote_account_id
   AND a.inbox_id=s.remote_inbox_id AND a.remote_conversation_id=s.remote_conversation_id AND a.cycle=o.cycle
   AND s.retired_at IS NULL AND i.announce IS FALSE AND i.is_community IS FALSE AND i.is_community_announce IS FALSE
   AND NOT EXISTS(SELECT 1 FROM qr_dispatch_attempts q WHERE q.organization_id=r.organization_id AND q.conversation_id=r.conversation_id AND q.state IN('DISPATCHED','UNKNOWN'))
   AND NOT EXISTS(SELECT 1 FROM qr_outbound_observations q WHERE q.organization_id=r.organization_id AND q.conversation_id=r.conversation_id AND q.blocking)`,
  [input.organizationId,input.channelId,input.conversationId,input.messageId,current.envelope.scopeKey,`g3:${current.scope.groupJid}:${current.scope.identityRevision}`])).rowCount;
 return evidence?{identity_fingerprint:current.scope.identityFingerprint}:null;
}
