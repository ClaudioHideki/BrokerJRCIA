import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { AttendanceError } from './types.js';

export type AttendanceGateInput = {organizationId:string;channelId:string;conversationId:string};
export type AttendanceGate = {allowed:boolean;revision:number;state:'NONE'|'INITIALIZING'|'READY'|'HUMAN'|'PAUSED'|'RECONCILE';cycle:number|null};

/** Caller locks the channel before executions/jobs/conversation. This read never resumes a session. */
export async function readChatwootAttendanceGate(tx:TenantTransaction,input:AttendanceGateInput):Promise<AttendanceGate> {
  const row=(await tx.query<{revision:number;state:AttendanceGate['state'];cycle:number;pending:boolean;current_cycle:number|null;local_mode:string;current_scope:boolean}>(`
    SELECT c.revision,c.state,c.cycle,m.mode AS local_mode,
      EXISTS(SELECT 1 FROM chatwoot_connections x JOIN chatwoot_accounts a ON a.organization_id=x.organization_id
        JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
        WHERE x.organization_id=c.organization_id AND x.id=c.integration_id AND x.channel_id=c.channel_id
          AND x.status='READY' AND a.status='READY' AND d.approval_status='APPROVED'
          AND d.revision=c.destination_revision AND a.account_id=c.account_id AND x.inbox_id=c.inbox_id) AS current_scope,
      (EXISTS(SELECT 1 FROM chatwoot_attendance_observations o WHERE o.organization_id=c.organization_id
        AND o.integration_id=c.integration_id AND o.destination_revision=c.destination_revision AND o.account_id=c.account_id
        AND o.inbox_id=c.inbox_id AND o.remote_conversation_id=c.remote_conversation_id AND o.disposition IN ('ECHO_PENDING','RECONCILE'))
       OR EXISTS(SELECT 1 FROM chatwoot_mirror_attempts a WHERE a.organization_id=c.organization_id AND a.integration_id=c.integration_id
        AND a.destination_revision=c.destination_revision AND a.account_id=c.account_id AND a.inbox_id=c.inbox_id
        AND a.conversation_id=c.conversation_id AND a.cycle=c.cycle AND a.state IN ('DISPATCHED','UNKNOWN'))) AS pending,
      (SELECT s.cycle FROM attendance_sessions s WHERE s.organization_id=c.organization_id AND s.conversation_id=c.conversation_id
        AND s.state<>'RESOLVED') AS current_cycle
    FROM chatwoot_attendance_controls c JOIN messaging_conversations m ON m.organization_id=c.organization_id AND m.id=c.conversation_id
    WHERE c.organization_id=$1 AND c.channel_id=$2 AND c.conversation_id=$3`,
    [input.organizationId,input.channelId,input.conversationId])).rows[0];
  if(row) return {allowed:row.state==='READY'&&row.local_mode==='BOT'&&row.current_scope&&!row.pending&&(row.current_cycle===null||row.current_cycle===row.cycle),revision:row.revision,state:row.state,cycle:row.cycle};
  const required=Boolean((await tx.query(`SELECT 1 FROM attendance_owners o JOIN chatwoot_connections c
    ON c.organization_id=o.organization_id AND c.channel_id=o.channel_id WHERE o.organization_id=$1 AND o.channel_id=$2 AND o.executor='BROKER'`,
    [input.organizationId,input.channelId])).rowCount);
  return {allowed:!required,revision:0,state:required?'INITIALIZING':'NONE',cycle:null};
}

export async function assertChatwootAttendanceGate(tx:TenantTransaction,input:AttendanceGateInput,expectedRevision?:number):Promise<AttendanceGate> {
  const gate=await readChatwootAttendanceGate(tx,input);
  if(!gate.allowed || (expectedRevision!==undefined&&gate.revision!==expectedRevision))throw new AttendanceError('ATTENDANCE_REMOTE_CONTROL_CHANGED',409);
  return gate;
}

/** One conversation only. Known dispatched/UNKNOWN effects remain reconcilable rather than falsely canceled. */
export async function interruptChatwootAttendance(tx:TenantTransaction,input:AttendanceGateInput,human:boolean) {
  const args=[input.organizationId,input.conversationId];
  await tx.query('SELECT id FROM automation_executions WHERE organization_id=$1 AND conversation_id=$2 ORDER BY id FOR NO KEY UPDATE',args);
  await tx.query(`UPDATE automation_outbox o SET status='CANCELED',last_error='CHATWOOT_ATTENDANCE_CONTROL',updated_at=now()
    FROM automation_executions e WHERE e.organization_id=$1 AND e.conversation_id=$2 AND o.organization_id=e.organization_id AND o.execution_id=e.id AND o.status='PENDING'`,args);
  await tx.query(`UPDATE automation_waits w SET status='CANCELED' FROM automation_executions e
    WHERE e.organization_id=$1 AND e.conversation_id=$2 AND w.organization_id=e.organization_id AND w.execution_id=e.id AND w.status='WAITING'`,args);
  await tx.query(`UPDATE automation_executions SET status='CANCELED',error_code='CHATWOOT_ATTENDANCE_CONTROL',lease_token=null,lease_expires_at=null,
    completed_at=now(),updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND status IN ('QUEUED','RUNNING','WAITING')`,args);
  await tx.query(`SELECT o.message_id FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id
    WHERE m.organization_id=$1 AND m.conversation_id=$2 AND m.source='AUTOMATION' AND m.state='ACCEPTED' ORDER BY o.message_id FOR UPDATE OF o`,args);
  await tx.query(`WITH canceled AS (UPDATE messaging_messages SET state='FAILED',canonical_error_code='CHATWOOT_ATTENDANCE_CONTROL',updated_at=now()
    WHERE organization_id=$1 AND conversation_id=$2 AND direction='OUTGOING' AND source='AUTOMATION' AND state='ACCEPTED' RETURNING organization_id,id)
    DELETE FROM messaging_outbox o USING canceled m WHERE o.organization_id=m.organization_id AND o.message_id=m.id`,args);
  await tx.query('SELECT message_id FROM messaging_bot_jobs WHERE organization_id=$1 AND conversation_id=$2 ORDER BY message_id FOR UPDATE',args);
  await tx.query(`UPDATE messaging_bot_jobs SET status=CASE WHEN status='RUNNING' THEN 'UNKNOWN'::messaging_bot_job_status ELSE 'PAUSED'::messaging_bot_job_status END,
    lease_token=null,lease_expires_at=null,canonical_error_code='CHATWOOT_ATTENDANCE_CONTROL',updated_at=now()
    WHERE organization_id=$1 AND conversation_id=$2 AND status IN ('PENDING','RUNNING')`,args);
  // HUMAN mode is the pre-existing dispatch pause. Non-human conflict is recorded separately in the control/session state.
  await tx.query("UPDATE messaging_conversations SET mode='HUMAN',updated_at=now() WHERE organization_id=$1 AND id=$2",args);
  await tx.query(`UPDATE attendance_sessions SET state=CASE WHEN $3 THEN 'HUMAN_ACTIVE' ELSE 'ADMIN_PAUSED' END,revision=revision+1,updated_at=now()
    WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('BOT_ACTIVE','WAITING_INPUT','HANDOFF_PENDING','WAITING_HUMAN')
      AND ($3 OR state IN ('BOT_ACTIVE','WAITING_INPUT'))`,[...args,human]);
}
