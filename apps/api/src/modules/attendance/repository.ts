import { attendanceScopeSchema, type AttendanceScope } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { AttendanceError } from './types.js';



export async function lockAttendanceChannel(tx: TenantTransaction, org: string, channelId: string) {
  await tx.query('select tenant_is_active($1)',[org]);
  await lockChannelInstance(tx,org,channelId);
  const result = await tx.query('select id from messaging_channels where organization_id=$1 and id=$2 for no key update',[org,channelId]);
  if (!result.rowCount) throw new AttendanceError('CHANNEL_NOT_FOUND',404);
}

async function lockChannelInstance(tx:TenantTransaction,org:string,channelId:string){
  // Archive/lifecycle already lock instance before channel. The corresponding
  // INSERT triggers take instance SHARE; preserve that order at admission.
  await tx.query(`select i.id from instances i join messaging_channels c on c.organization_id=i.organization_id and c.instance_id=i.id
    where c.organization_id=$1 and c.id=$2 for share of i`,[org,channelId]);
}
export async function lockAttendanceChannelRead(tx:TenantTransaction,org:string,channelId:string){
  await tx.query('select tenant_is_active($1)',[org]);
  await lockChannelInstance(tx,org,channelId);
  await tx.query('select id from messaging_channels where organization_id=$1 and id=$2 for share',[org,channelId]);
}

// Remote references are fetched from tenant data; caller-supplied account/inbox IDs never authorize a claim.
export async function resolveAttendanceScope(tx: TenantTransaction, org: string, channelId: string, requireReady=true): Promise<AttendanceScope | null> {
  const result = await tx.query<{
    integrationId:string; destinationRevision:number; accountId:string|null; inboxId:string|null;
    connectionStatus:string; accountStatus:string; approvalStatus:string;
  }>(`select c.id AS "integrationId",d.revision AS "destinationRevision",a.account_id AS "accountId",c.inbox_id AS "inboxId",
       c.status AS "connectionStatus",a.status AS "accountStatus",d.approval_status AS "approvalStatus"
     from chatwoot_connections c join chatwoot_accounts a on a.organization_id=c.organization_id
     join chatwoot_destinations d on d.organization_id=a.organization_id and d.base_url=a.base_url
     where c.organization_id=$1 and c.channel_id=$2 for share of c,a,d`,[org,channelId]);
  const row=result.rows[0];
  if (!row) return null;
  if (requireReady && (row.connectionStatus !== 'READY' || row.accountStatus !== 'READY' || row.approvalStatus !== 'APPROVED')) {
    throw new AttendanceError('ATTENDANCE_DESTINATION_NOT_READY',409);
  }
  const parsed=attendanceScopeSchema.safeParse({organizationId:org,channelId,integrationId:row.integrationId,
    destinationRevision:row.destinationRevision,accountId:Number(row.accountId),inboxId:Number(row.inboxId)});
  if (!parsed.success) throw new AttendanceError('ATTENDANCE_DESTINATION_NOT_READY',409);
  return parsed.data;
}

