import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { lockAttendanceChannel,lockAttendanceChannelRead } from '../attendance/repository.js';

export function partnerError(code: string, status: number) {
  return Object.assign(new Error(code), {code,status,statusCode:status});
}
/** Resolve current identity in the tenant transaction; issuance snapshots grant no authority. */
export async function requireCurrentPartnerKey(tx:TenantTransaction, organizationId:string, apiKeyId:string,
  requiredScopes:readonly string[]):Promise<void> {
  const current=await tx.query(`SELECT id FROM api_keys WHERE organization_id=$1 AND id=$2
    AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
    AND scopes @> $3::text[] FOR SHARE`,[organizationId,apiKeyId,[...requiredScopes]]);
  if(!current.rows.length)throw partnerError('PARTNER_CREDENTIAL_REVOKED',403);
  // LockRows can wait after WHERE was evaluated. The second read is performed
  // after the key SHARE lock has actually been acquired.
  await recheckCurrentPartnerKey(tx,organizationId,apiKeyId,requiredScopes);
}
/** The caller already holds this key's SHARE lock. Recheck expiry after later
 * blocking locks without acquiring any new lock or inverting the lock order. */
export async function recheckCurrentPartnerKey(tx:TenantTransaction,organizationId:string,apiKeyId:string,
  requiredScopes:readonly string[]):Promise<void>{
  const current=await tx.query(`SELECT id FROM api_keys WHERE organization_id=$1 AND id=$2
    AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
    AND scopes @> $3::text[]`,[organizationId,apiKeyId,[...requiredScopes]]);
  if(!current.rows.length)throw partnerError('PARTNER_CREDENTIAL_REVOKED',403);
}
/** Archive/lifecycle take instance before channel; never upgrade a shared channel lock on admission. */
export async function requirePartnerMediaChannelOpen(tx:TenantTransaction,organizationId:string,channelId:string,
  lock:'read'|'write'='read'):Promise<void> {
  if(lock==='write')await lockAttendanceChannel(tx,organizationId,channelId);
  else await lockAttendanceChannelRead(tx,organizationId,channelId);
  const current=(await tx.query<{open:boolean;archived:boolean}>(`SELECT media_private_channel_open($1,$2) AS open,
    i.archived_at IS NOT NULL AS archived FROM messaging_channels c JOIN instances i
      ON i.organization_id=c.organization_id AND i.id=c.instance_id
    WHERE c.organization_id=$1 AND c.id=$2 AND c.provider='BAILEYS' AND c.transport='BROKER_TRANSPORT'`,
  [organizationId,channelId])).rows[0];
  if(current?.archived)throw partnerError('CHANNEL_ARCHIVED',409);
  if(!current?.open)throw partnerError('RESOURCE_DELETING',409);
}
/** Partner identity is optional only on an existing legacy message, never on a missing message. */
export async function assertPartnerMessageAuthority(tx:TenantTransaction, organizationId:string, messageId:string):Promise<void> {
  const message=(await tx.query<{authorizingApiKeyId:string|null;contentType:string;channelId:string}>(
    `SELECT authorizing_api_key_id AS "authorizingApiKeyId",content->>'type' AS "contentType",channel_id AS "channelId"
     FROM messaging_messages WHERE organization_id=$1 AND id=$2`,[organizationId,messageId])).rows[0];
  if(!message)throw partnerError('MESSAGE_NOT_FOUND',404);
  if(!message.authorizingApiKeyId)return;
  await requireActiveOrganization(tx,organizationId);
  await requireCurrentPartnerKey(tx,organizationId,message.authorizingApiKeyId,
    message.contentType==='MEDIA'?['messaging:send','media:send']:['messaging:send']);
  if(message.contentType==='MEDIA') {
    await requirePartnerMediaChannelOpen(tx,organizationId,message.channelId);
    await recheckCurrentPartnerKey(tx,organizationId,message.authorizingApiKeyId,['messaging:send','media:send']);
  }
}
