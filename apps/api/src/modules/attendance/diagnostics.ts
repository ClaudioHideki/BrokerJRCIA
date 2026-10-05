import { AUTOMATION_ORIGIN, type AttendanceDiagnostic } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { readChatwootAttendanceGate, type AttendanceGate, type AttendanceGateInput } from './control-service.js';
import { AttendanceError } from './types.js';

export function attendanceDiagnostic(facts:{gate:AttendanceGate;scopeValid:boolean;ownerValid:boolean;localMode:string;sessionState:string|null;pending:boolean}):AttendanceDiagnostic {
  const {gate}=facts;
  const reason:AttendanceDiagnostic['reason']=!facts.scopeValid?'SCOPE_CHANGED':!facts.ownerValid?'OWNER_CHANGED':
    gate.state==='HUMAN'?'HUMAN_CONTROL':facts.pending||gate.state==='RECONCILE'?'REMOTE_RECONCILE':
    gate.state==='INITIALIZING'?'REMOTE_INITIALIZING':gate.state==='PAUSED'?'REMOTE_PAUSED':facts.localMode==='HUMAN'?'LOCAL_HUMAN':
    ['ADMIN_PAUSED','HUMAN_ACTIVE','WAITING_HUMAN','HANDOFF_PENDING','RESOLVED'].includes(facts.sessionState??'')?'SESSION_PAUSED':'NONE';
  return {allowed:reason==='NONE'&&gate.allowed,reason,controlRevision:gate.revision,cycle:gate.cycle};
}
export async function readAttendanceDiagnostic(tx:TenantTransaction,input:AttendanceGateInput):Promise<AttendanceDiagnostic> {
  const facts=(await tx.query<{mode:string;localRevision:number;sessionState:string|null;ownerValid:boolean;scopeValid:boolean;pending:boolean}>(`
    SELECT m.mode,m.attendance_revision AS "localRevision",s.state AS "sessionState",
      (o.executor='BROKER' AND o.remote_binding_id IS NULL AND o.automation_id=b.automation_id AND o.version=b.version
        AND ch.bot_public_id=b.automation_id::text AND ch.bot_origin_reference=$4 AND b.status='ACTIVE' AND ch.deleting_at IS NULL
        AND tenant.status='ACTIVE' AND f.enabled) AS "ownerValid",
      (x.id IS NULL OR (x.status='READY' AND a.status='READY' AND d.approval_status='APPROVED' AND
        (cc.conversation_id IS NULL OR (cc.integration_id=x.id AND cc.destination_revision=d.revision AND cc.account_id=a.account_id AND cc.inbox_id=x.inbox_id)))) AS "scopeValid",
      (EXISTS(SELECT 1 FROM chatwoot_attendance_observations obs WHERE obs.organization_id=m.organization_id AND obs.conversation_id=m.id AND obs.disposition IN ('ECHO_PENDING','RECONCILE'))
        OR EXISTS(SELECT 1 FROM attendance_resume_operations r WHERE r.organization_id=m.organization_id AND r.conversation_id=m.id AND (r.state='UNKNOWN' OR (r.state='ACTION_REQUIRED' AND r.phase<>'PREPARED')))
        OR EXISTS(SELECT 1 FROM chatwoot_mirror_attempts mirror WHERE mirror.organization_id=m.organization_id AND mirror.conversation_id=m.id AND mirror.state IN ('DISPATCHED','UNKNOWN'))
        OR (cc.cycle IS NOT NULL AND s.cycle IS NOT NULL AND cc.cycle<>s.cycle)) AS pending
    FROM messaging_conversations m JOIN messaging_channels ch ON ch.organization_id=m.organization_id AND ch.id=m.channel_id
    JOIN organizations tenant ON tenant.id=m.organization_id LEFT JOIN flow_features f ON f.organization_id=m.organization_id
    LEFT JOIN attendance_owners o ON o.organization_id=m.organization_id AND o.channel_id=m.channel_id
    LEFT JOIN automation_bindings b ON b.organization_id=m.organization_id AND b.channel_id=m.channel_id AND b.status IN ('ACTIVE','PAUSED')
    LEFT JOIN attendance_sessions s ON s.organization_id=m.organization_id AND s.conversation_id=m.id AND s.state<>'RESOLVED'
    LEFT JOIN chatwoot_connections x ON x.organization_id=m.organization_id AND x.channel_id=m.channel_id
    LEFT JOIN chatwoot_accounts a ON a.organization_id=m.organization_id
    LEFT JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    LEFT JOIN chatwoot_attendance_controls cc ON cc.organization_id=m.organization_id AND cc.conversation_id=m.id
    WHERE m.organization_id=$1 AND m.id=$2 AND m.channel_id=$3`,[input.organizationId,input.conversationId,input.channelId,AUTOMATION_ORIGIN])).rows[0];
  if(!facts)throw new AttendanceError('CONVERSATION_NOT_FOUND',404);
  const remote=await readChatwootAttendanceGate(tx,input),gate=remote.state==='NONE'?{...remote,revision:facts.localRevision}:remote;
  return attendanceDiagnostic({gate,scopeValid:facts.scopeValid===true,ownerValid:facts.ownerValid===true,localMode:facts.mode,sessionState:facts.sessionState,pending:facts.pending});
}
