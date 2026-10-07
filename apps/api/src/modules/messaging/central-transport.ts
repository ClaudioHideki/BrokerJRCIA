import { z } from 'zod';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import type { CentralRuntimeEventBinding } from '../integrations/chatwoot-runtime-event.js';
import { readChatwootAccount } from '../integrations/chatwoot-context.js';

const positiveId=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const creation=z.strictObject({organizationId:z.uuid(),channelId:z.uuid(),integrationId:z.uuid(),
 origin:z.string().max(2048).refine(value=>{try {const url=new URL(value);return url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password;}catch{return false;}}),
 accountId:positiveId,inboxId:positiveId,destinationRevision:positiveId,credentialVersion:positiveId,
 ownerRevision:z.literal(0),encryptedWebhookSecret:z.string().min(1).max(8192),name:z.string().trim().min(1).max(120)});
type ContextRow={channelId:string;organizationId:string;integrationId:string;origin:string;accountId:string;inboxId:string;
 destinationRevision:number;credentialVersion:number;ownerRevision:number;status:CentralRuntimeEventBinding['status'];
 accountStatus:string;connectionStatus:string;approval:string;tenantStatus:string;encryptedToken:string|null;encryptedWebhookSecret:string|null;
 currentOrigin:string;currentAccountId:string|null;currentInboxId:string|null;currentDestinationRevision:number;currentCredentialVersion:number;currentOwnerRevision:number;botId:string|null;botCallback:string|null};
export async function readCentralTransportBinding(tx:TenantTransaction,org:string,integrationId:string,lock=false) {
 if(lock){
  const channel=(await tx.query<{channel_id:string}>('SELECT channel_id FROM central_transport_bindings WHERE organization_id=$1 AND integration_id=$2',[org,integrationId])).rows[0];
  if(!channel)throw new Error('CENTRAL_BINDING_NOT_FOUND');
  await lockAttendanceChannel(tx,org,channel.channel_id);
 }
 const row=(await tx.query<ContextRow>(`SELECT b.organization_id AS "organizationId",b.channel_id AS "channelId",b.integration_id AS "integrationId",
 b.origin,b.account_id AS "accountId",b.inbox_id AS "inboxId",b.destination_revision AS "destinationRevision",b.credential_version AS "credentialVersion",
 b.owner_revision AS "ownerRevision",b.bot_id AS "botId",b.bot_callback AS "botCallback",b.status,a.status AS "accountStatus",c.status AS "connectionStatus",d.approval_status AS approval,o.status AS "tenantStatus",
 a.encrypted_token AS "encryptedToken",c.encrypted_webhook_secret AS "encryptedWebhookSecret",
 a.base_url AS "currentOrigin",a.account_id AS "currentAccountId",c.inbox_id AS "currentInboxId",d.revision AS "currentDestinationRevision",
 a.credential_version AS "currentCredentialVersion",coalesce((SELECT revision FROM attendance_owners own WHERE own.organization_id=b.organization_id AND own.channel_id=b.channel_id),0) AS "currentOwnerRevision"
 FROM central_transport_bindings b JOIN messaging_channels m ON m.organization_id=b.organization_id AND m.id=b.channel_id AND m.transport='CENTRAL_TRANSPORT'
 JOIN chatwoot_connections c ON c.organization_id=b.organization_id AND c.id=b.integration_id AND c.channel_id=b.channel_id
 JOIN chatwoot_accounts a ON a.organization_id=b.organization_id
 JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
 JOIN organizations o ON o.id=b.organization_id
 WHERE b.organization_id=$1 AND b.integration_id=$2 AND m.deleting_at IS NULL ${lock?'FOR SHARE OF b,c,a,d':''}`,[org,integrationId])).rows[0];
 if(!row)throw new Error('CENTRAL_BINDING_NOT_FOUND');
 if(row.tenantStatus!=='ACTIVE'||row.status!=='READY'||row.accountStatus!=='READY'||row.connectionStatus!=='READY'||row.approval!=='APPROVED'||!row.encryptedToken||!row.encryptedWebhookSecret)
  throw new Error('CENTRAL_BINDING_NOT_READY');
 if(row.origin!==row.currentOrigin||Number(row.accountId)!==Number(row.currentAccountId)||Number(row.inboxId)!==Number(row.currentInboxId)||
  row.destinationRevision!==row.currentDestinationRevision||row.credentialVersion!==row.currentCredentialVersion||row.ownerRevision!==row.currentOwnerRevision)
  throw new Error('CENTRAL_CONTEXT_CHANGED');
 const binding:CentralRuntimeEventBinding={organizationId:org,channelId:row.channelId,integrationId,origin:row.origin,accountId:Number(row.accountId),inboxId:Number(row.inboxId),
  destinationRevision:row.destinationRevision,credentialVersion:row.credentialVersion,ownerRevision:row.ownerRevision,status:row.status,transport:'CENTRAL_TRANSPORT'};
 return {binding,encryptedWebhookSecret:row.encryptedWebhookSecret,botId:row.botId===null?null:Number(row.botId),botCallback:row.botCallback};
}

