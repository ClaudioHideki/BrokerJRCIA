import {randomUUID} from 'node:crypto';
import {
 LocalAssignmentRequestSchema,LocalQueueItemSchema,LocalQueueSchema,LocalTeamCreateSchema,
 LocalTeamMembersSchema,LocalTeamsViewSchema,LocalTeamUpdateSchema,LocalTeamViewSchema,
 type LocalQueueItem,type LocalTeamView,
} from '@jrc/contracts';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import {requireActiveOrganization} from '../tenancy/operational-limits.js';
import {assertStandaloneDestination} from './destination-adapter.js';
import {assertLocalHumanTarget,createLocalAttendanceDirectory} from './local-directory.js';
import {lockAttendanceChannel} from './repository.js';
import {AttendanceError} from './types.js';

type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>};
async function requireActor(tx:TenantTransaction,org:string,actor:string,admin=true){
 await requireActiveOrganization(tx,org);
 const member=(await tx.query<{role:string}>('SELECT role FROM lock_local_attendance_member($1)',[actor])).rows[0];
 if(!member||(admin&&!['OWNER','ADMIN'].includes(member.role)))throw new AttendanceError('FORBIDDEN',403);
 return member.role;
}
async function audit(tx:TenantTransaction,org:string,actor:string,id:string,type:string,resource:string){
 await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
   VALUES($1,$2,$3,$4,$5,$6,'SUCCESS','{}')`,[org,actor,type,resource,id,randomUUID()]);
}
async function teamView(tx:TenantTransaction,org:string,id:string):Promise<LocalTeamView>{
 const team=(await tx.query(`SELECT t.id,t.name,t.status,t.revision,
   ARRAY(SELECT m.user_id FROM local_attendance_team_members m WHERE m.organization_id=t.organization_id AND m.team_id=t.id ORDER BY m.user_id LIMIT 1001) AS "memberIds"
   FROM local_attendance_teams t WHERE t.organization_id=$1 AND t.id=$2`,[org,id])).rows[0];
 return LocalTeamViewSchema.parse(team);
}
const queueColumns=`s.conversation_id AS "conversationId",s.id AS "sessionId",s.revision AS "sessionRevision",s.cycle,s.state,
 CASE WHEN s.local_team_id IS NOT NULL THEN jsonb_build_object('kind','TEAM','teamId',s.local_team_id)
      WHEN s.local_agent_id IS NOT NULL THEN jsonb_build_object('kind','AGENT','agentId',s.local_agent_id)
      ELSE jsonb_build_object('kind','QUEUE') END AS target`;

export function createLocalAttendanceDirectoryService(options:Options){
 const edit=async(org:string,actor:string,id:string,revision:number,work:(tx:TenantTransaction)=>Promise<void>)=>options.transact(org,async tx=>{
  await requireActiveOrganization(tx,org);
  // Team rows precede locked member identities in both editing and validation.
  const team=(await tx.query<{revision:number}>('SELECT revision FROM local_attendance_teams WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,id])).rows[0];
  await requireActor(tx,org,actor);
  if(!team)throw new AttendanceError('LOCAL_TEAM_NOT_FOUND',404);
  if(team.revision!==revision)throw new AttendanceError('LOCAL_TEAM_REVISION_CHANGED',409);
  await work(tx);
  await tx.query('UPDATE local_attendance_teams SET revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2',[org,id]);
  await audit(tx,org,actor,id,'LOCAL_ATTENDANCE_TEAM_CHANGED','attendance_team');
  return teamView(tx,org,id);
 });
 return {
  async catalog(org:string,actor:string,channel:string){
   // Revalidation and projection share one transaction, including the actor lock.
   return options.transact(org,async tx=>{
    await requireActor(tx,org,actor);
    return createLocalAttendanceDirectory({transact:async<T>(_org:string,work:OrganizationTransaction<T>)=>work(tx)}).catalog(org,channel);
   });
  },
  async listTeams(org:string,actor:string){return options.transact(org,async tx=>{
   await requireActor(tx,org,actor);
   const agents=(await tx.query('SELECT user_id AS id,email,role FROM current_local_attendance_members()')).rows;
   const teams=(await tx.query(`SELECT t.id,t.name,t.status,t.revision,
    ARRAY(SELECT m.user_id FROM local_attendance_team_members m WHERE m.organization_id=t.organization_id AND m.team_id=t.id ORDER BY m.user_id LIMIT 1001) AS "memberIds"
    FROM local_attendance_teams t WHERE t.organization_id=$1 ORDER BY t.id LIMIT 1001`,[org])).rows;
   if(agents.length>1000||teams.length>1000||teams.some(t=>t.memberIds.length>1000))throw new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409);
   return LocalTeamsViewSchema.parse({agents,teams});
  });},
  async createTeam(org:string,actor:string,input:unknown){
   const parsed=LocalTeamCreateSchema.parse(input);
   return options.transact(org,async tx=>{
    await requireActor(tx,org,actor);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`local-team-create:${org}`]);
    const count=(await tx.query<{count:number}>('SELECT count(*)::int AS count FROM local_attendance_teams WHERE organization_id=$1',[org])).rows[0]!.count;
    if(count>=1000)throw new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409);
    const id=randomUUID();await tx.query('INSERT INTO local_attendance_teams(organization_id,id,name) VALUES($1,$2,$3)',[org,id,parsed.name]);
    await audit(tx,org,actor,id,'LOCAL_ATTENDANCE_TEAM_CREATED','attendance_team');return teamView(tx,org,id);
   });
  },
  async updateTeam(org:string,actor:string,id:string,input:unknown){
   const p=LocalTeamUpdateSchema.parse(input);
   return edit(org,actor,id,p.expectedRevision,async tx=>{await tx.query('UPDATE local_attendance_teams SET name=$3,status=$4 WHERE organization_id=$1 AND id=$2',[org,id,p.name,p.status]);});
  },
  async replaceMembers(org:string,actor:string,id:string,input:unknown){
   const p=LocalTeamMembersSchema.parse(input);
   return edit(org,actor,id,p.expectedRevision,async tx=>{
    for(const member of [...p.memberIds].sort())if((await tx.query('SELECT user_id FROM lock_local_attendance_member($1)',[member])).rowCount!==1)throw new AttendanceError('LOCAL_AGENT_UNAVAILABLE',409);
    await tx.query('DELETE FROM local_attendance_team_members WHERE organization_id=$1 AND team_id=$2',[org,id]);
    await tx.query('INSERT INTO local_attendance_team_members(organization_id,team_id,user_id) SELECT $1,$2,unnest($3::uuid[])',[org,id,p.memberIds]);
   });
  },
  async queue(org:string,actor:string,channel:string){return options.transact(org,async tx=>{
   await requireActor(tx,org,actor,false);const scope=await assertStandaloneDestination(tx,org,channel);
   const data=(await tx.query(`SELECT ${queueColumns} FROM attendance_sessions s
    WHERE s.organization_id=$1 AND s.channel_id=$2 AND s.integration_id IS NULL AND s.state IN ('WAITING_HUMAN','HUMAN_ACTIVE')
    ORDER BY s.created_at,s.id LIMIT 1001`,[org,channel])).rows;
   if(data.length>1000)throw new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409);
   return LocalQueueSchema.parse({scope,data});
  });},
  async assign(org:string,actor:string,conversationId:string,input:unknown):Promise<LocalQueueItem>{
   const p=LocalAssignmentRequestSchema.parse(input);
   return options.transact(org,async tx=>{
    await requireActiveOrganization(tx,org);
    const role=await requireActor(tx,org,actor,false);
    if(role==='OPERATOR'&&(p.target.kind!=='AGENT'||p.target.agentId!==actor))throw new AttendanceError('FORBIDDEN',403);
    const conversation=(await tx.query<{channel_id:string}>('SELECT channel_id FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[org,conversationId])).rows[0];
    if(!conversation)throw new AttendanceError('CONVERSATION_NOT_FOUND',404);
    await lockAttendanceChannel(tx,org,conversation.channel_id);
    await assertStandaloneDestination(tx,org,conversation.channel_id);
    if((await tx.query("SELECT 1 FROM attendance_resume_operations WHERE organization_id=$1 AND conversation_id=$2 AND (state IN ('PENDING','UNKNOWN') OR (state='ACTION_REQUIRED' AND phase<>'PREPARED'))",[org,conversationId])).rowCount)throw new AttendanceError('ATTENDANCE_RESUME_IN_PROGRESS',409);
    const control=(await tx.query<{mode:string}>('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE',[org,conversationId])).rows[0];
    const session=(await tx.query<{id:string;revision:number;state:string}>('SELECT id,revision,state FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$2 AND state<>\'RESOLVED\' FOR UPDATE',[org,conversationId])).rows[0];
    if(!session||!['WAITING_HUMAN','HUMAN_ACTIVE'].includes(session.state))throw new AttendanceError('ATTENDANCE_LOCAL_SESSION_REQUIRED',409);
    if(session.id!==p.expectedSessionId||session.revision!==p.sessionRevision)throw new AttendanceError('ATTENDANCE_SESSION_CHANGED',409);
    if(control?.mode!=='HUMAN')throw new AttendanceError('ATTENDANCE_LOCAL_STATE_CHANGED',409);
    await assertLocalHumanTarget(tx,org,conversation.channel_id,p.target);
    const active=p.target.kind==='AGENT'&&p.target.agentId===actor;
    await tx.query(`UPDATE attendance_sessions SET local_team_id=$3,local_agent_id=$4,state=$5,revision=revision+1,updated_at=now()
     WHERE organization_id=$1 AND id=$2`,[org,session.id,p.target.kind==='TEAM'?p.target.teamId:null,p.target.kind==='AGENT'?p.target.agentId:null,active?'HUMAN_ACTIVE':'WAITING_HUMAN']);
    await tx.query('UPDATE messaging_conversations SET attendance_revision=attendance_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2',[org,conversationId]);
    await audit(tx,org,actor,session.id,'LOCAL_ATTENDANCE_ASSIGNED','attendance_session');
    const row=(await tx.query(`SELECT ${queueColumns} FROM attendance_sessions s WHERE s.organization_id=$1 AND s.id=$2`,[org,session.id])).rows[0];
    return LocalQueueItemSchema.parse(row);
   });
  },
 };
}
