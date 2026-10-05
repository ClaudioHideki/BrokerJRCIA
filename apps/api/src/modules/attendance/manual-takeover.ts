import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { interruptChatwootAttendance } from './control-service.js';
import { lockAttendanceChannel } from './repository.js';

/** Explicit console decisions are control events, including HUMAN -> HUMAN. */
export async function recordManualAttendanceTakeover(tx:TenantTransaction,org:string,conversationId:string){
  const row=(await tx.query<{channel_id:string}>('SELECT channel_id FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[org,conversationId])).rows[0];
  if(!row)return;
  await lockAttendanceChannel(tx,org,row.channel_id);
  await interruptChatwootAttendance(tx,{organizationId:org,channelId:row.channel_id,conversationId},true);
  await tx.query(`UPDATE chatwoot_attendance_controls SET state='HUMAN',revision=revision+1,updated_at=now()
    WHERE organization_id=$1 AND conversation_id=$2`,[org,conversationId]);
}
