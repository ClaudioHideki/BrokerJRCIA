import type {TenantTransaction} from '../../db/tenant-transaction.js';

export const SUPERSEDED_PHYSICAL_CYCLE_PREFIX='chatwoot-cycle:';
export async function isSupersededPhysicalCycle(tx:TenantTransaction,org:string,conversation:string):Promise<boolean>{
 return Boolean((await tx.query(`SELECT 1 FROM messaging_conversations m JOIN messaging_channels c
  ON c.organization_id=m.organization_id AND c.id=m.channel_id WHERE m.organization_id=$1 AND m.id=$2
  AND c.transport='BROKER_TRANSPORT' AND m.remote_conversation_key LIKE 'chatwoot-cycle:%'`,[org,conversation])).rowCount);
}
export async function currentPhysicalCycle(tx:TenantTransaction,org:string,conversation:string):Promise<{id:string;channelId:string}|undefined>{
 return (await tx.query<{id:string;channelId:string}>(`SELECT current.id,current.channel_id AS "channelId" FROM messaging_conversations old
  JOIN messaging_channels c ON c.organization_id=old.organization_id AND c.id=old.channel_id AND c.transport='BROKER_TRANSPORT'
  JOIN messaging_conversations current ON current.organization_id=old.organization_id AND current.channel_id=old.channel_id AND current.contact_id=old.contact_id
  WHERE old.organization_id=$1 AND old.id=$2 AND old.remote_conversation_key LIKE 'chatwoot-cycle:%'
    AND current.remote_conversation_key IS NULL AND current.id<>old.id`,[org,conversation])).rows[0];
}
export async function hasHistoricalHumanSend(tx:TenantTransaction,org:string,conversation:string):Promise<boolean>{
 return Boolean((await tx.query(`SELECT 1 FROM messaging_conversations current JOIN messaging_conversations old
  ON old.organization_id=current.organization_id AND old.channel_id=current.channel_id AND old.contact_id=current.contact_id
  WHERE current.organization_id=$1 AND current.id=$2 AND current.remote_conversation_key IS NULL
   AND old.remote_conversation_key LIKE 'chatwoot-cycle:%'
   AND (EXISTS(SELECT 1 FROM messaging_messages m WHERE m.organization_id=old.organization_id AND m.conversation_id=old.id
     AND m.source='OPERATOR' AND m.direction='OUTGOING' AND m.state IN ('ACCEPTED','SENDING','UNKNOWN'))
    OR EXISTS(SELECT 1 FROM chatwoot_conversations cm JOIN integration_jobs j ON j.organization_id=cm.organization_id AND j.integration_id=cm.integration_id
     WHERE cm.organization_id=old.organization_id AND cm.conversation_id=old.id AND j.kind='CHATWOOT_REPLY'
      AND j.status IN ('PENDING','RUNNING','UNKNOWN') AND j.payload->>'attendanceKind'='HUMAN_PUBLIC'
      AND j.payload->>'conversationId'=cm.remote_conversation_id::text)) LIMIT 1`,[org,conversation])).rowCount);
}
