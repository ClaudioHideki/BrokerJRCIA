import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {readChatwootAccount,type AccountRow} from './chatwoot-context.js';
import {readChatwootConnection,type ConnectionRow} from './chatwoot-service.js';
import {lockChatwootDestination} from './chatwoot-destination.js';
import {IntegrationError} from './integration-error.js';
import {lockAttendanceChannel} from '../attendance/repository.js';

/** Hold the captured destination/credential/channel until the local COMMIT.
 * Never hold these locks across HTTP. Destination precedes attendance locks. */
export async function assertChatwootMirrorContext(tx:TenantTransaction,account:AccountRow,connection:ConnectionRow,instanceId?:string|null){
 const org=account.organization_id;
 await lockChatwootDestination(tx,org);
 await lockAttendanceChannel(tx,org,connection.channel_id);
 const row=(await tx.query<{instance_id:string|null}>(`SELECT ch.instance_id FROM chatwoot_connections c
  JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
  JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
  JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
  JOIN organizations o ON o.id=c.organization_id
  WHERE c.organization_id=$1 AND c.id=$2 AND o.status='ACTIVE'
  FOR SHARE OF c,a,d`,[org,connection.id])).rows[0];
 const currentAccount=await readChatwootAccount(tx,org),current=await readChatwootConnection(tx,org,connection.id);
 if(!row||!currentAccount||!current||currentAccount.status!=='READY'||current.status!=='READY'
  ||currentAccount.base_url!==account.base_url||currentAccount.account_id!==account.account_id
  ||currentAccount.credential_version!==account.credential_version||currentAccount.encrypted_token!==account.encrypted_token
  ||currentAccount.destination?.approvalStatus!=='APPROVED'||currentAccount.destination?.revision!==account.destination?.revision
  ||currentAccount.destination?.baseUrl!==account.destination?.baseUrl||currentAccount.destination?.mode!==account.destination?.mode
  ||current.channel_id!==connection.channel_id||current.inbox_id!==connection.inbox_id
  ||current.encrypted_webhook_secret!==connection.encrypted_webhook_secret
  ||instanceId!==undefined&&row.instance_id!==instanceId)
  throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
}
