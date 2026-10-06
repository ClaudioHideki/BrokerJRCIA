import type { LocalAttendanceScopeV2 } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { lockAttendanceChannelRead } from './repository.js';
import { AttendanceError } from './types.js';

/** A broken connection is still configured. No JOIN with credentials may erase it
 * and silently turn remote authority into local authority. Caller owns the transaction. */
export async function assertStandaloneDestination(tx:TenantTransaction,org:string,channelId:string):Promise<LocalAttendanceScopeV2>{
 await requireActiveOrganization(tx,org);
 await lockAttendanceChannelRead(tx,org,channelId);
 const channel=(await tx.query<{deleting:boolean;archived:boolean}>(`SELECT (c.deleting_at IS NOT NULL) AS deleting,
   (i.archived_at IS NOT NULL) AS archived FROM messaging_channels c LEFT JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
   WHERE c.organization_id=$1 AND c.id=$2`,[org,channelId])).rows[0];
 if(!channel)throw new AttendanceError('CHANNEL_NOT_FOUND',404);
 if(channel.deleting||channel.archived)throw new AttendanceError('CHANNEL_ARCHIVED',409);
 const configured=(await tx.query(`SELECT 1 FROM chatwoot_connections WHERE organization_id=$1 AND channel_id=$2
   UNION ALL SELECT 1 FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2 AND (integration_id IS NOT NULL OR remote_binding_id IS NOT NULL)
   UNION ALL SELECT 1 FROM chatwoot_attendance_controls WHERE organization_id=$1 AND channel_id=$2
   UNION ALL SELECT 1 FROM attendance_sessions WHERE organization_id=$1 AND channel_id=$2 AND state<>'RESOLVED' AND integration_id IS NOT NULL
   LIMIT 1`,[org,channelId])).rowCount;
 if(configured)throw new AttendanceError('ATTENDANCE_CENTRAL_CONFIGURED',409);
 return {kind:'LOCAL',organizationId:org,channelId};
}
