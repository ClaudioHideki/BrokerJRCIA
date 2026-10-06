import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
async function fixture(){
 const t=await seedAttendanceTenant(db.database,false);
 const actor=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0].user_id as string;
 const operator=randomUUID(),viewer=randomUUID();
 for(const [id,role] of [[operator,'OPERATOR'],[viewer,'VIEWER']]){
  await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",[id,`${id}@example.test`]);
  await db.database.pool.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)',[t.org,id,role]);
 }
 return {...t,actor,operator,viewer};
}
async function service(){
 const path='../../src/modules/attendance/local-directory-service.js',mod=await import(path).catch(()=>null);
 expect(mod?.createLocalAttendanceDirectoryService,'local administration factory').toBeTypeOf('function');
 return mod!.createLocalAttendanceDirectoryService({transact:db.transact});
}
async function waiting(t:Awaited<ReturnType<typeof fixture>>){
 await db.database.pool.query("UPDATE messaging_conversations SET mode='HUMAN' WHERE organization_id=$1 AND id=$2",[t.org,t.conversation]);
 await db.database.pool.query(`INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision)
   VALUES($1,$2,$3,1,'WAITING_HUMAN',0)`,[t.org,t.channel,t.conversation]);
}
it('administers teams using current members, revisions and tenant-scoped audit',async()=>{
 const t=await fixture(),s=await service();
 const team=await s.createTeam(t.org,t.actor,{name:'Support'});
 expect(team).toMatchObject({name:'Support',status:'ACTIVE',revision:1,memberIds:[]});
 expect(await s.replaceMembers(t.org,t.actor,team.id,{expectedRevision:1,memberIds:[t.operator]})).toMatchObject({revision:2,memberIds:[t.operator]});
 await expect(s.replaceMembers(t.org,t.actor,team.id,{expectedRevision:1,memberIds:[]})).rejects.toThrow('LOCAL_TEAM_REVISION_CHANGED');
 await expect(s.replaceMembers(t.org,t.actor,team.id,{expectedRevision:2,memberIds:[t.viewer]})).rejects.toThrow('LOCAL_AGENT_UNAVAILABLE');
 const renamed=await s.updateTeam(t.org,t.actor,team.id,{expectedRevision:2,name:'Service',status:'ACTIVE'});
 expect(renamed).toMatchObject({name:'Service',revision:3,memberIds:[t.operator]});
 expect(await s.catalog(t.org,t.actor,t.channel)).toMatchObject({teams:[{id:team.id,revision:3}]});
 expect(await s.updateTeam(t.org,t.actor,team.id,{expectedRevision:3,name:'Service',status:'ARCHIVED'})).toMatchObject({revision:4,status:'ARCHIVED'});
 expect(await s.catalog(t.org,t.actor,t.channel)).toMatchObject({teams:[]});
 const audits=(await db.database.pool.query("SELECT metadata FROM audit_logs WHERE organization_id=$1 AND resource_type='attendance_team'",[t.org])).rows;
 expect(audits).toHaveLength(4);expect(JSON.stringify(audits)).not.toContain('@example.test');
});
it('rejects foreign teams, current viewers/revoked actors and ineligible targets without mutation',async()=>{
 const t=await fixture(),other=await fixture(),s=await service(),team=await s.createTeam(other.org,other.actor,{name:'Other'});
 await expect(s.updateTeam(t.org,t.actor,team.id,{expectedRevision:1,name:'Bad',status:'ACTIVE'})).rejects.toThrow('LOCAL_TEAM_NOT_FOUND');
 await expect(s.createTeam(t.org,t.operator,{name:'Bad'})).rejects.toThrow('FORBIDDEN');
 await expect(s.listTeams(t.org,t.viewer)).rejects.toThrow('FORBIDDEN');
 await db.database.pool.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2",[t.org,t.operator]);
 await expect(s.queue(t.org,t.operator,t.channel)).rejects.toThrow('FORBIDDEN');
 const own=await s.createTeam(t.org,t.actor,{name:'Own'});
 await expect(s.replaceMembers(t.org,t.actor,own.id,{expectedRevision:1,memberIds:[other.operator]})).rejects.toThrow('LOCAL_AGENT_UNAVAILABLE');
 expect(await s.listTeams(t.org,t.actor)).toMatchObject({teams:[{id:own.id,revision:1,memberIds:[]}]});
});
it('allows self-claim, reassigns manually and rejects stale sessions without resuming the bot',async()=>{
 const t=await fixture(),s=await service();await waiting(t);
 const sessionId=(await s.queue(t.org,t.actor,t.channel)).data[0].sessionId;
 expect(await s.queue(t.org,t.operator,t.channel)).toMatchObject({data:[{conversationId:t.conversation,sessionRevision:1,state:'WAITING_HUMAN',target:{kind:'QUEUE'}}]});
 const claimed=await s.assign(t.org,t.operator,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'AGENT',agentId:t.operator}});
 expect(claimed).toMatchObject({sessionId,sessionRevision:2,state:'HUMAN_ACTIVE',target:{kind:'AGENT',agentId:t.operator}});
 await expect(s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'QUEUE'}})).rejects.toThrow('ATTENDANCE_SESSION_CHANGED');
 expect(await s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:2,target:{kind:'AGENT',agentId:t.actor}})).toMatchObject({sessionId,sessionRevision:3,state:'HUMAN_ACTIVE'});
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[t.org,t.conversation])).rows).toEqual([{mode:'HUMAN'}]);
});
it('an operator cannot assign another identity, a team or the general queue',async()=>{
 const t=await fixture(),s=await service();await waiting(t);
 const sessionId=(await s.queue(t.org,t.actor,t.channel)).data[0].sessionId;
 for(const target of [{kind:'QUEUE'},{kind:'AGENT',agentId:t.actor},{kind:'TEAM',teamId:randomUUID()}])
  await expect(s.assign(t.org,t.operator,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target})).rejects.toThrow('FORBIDDEN');
 await expect(s.assign(t.org,t.viewer,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'AGENT',agentId:t.viewer}})).rejects.toThrow('FORBIDDEN');
});
it('does not invent sessions, cross tenant conversations or bypass a pending resume',async()=>{
 const t=await fixture(),other=await fixture(),s=await service();
 let sessionId=randomUUID();
 await expect(s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'QUEUE'}})).rejects.toThrow('ATTENDANCE_LOCAL_SESSION_REQUIRED');
 await expect(s.assign(t.org,t.actor,other.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'QUEUE'}})).rejects.toThrow('CONVERSATION_NOT_FOUND');
 await waiting(t);
 sessionId=(await s.queue(t.org,t.actor,t.channel)).data[0].sessionId;
 await db.database.pool.query(`INSERT INTO attendance_resume_operations(organization_id,channel_id,conversation_id,actor_id,idempotency_key,request_hash,snapshot)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[t.org,t.channel,t.conversation,t.actor,randomUUID(),'a'.repeat(64),JSON.stringify({channelId:t.channel,conversationId:t.conversation})]);
 await expect(s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'QUEUE'}})).rejects.toThrow('ATTENDANCE_RESUME_IN_PROGRESS');
 expect(await s.queue(t.org,t.actor,t.channel)).toMatchObject({data:[{sessionId,sessionRevision:1}]});
});
it('validates target availability at assignment and never routes a configured central to local',async()=>{
 const t=await fixture(),s=await service(),team=await s.createTeam(t.org,t.actor,{name:'Team'});await waiting(t);
 const sessionId=(await s.queue(t.org,t.actor,t.channel)).data[0].sessionId;
 await s.replaceMembers(t.org,t.actor,team.id,{expectedRevision:1,memberIds:[t.operator]});
 expect(await s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'TEAM',teamId:team.id}})).toMatchObject({sessionId,sessionRevision:2,state:'WAITING_HUMAN',target:{kind:'TEAM',teamId:team.id}});
 await db.database.pool.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2",[t.org,t.operator]);
 await expect(s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:2,target:{kind:'TEAM',teamId:team.id}})).rejects.toThrow('LOCAL_TEAM_EMPTY');
 await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,$2,1,'READY')",[t.org,`https://${t.org}.example.test`]);
 await db.database.pool.query("INSERT INTO chatwoot_connections(organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,1,'Central','DISABLED')",[t.org,t.channel]);
 await expect(s.queue(t.org,t.actor,t.channel)).rejects.toThrow('ATTENDANCE_CENTRAL_CONFIGURED');
 await expect(s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:2,target:{kind:'QUEUE'}})).rejects.toThrow('ATTENDANCE_CENTRAL_CONFIGURED');
});
it('serializes two manual claims so only the expected revision is applied',async()=>{
 const t=await fixture(),s=await service();await waiting(t);
 const sessionId=(await s.queue(t.org,t.actor,t.channel)).data[0].sessionId;
 const results=await Promise.allSettled([s.assign(t.org,t.actor,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'AGENT',agentId:t.actor}}),s.assign(t.org,t.operator,t.conversation,{expectedSessionId:sessionId,sessionRevision:1,target:{kind:'AGENT',agentId:t.operator}})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'ATTENDANCE_SESSION_CHANGED'}});
 expect(await s.queue(t.org,t.actor,t.channel)).toMatchObject({data:[{sessionId,sessionRevision:2,state:'HUMAN_ACTIVE'}]});
});
it('rejects a stale claim when a new human cycle has reused the same revision',async()=>{
 const t=await fixture(),s=await service();await waiting(t);
 const old=(await s.queue(t.org,t.actor,t.channel)).data[0];
 await db.database.pool.query("UPDATE attendance_sessions SET state='RESOLVED' WHERE organization_id=$1 AND conversation_id=$2",[t.org,t.conversation]);
 await db.database.pool.query(`INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision)
  VALUES($1,$2,$3,2,'WAITING_HUMAN',0)`,[t.org,t.channel,t.conversation]);
 await expect(s.assign(t.org,t.actor,t.conversation,{expectedSessionId:old.sessionId,sessionRevision:old.sessionRevision,target:{kind:'AGENT',agentId:t.actor}})).rejects.toThrow('ATTENDANCE_SESSION_CHANGED');
 expect(await s.queue(t.org,t.actor,t.channel)).toMatchObject({data:[{cycle:2,sessionRevision:1,target:{kind:'QUEUE'}}]});
});