/** Capture credential and destination under the same short SQL locks; HTTP follows commit. */
export async function readCentralTransportContext(tx:TenantTransaction,org:string,integrationId:string) {
 const {binding,botId,botCallback}=await readCentralTransportBinding(tx,org,integrationId,true);
 const account=await readChatwootAccount(tx,org);
 if(!account||account.base_url!==binding.origin||Number(account.account_id)!==binding.accountId||
  account.credential_version!==binding.credentialVersion||account.destination?.revision!==binding.destinationRevision||
  account.destination.baseUrl!==binding.origin||account.destination.approvalStatus!=='APPROVED')throw new Error('CENTRAL_CONTEXT_CHANGED');
 return {binding,account,botId,botCallback};
}

/** Internal preparation only. HTTP creation/cutover becomes available with the
 * central dispatcher, never by inventing a QR/Meta provider or taking over an
 * existing inbox's executor here. There is no automation owner at preparation. */
export async function createCentralTransportChannel(tx:TenantTransaction,raw:z.input<typeof creation>) {
 const p=creation.parse(raw);
 const context=(await tx.query(`SELECT 1 FROM chatwoot_accounts a JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
 JOIN organizations o ON o.id=a.organization_id
 WHERE a.organization_id=$1 AND a.base_url=$2 AND a.account_id=$3 AND a.credential_version=$4 AND a.status='READY' AND a.encrypted_token IS NOT NULL
 AND d.revision=$5 AND d.approval_status='APPROVED' AND o.status='ACTIVE' FOR SHARE OF a,d`,[p.organizationId,p.origin,p.accountId,p.credentialVersion,p.destinationRevision])).rowCount;
 if(!context)throw new Error('CENTRAL_CONTEXT_CHANGED');
 await tx.query(`INSERT INTO messaging_channels(id,organization_id,transport,provider,provider_account_id,credential_reference)
 VALUES($1,$2,'CENTRAL_TRANSPORT',NULL,NULL,NULL)`,[p.channelId,p.organizationId]);
 await tx.query(`INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret)
 VALUES($1,$2,$3,$4,$5,'READY',$6)`,[p.integrationId,p.organizationId,p.channelId,p.inboxId,p.name,p.encryptedWebhookSecret]);
 await tx.query(`INSERT INTO central_transport_bindings(organization_id,channel_id,integration_id,origin,account_id,inbox_id,destination_revision,credential_version,owner_revision)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[p.organizationId,p.channelId,p.integrationId,p.origin,p.accountId,p.inboxId,p.destinationRevision,p.credentialVersion,p.ownerRevision]);
 return (await readCentralTransportBinding(tx,p.organizationId,p.integrationId)).binding;
}
