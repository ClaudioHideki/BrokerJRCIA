import { randomUUID } from 'node:crypto';
import { AutomationGraphV1Schema, ResumeAttendanceRequestSchema, type ResumeAttendanceInput, type ResumeOperationView, type AttendanceResumeContext } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { interruptChatwootAttendance } from './control-service.js';
import { AttendanceError } from './types.js';
import { lockAttendanceChannel } from './repository.js';
import { readAttendanceDiagnostic } from './diagnostics.js';
import { isResumeRootState } from './resume-policy.js';
import type { RuntimeState } from '../automations/types.js';
import { captureResume, readResumeRow, requireResumeActor, resumeColumns, resumeHash, resumeView, type ResumeRow } from './resume-repository.js';
export type ResumeServiceOptions = {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;enabled?:boolean};
export function createAttendanceResumeService(options:ResumeServiceOptions) {
  return {
    async requestAttendanceResume(org:string,actor:string,key:string,input:ResumeAttendanceInput):Promise<ResumeOperationView> {
      if(options.enabled===false)throw new AttendanceError('AUTOMATION_RUNTIME_PAUSED',409);
      if(!key||key.length>200)throw new AttendanceError('IDEMPOTENCY_KEY_REQUIRED',422);
      const request=ResumeAttendanceRequestSchema.parse({expectedControlRevision:input.expectedControlRevision,expectedOwnerRevision:input.expectedOwnerRevision,target:input.target});
      const normalized={...request,conversationId:input.conversationId},hash=resumeHash(normalized);
      return options.transact(org,async tx=>{
        await requireActiveOrganization(tx,org);await requireResumeActor(tx,org,actor);
        // Serialize this key even when two clients target different conversations.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`attendance-resume:${org}:${key}`]);
        const prior=(await tx.query<ResumeRow>(`SELECT ${resumeColumns} FROM attendance_resume_operations WHERE organization_id=$1 AND idempotency_key=$2`,[org,key])).rows[0];
        if(prior){if(prior.requestHash!==hash)throw new AttendanceError('IDEMPOTENCY_KEY_REUSED',409);return resumeView(prior);}
        const conversation=(await tx.query<{channel_id:string}>('SELECT channel_id FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[org,input.conversationId])).rows[0];
        if(!conversation)throw new AttendanceError('CONVERSATION_NOT_FOUND',404);
        await lockAttendanceChannel(tx,org,conversation.channel_id);
        if((await tx.query("SELECT 1 FROM attendance_resume_operations WHERE organization_id=$1 AND conversation_id=$2 AND (state IN ('PENDING','UNKNOWN') OR (state='ACTION_REQUIRED' AND phase<>'PREPARED'))",[org,input.conversationId])).rowCount)
          throw new AttendanceError('ATTENDANCE_RESUME_IN_PROGRESS',409);
        const captured=await captureResume(tx,org,normalized);
        await interruptChatwootAttendance(tx,{organizationId:org,channelId:captured.snapshot.channelId,conversationId:input.conversationId},false);
        // Pause changes local/session revisions. Capture the actual reserved state.
        const paused=await captureResume(tx,org,{...normalized,expectedControlRevision:captured.snapshot.scope?normalized.expectedControlRevision:captured.snapshot.localRevision+1});
        const row=(await tx.query<ResumeRow>(`INSERT INTO attendance_resume_operations(organization_id,id,channel_id,conversation_id,actor_id,idempotency_key,request_hash,snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${resumeColumns}`,[org,randomUUID(),paused.snapshot.channelId,input.conversationId,actor,key,hash,JSON.stringify(paused.snapshot)])).rows[0]!;
        return resumeView(row);
      });
    },
    async getOperation(org:string,id:string):Promise<ResumeOperationView> {
      return options.transact(org,async tx=>{const row=await readResumeRow(tx,org,id);if(!row)throw new AttendanceError('ATTENDANCE_RESUME_NOT_FOUND',404);return resumeView(row);});
    },
    async getContext(org:string,conversationId:string):Promise<AttendanceResumeContext> {
      return options.transact(org,async tx=>{
        const row=(await tx.query<{channelId:string;ownerRevision:number|null;sessionId:string|null;state:RuntimeState|null;graph:unknown;runtimeVersion:number;automationId:string|null;version:number|null}>(`
          SELECT m.channel_id AS "channelId",o.revision AS "ownerRevision",s.id AS "sessionId",e.state,v.graph,v.runtime_state_version AS "runtimeVersion",b.automation_id AS "automationId",b.version
          FROM messaging_conversations m LEFT JOIN attendance_owners o ON o.organization_id=m.organization_id AND o.channel_id=m.channel_id
          LEFT JOIN automation_bindings b ON b.organization_id=m.organization_id AND b.channel_id=m.channel_id AND b.status='ACTIVE'
          LEFT JOIN automation_versions v ON v.organization_id=b.organization_id AND v.automation_id=b.automation_id AND v.version=b.version
          LEFT JOIN attendance_sessions s ON s.organization_id=m.organization_id AND s.conversation_id=m.id AND s.state<>'RESOLVED'
          LEFT JOIN automation_executions e ON e.organization_id=s.organization_id AND e.id=s.execution_id
          WHERE m.organization_id=$1 AND m.id=$2`,[org,conversationId])).rows[0];
        if(!row)throw new AttendanceError('CONVERSATION_NOT_FOUND',404);
        const diagnostic=await readAttendanceDiagnostic(tx,{organizationId:org,channelId:row.channelId,conversationId});
        const graph=AutomationGraphV1Schema.safeParse(row.graph),state=row.state;
        const validRoot=isResumeRootState(state,row.automationId,row.version,graph.success?graph.data:null,row.runtimeVersion);
        const compatible=Boolean(validRoot&&state?.waiting?.kind==='EVENT'&&state.stack?.length===0&&state.automationId===row.automationId&&state.version===row.version&&
          graph.success&&graph.data.nodes.some(n=>n.id===state.waiting!.nodeId&&['input','menu'].includes(n.type)));
        const op=(await tx.query<ResumeRow>(`SELECT ${resumeColumns} FROM attendance_resume_operations WHERE organization_id=$1 AND conversation_id=$2 AND (state IN ('PENDING','UNKNOWN') OR (state='ACTION_REQUIRED' AND phase<>'PREPARED'))`,[org,conversationId])).rows[0];
        return {diagnostic,ownerRevision:row.ownerRevision??0,hasActiveSession:row.sessionId!==null&&validRoot,hasCompatibleCursor:compatible,
          menuNodes:graph.success&&row.sessionId&&validRoot?graph.data.nodes.filter(n=>n.type==='menu').map(n=>({id:n.id,label:n.label})):[],operation:op?resumeView(op):null};
      });
    },
  };
}
