import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {AUTOMATION_ORIGIN} from '@jrc/contracts';
import {createHmac} from 'node:crypto';
export interface GroupPhysicalPolicy {encryptionKey:string;configurationScope:string}
export async function currentGroupWebhookBinding(tx:TenantTransaction,org:string,channel:string,policy:GroupPhysicalPolicy){
  const row=(await tx.query<{instance_id:string;upstream_instance_key:string}>(`SELECT c.instance_id,i.upstream_instance_key FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id WHERE c.organization_id=$1 AND c.id=$2`,[org,channel])).rows[0];
  return row?createHmac('sha256',Buffer.from(policy.encryptionKey,'base64')).update('whatsapp-group-webhook-binding:v2\0')
    .update(JSON.stringify([policy.configurationScope,org,channel,row.instance_id,row.upstream_instance_key])).digest('hex'):null;
}
/** Local authority only. Physical sends additionally require a current trusted
 * workspace snapshot (identity + groupsIgnore=false) outside this transaction. */
export async function groupAuthorityAllows(tx:TenantTransaction,input:{organizationId:string;channelId:string;conversationId:string|null;automationId:string;version:number;executionId?:string},policy?:GroupPhysicalPolicy):Promise<boolean> {
  if(!input.conversationId||!policy)return false;
  const binding=await currentGroupWebhookBinding(tx,input.organizationId,input.channelId,policy);if(!binding)return false;
  return Boolean((await tx.query(`SELECT 1 FROM whatsapp_group_automation_controls g
    JOIN messaging_conversations m ON m.organization_id=g.organization_id AND m.id=g.conversation_id AND m.channel_id=g.channel_id
    JOIN messaging_channels c ON c.organization_id=g.organization_id AND c.id=g.channel_id
    JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
    JOIN organizations t ON t.id=g.organization_id JOIN flow_features f ON f.organization_id=t.id
    JOIN attendance_owners o ON o.organization_id=g.organization_id AND o.channel_id=g.channel_id
    JOIN automation_bindings b ON b.organization_id=g.organization_id AND b.id=g.binding_id AND b.channel_id=g.channel_id
    JOIN automation_definitions d ON d.organization_id=g.organization_id AND d.id=g.automation_id
    JOIN whatsapp_group_catalogs k ON k.organization_id=g.organization_id AND k.channel_id=g.channel_id
    JOIN whatsapp_group_catalog_items item ON item.organization_id=k.organization_id AND item.channel_id=k.channel_id AND item.group_jid=g.group_jid
    JOIN whatsapp_group_participation p ON p.organization_id=k.organization_id AND p.channel_id=k.channel_id AND p.group_jid=g.group_jid AND p.identity_revision=k.identity_revision
    WHERE g.organization_id=$1 AND g.channel_id=$2 AND g.conversation_id=$3 AND g.automation_id=$4 AND g.version=$5
      AND g.enabled AND g.pause_reason IS NULL AND m.recipient_kind='GROUP' AND m.group_jid=g.group_jid AND m.mode='BOT'
      AND t.status='ACTIVE' AND f.enabled AND c.provider='BAILEYS' AND c.transport='BROKER_TRANSPORT'
      AND c.deleting_at IS NULL AND i.archived_at IS NULL AND i.status='CONNECTED'
      AND o.executor='BROKER' AND o.automation_id=g.automation_id AND o.version=g.version AND o.revision=g.owner_revision
      AND c.bot_public_id=g.automation_id::text AND c.bot_origin_reference=$6 AND o.remote_binding_id IS NULL
      AND b.automation_id=g.automation_id AND b.version=g.version AND b.revision=g.binding_revision AND b.status='ACTIVE'
      AND d.lifecycle_status='PUBLISHED' AND d.active_version=g.version
      AND k.identity_revision=g.identity_revision AND k.identity_fingerprint=g.identity_fingerprint
      AND k.last_error_code IS NULL AND k.valid_until>clock_timestamp() AND item.selected
      AND item.announce IS FALSE AND item.is_community IS FALSE AND item.is_community_announce IS FALSE
      AND p.identity_fingerprint=g.identity_fingerprint AND p.own_state='PRESENT_FROM_CATALOG' AND p.source_snapshot_id=k.snapshot_id
      AND NOT EXISTS(SELECT 1 FROM whatsapp_group_events e WHERE e.organization_id=g.organization_id AND e.channel_id=g.channel_id AND e.group_jid=g.group_jid
        AND e.identity_revision=g.identity_revision AND e.identity_fingerprint=g.identity_fingerprint AND e.received_at>g.activated_at)
      AND EXISTS(SELECT 1 FROM whatsapp_group_webhook_operations w WHERE w.organization_id=g.organization_id AND w.channel_id=g.channel_id
        AND w.id=(SELECT last.id FROM whatsapp_group_webhook_operations last WHERE last.organization_id=g.organization_id AND last.channel_id=g.channel_id ORDER BY (last.phase IN ('PREPARED','DISPATCHED','UNKNOWN')) DESC,last.created_at DESC,last.id DESC LIMIT 1)
        AND w.phase='CONFIRMED' AND w.binding_fingerprint=$7 AND w.binding_fingerprint=g.webhook_binding_fingerprint
        AND w.instance_id=i.id AND w.identity_revision=g.identity_revision AND w.identity_fingerprint=g.identity_fingerprint)
      AND NOT EXISTS(SELECT 1 FROM whatsapp_group_automation_sessions s WHERE s.organization_id=g.organization_id AND s.conversation_id=g.conversation_id
        AND s.closed_at IS NULL AND (s.identity_revision<>g.identity_revision OR s.identity_fingerprint<>g.identity_fingerprint OR s.control_revision<>g.revision))
      AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM whatsapp_group_automation_sessions s JOIN automation_executions e ON e.organization_id=s.organization_id AND e.id=s.execution_id
        WHERE s.organization_id=g.organization_id AND s.execution_id=$8 AND s.channel_id=g.channel_id AND s.conversation_id=g.conversation_id AND s.group_jid=g.group_jid
          AND s.activation_revision=g.activation_revision AND s.identity_revision=g.identity_revision AND s.identity_fingerprint=g.identity_fingerprint
          AND e.channel_id=g.channel_id AND e.conversation_id=g.conversation_id AND e.automation_id=g.automation_id AND e.version=g.version AND e.binding_id=g.binding_id))
      AND NOT EXISTS(SELECT 1 FROM qr_dispatch_attempts a WHERE a.organization_id=g.organization_id AND a.conversation_id=g.conversation_id AND a.state IN ('DISPATCHED','UNKNOWN'))
      AND NOT EXISTS(SELECT 1 FROM qr_outbound_observations q WHERE q.organization_id=g.organization_id AND q.conversation_id=g.conversation_id AND q.blocking)`,
    [input.organizationId,input.channelId,input.conversationId,input.automationId,input.version,AUTOMATION_ORIGIN,binding,input.executionId??null])).rowCount);
}
