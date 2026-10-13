import type {TenantTransaction} from '../../db/tenant-transaction.js';
/** A callback does not authenticate an identity epoch. Known reuse of the same
 * ID in this real conversation makes attribution ambiguous; other groups,
 * channels and tenants remain independent. Unseen old IDs cannot be detected. */
export async function hasAmbiguousGroupProviderId(tx:TenantTransaction,input:{organizationId:string;channelId:string;conversationId:string;providerId:string;providerScope:string}):Promise<boolean>{
  return Boolean((await tx.query(`SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND channel_id=$2 AND conversation_id=$3
    AND upstream_message_id=$4 AND provider_scope<>$5 AND provider_scope LIKE 'g3:%'
    UNION ALL SELECT 1 FROM qr_outbound_observations WHERE organization_id=$1 AND channel_id=$2 AND conversation_id=$3
    AND provider_message_id=$4 AND provider_scope<>$5 AND provider_scope LIKE 'g3:%' LIMIT 1`,
    [input.organizationId,input.channelId,input.conversationId,input.providerId,input.providerScope])).rowCount);
}
