import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { AUTOMATION_ORIGIN } from '@jrc/contracts';
import { readChatwootAttendanceGate } from './control-service.js';

/** Caller has locked channel, then execution. The external dispatch rechecks separately. */
export async function runtimeAuthorityAllows(tx:TenantTransaction, input:{
  organizationId:string;channelId:string;conversationId:string|null;automationId:string;version:number;
}, checkRemote=true):Promise<boolean> {
  const current=await tx.query(`
    SELECT 1 FROM attendance_owners o JOIN messaging_channels c ON c.organization_id=o.organization_id AND c.id=o.channel_id
    JOIN automation_bindings b ON b.organization_id=o.organization_id AND b.channel_id=o.channel_id
    JOIN organizations tenant ON tenant.id=o.organization_id
    JOIN flow_features feature ON feature.organization_id=o.organization_id
    WHERE o.organization_id=$1 AND o.channel_id=$2 AND o.executor='BROKER'
      AND o.automation_id=$3 AND o.version=$4 AND o.remote_binding_id IS NULL
      AND c.bot_public_id=$3::text AND c.bot_origin_reference=$6 AND c.deleting_at IS NULL
      AND b.automation_id=$3 AND b.version=$4 AND b.status IN ('ACTIVE','PAUSED')
      AND tenant.status='ACTIVE' AND feature.enabled
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM messaging_conversations m
        WHERE m.organization_id=$1 AND m.id=$5 AND m.channel_id=$2 AND m.mode='BOT'))
      AND NOT EXISTS(SELECT 1 FROM attendance_sessions s WHERE s.organization_id=$1 AND s.conversation_id=$5
        AND s.state IN ('WAITING_HUMAN','HUMAN_ACTIVE','ADMIN_PAUSED'))`,
    [input.organizationId,input.channelId,input.automationId,input.version,input.conversationId,AUTOMATION_ORIGIN]);
  if(!current.rowCount)return false;
  return !checkRemote || !input.conversationId || (await readChatwootAttendanceGate(tx,{
    organizationId:input.organizationId,channelId:input.channelId,conversationId:input.conversationId
  })).allowed;
}
