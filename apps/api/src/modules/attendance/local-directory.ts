import {LocalAttendanceDirectorySchema,LocalHumanTargetSchema,type LocalAttendanceScopeV2} from '@jrc/contracts';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import {assertStandaloneDestination} from './destination-adapter.js';
import {AttendanceError} from './types.js';

const DIRECTORY_LIMIT=1000;
type LocalAgent={id:string;email:string;role:'OWNER'|'ADMIN'|'OPERATOR'};

/** The current-user projection is deliberately narrower than SELECT on users. */
export function createLocalAttendanceDirectory(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}){
 return {catalog:(org:string,channelId:string)=>options.transact(org,async tx=>{
  const scope=await assertStandaloneDestination(tx,org,channelId);
  const agents=(await tx.query<LocalAgent>('SELECT user_id AS id,email,role FROM current_local_attendance_members()')).rows;
  if(agents.length>DIRECTORY_LIMIT)throw new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409);
  const teams=(await tx.query<{id:string;name:string;revision:number;memberIds:string[]}>(`SELECT t.id,t.name,t.revision,
    array_agg(m.user_id ORDER BY m.user_id) AS "memberIds"
    FROM local_attendance_teams t JOIN local_attendance_team_members m
      ON m.organization_id=t.organization_id AND m.team_id=t.id AND m.user_id=ANY($2::uuid[])
    WHERE t.organization_id=$1 AND t.status='ACTIVE'
    GROUP BY t.organization_id,t.id ORDER BY t.id LIMIT 1001`,[org,agents.map(a=>a.id)])).rows;
  if(teams.length>DIRECTORY_LIMIT)throw new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409);
  return LocalAttendanceDirectorySchema.parse({scope,agents,teams});
 })};
}

/** Locks eligibility until the caller commits publication, binding or assignment.
 * QUEUE does not imply that a person is available or has accepted a conversation. */
export async function assertLocalHumanTarget(tx:TenantTransaction,org:string,channelId:string,input:unknown):Promise<LocalAttendanceScopeV2>{
 const target=LocalHumanTargetSchema.parse(input),scope=await assertStandaloneDestination(tx,org,channelId);
 if(target.kind==='QUEUE')return scope;
 const eligible=async(user:string)=>(await tx.query('SELECT user_id FROM lock_local_attendance_member($1)',[user])).rowCount===1;
 if(target.kind==='AGENT'){
  if(!await eligible(target.agentId))throw new AttendanceError('LOCAL_AGENT_UNAVAILABLE',409);
  return scope;
 }
 const team=(await tx.query("SELECT id FROM local_attendance_teams WHERE organization_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE",[org,target.teamId])).rowCount;
 if(!team)throw new AttendanceError('LOCAL_TEAM_UNAVAILABLE',409);
 const members=(await tx.query<{user_id:string}>(`SELECT user_id FROM local_attendance_team_members
   WHERE organization_id=$1 AND team_id=$2 ORDER BY user_id LIMIT 1001 FOR SHARE`,[org,target.teamId])).rows;
 if(members.length>DIRECTORY_LIMIT)throw new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409);
 for(const member of members)if(await eligible(member.user_id))return scope;
 throw new AttendanceError('LOCAL_TEAM_EMPTY',409);
}
