import type { TenantTransaction } from '../../db/tenant-transaction.js';

/**
 * The caller holds the execution lock. Input waits consume exactly one admitted
 * message; IO and delay waits can only be advanced by their own completion.
 */
export async function promoteAttendanceInput(tx: TenantTransaction, org: string, executionId: string): Promise<boolean> {
  const waiting = (await tx.query<{ id:string }>(`
    select w.id from automation_waits w join automation_executions e
      on e.organization_id=w.organization_id and e.id=w.execution_id
    where w.organization_id=$1 and w.execution_id=$2 and w.kind='EVENT' and w.status='WAITING' and e.status='WAITING'
    for update of w`, [org, executionId])).rows[0];
  if (!waiting) return false;
  const event = (await tx.query<{ id:string; event_key:string; payload:Record<string,unknown> }>(`
    select id,event_key,payload from automation_events where organization_id=$1 and execution_id=$2
      and status='PENDING' and type='MESSAGE' order by queue_sequence limit 1 for update`, [org, executionId])).rows[0];
  if (!event) return false;
  await tx.query(`update automation_waits set status='RESUMED',resume_event_key=$3,resumed_at=now()
    where organization_id=$1 and id=$2`, [org, waiting.id, event.event_key]);
  await tx.query(`update automation_executions set status='QUEUED',input=$3,updated_at=now(),lease_token=null,lease_expires_at=null
    where organization_id=$1 and id=$2`, [org, executionId, JSON.stringify({ ...event.payload, eventType:'MESSAGE' })]);
  await tx.query(`update automation_events set status='CONSUMED',consumed_at=now()
    where organization_id=$1 and id=$2 and status='PENDING'`, [org, event.id]);
  return true;
}
