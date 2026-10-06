import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {removeMembership} from '../../src/modules/memberships/repository.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
async function fixture(){
 const t=await seedAttendanceTenant(db.database,false);
 const user=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0].user_id as string;
 return {...t,user};
}
async function directory(){
 const modulePath='../../src/modules/attendance/local-directory.js';
 const service=await import(modulePath).catch(()=>null);
 expect(service?.createLocalAttendanceDirectory,'local directory factory').toBeTypeOf('function');
 return service!;
}
it('installs a tenant-bound directory without granting direct user-table access',async()=>{
 const t=await fixture();
 const facts=(await db.transact(t.org,tx=>tx.query(`SELECT to_regclass('public.local_attendance_teams')::text AS teams,
  to_regclass('public.local_attendance_team_members')::text AS members,
  to_regprocedure('public.current_local_attendance_members()')::text AS directory,
  has_table_privilege('jrc_app','public.users','SELECT') AS direct_users`))).rows[0];
 expect(facts).toMatchObject({teams:'local_attendance_teams',members:'local_attendance_team_members',directory:'current_local_attendance_members()',direct_users:false});
});
it('projects only active eligible identities of the current tenant',async()=>{
 const t=await fixture(),other=await fixture();
 const operator=randomUUID(),viewer=randomUUID(),disabled=randomUUID();
 for(const [id,role,status] of [[operator,'OPERATOR','ACTIVE'],[viewer,'VIEWER','ACTIVE'],[disabled,'ADMIN','DISABLED']]){
  await db.database.pool.query("INSERT INTO users(id,email,password_hash,status) VALUES($1,$2,'test-only',$3)",[id,`${id}@example.test`,status]);
  await db.database.pool.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)',[t.org,id,role]);
 }
 const members=(await db.transact(t.org,tx=>tx.query('SELECT * FROM current_local_attendance_members()'))).rows;
 expect(members.map(m=>m.user_id).sort()).toEqual([t.user,operator].sort());
 expect(members.every(m=>Object.keys(m).sort().join(',')==='email,role,user_id')).toBe(true);
 expect(members.some(m=>m.user_id===other.user)).toBe(false);
 await db.database.pool.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2",[t.org,operator]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM current_local_attendance_members()'))).rows.map(m=>m.user_id)).toEqual([t.user]);
});
it('does not lock or return a foreign, revoked or read-only target',async()=>{
 const t=await fixture(),other=await fixture(),target=randomUUID();
 await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",[target,`${target}@example.test`]);
 await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN')",[t.org,target]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM lock_local_attendance_member($1)',[other.user]))).rows).toEqual([]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM lock_local_attendance_member($1)',[target]))).rows).toHaveLength(1);
 await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,target]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM lock_local_attendance_member($1)',[target]))).rows).toEqual([]);
 await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[t.org]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM current_local_attendance_members()'))).rows).toEqual([]);
});
it('forces tenant isolation and rejects a team-member association from another company',async()=>{
 const t=await fixture(),other=await fixture(),team=randomUUID();
 await db.transact(t.org,tx=>tx.query('INSERT INTO local_attendance_teams(organization_id,id,name) VALUES($1,$2,$3)',[t.org,team,'Local test team']));
 expect((await db.transact(other.org,tx=>tx.query('SELECT id FROM local_attendance_teams'))).rows).toEqual([]);
 await expect(db.transact(t.org,tx=>tx.query('INSERT INTO local_attendance_team_members(organization_id,team_id,user_id) VALUES($1,$2,$3)',[t.org,team,other.user]))).rejects.toMatchObject({code:'23503'});
 await expect(db.transact(t.org,tx=>tx.query('INSERT INTO local_attendance_teams(organization_id,name) VALUES($1,$2)',[other.org,'Forbidden']))).rejects.toMatchObject({code:'42501'});
});
it('lists eligible teams for the selected local channel and excludes empty or archived teams',async()=>{
 const t=await fixture(),other=await fixture(),team=randomUUID(),empty=randomUUID(),archived=randomUUID();
 for(const [id,name,status] of [[team,'Attendants','ACTIVE'],[empty,'Empty','ACTIVE'],[archived,'Old','ARCHIVED']])await db.database.pool.query('INSERT INTO local_attendance_teams(organization_id,id,name,status) VALUES($1,$2,$3,$4)',[t.org,id,name,status]);
 for(const id of [team,archived])await db.database.pool.query('INSERT INTO local_attendance_team_members(organization_id,team_id,user_id) VALUES($1,$2,$3)',[t.org,id,t.user]);
 const {createLocalAttendanceDirectory}=await directory(),service=createLocalAttendanceDirectory({transact:db.transact});
 const result=await service.catalog(t.org,t.channel);
 expect(result).toEqual({scope:{kind:'LOCAL',organizationId:t.org,channelId:t.channel},agents:[{id:t.user,email:`${t.user}@example.test`,role:'OWNER'}],teams:[{id:team,name:'Attendants',revision:1,memberIds:[t.user]}]});
 await expect(service.catalog(t.org,other.channel)).rejects.toThrow('CHANNEL_NOT_FOUND');
 await db.database.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1",[t.user]);
 expect(await service.catalog(t.org,t.channel)).toMatchObject({agents:[],teams:[]});
});
it('revalidates local agent and team targets against current eligibility and channel authority',async()=>{
 const t=await fixture(),other=await fixture(),team=randomUUID();
 await db.database.pool.query('INSERT INTO local_attendance_teams(organization_id,id,name) VALUES($1,$2,$3)',[t.org,team,'Attendants']);
 await db.database.pool.query('INSERT INTO local_attendance_team_members(organization_id,team_id,user_id) VALUES($1,$2,$3)',[t.org,team,t.user]);
 const {assertLocalHumanTarget}=await directory();
 const check=(target:unknown)=>db.transact(t.org,tx=>assertLocalHumanTarget(tx,t.org,t.channel,target));
 const expected={kind:'LOCAL',organizationId:t.org,channelId:t.channel};
 expect(await check({kind:'QUEUE'})).toEqual(expected);
 expect(await check({kind:'TEAM',teamId:team})).toEqual(expected);
 expect(await check({kind:'AGENT',agentId:t.user})).toEqual(expected);
 await expect(check({kind:'AGENT',agentId:other.user})).rejects.toThrow('LOCAL_AGENT_UNAVAILABLE');
 await db.database.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1",[t.user]);
 await expect(check({kind:'AGENT',agentId:t.user})).rejects.toThrow('LOCAL_AGENT_UNAVAILABLE');
 await expect(check({kind:'TEAM',teamId:team})).rejects.toThrow('LOCAL_TEAM_EMPTY');
 await db.database.pool.query("UPDATE local_attendance_teams SET status='ARCHIVED' WHERE id=$1",[team]);
 await expect(check({kind:'TEAM',teamId:team})).rejects.toThrow('LOCAL_TEAM_UNAVAILABLE');
 await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,$2,1,'READY')",[t.org,`https://${t.org}.example.test`]);
 await db.database.pool.query("INSERT INTO chatwoot_connections(organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,1,'Central','DISABLED')",[t.org,t.channel]);
 await expect(check({kind:'QUEUE'})).rejects.toThrow('ATTENDANCE_CENTRAL_CONFIGURED');
});
it('serializes a validated member against concurrent revocation until the caller commits',async()=>{
 const t=await fixture(),target=randomUUID();
 await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",[target,`${target}@example.test`]);
 await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OPERATOR')",[t.org,target]);
 const left=await db.database.pool.connect(),right=await db.database.pool.connect();
 let pending:Promise<unknown>|undefined;
 try{
  const leftPid=(await left.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const rightPid=(await right.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await left.query('BEGIN');await left.query('SET LOCAL ROLE jrc_app');
  await left.query("SELECT set_config('app.organization_id',$1,true)",[t.org]);
  expect((await left.query('SELECT * FROM lock_local_attendance_member($1)',[target])).rowCount).toBe(1);
  pending=right.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2",[t.org,target]);
  await vi.waitFor(async()=>{expect((await db.database.pool.query('SELECT pg_blocking_pids($1) AS blockers',[rightPid])).rows[0].blockers).toContain(leftPid);},{timeout:5000,interval:25});
  await left.query('COMMIT');await pending;
  expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM lock_local_attendance_member($1)',[target]))).rows).toEqual([]);
 }finally{await left.query('ROLLBACK');await pending?.catch(()=>{});left.release();right.release();}
});
it('rejects catalog overflow instead of returning a silently truncated list',async()=>{
 const t=await fixture();
 await db.database.pool.query('UPDATE organization_limits SET max_users=1002 WHERE organization_id=$1',[t.org]);
 await db.database.pool.query(`WITH new_users AS(
  INSERT INTO users(email,password_hash) SELECT gen_random_uuid()::text||'@example.test','test-only' FROM generate_series(1,1000) RETURNING id)
  INSERT INTO memberships(organization_id,user_id,role) SELECT $1,id,'OPERATOR' FROM new_users`,[t.org]);
 const {createLocalAttendanceDirectory}=await directory();
 await expect(createLocalAttendanceDirectory({transact:db.transact}).catalog(t.org,t.channel)).rejects.toThrow('ATTENDANCE_CATALOG_TOO_LARGE');
});
it.each(['TEAM','LIVE_SESSION','HISTORY'] as const)('revokes a referenced member through REMOVE and preserves %s',async reference=>{
 const t=await fixture(),target=randomUUID(),team=randomUUID();
 await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",[target,`${target}@example.test`]);
 await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OPERATOR')",[t.org,target]);
 if(reference==='TEAM'){
  await db.database.pool.query('INSERT INTO local_attendance_teams(organization_id,id,name) VALUES($1,$2,$3)',[t.org,team,'Preserved team']);
  await db.database.pool.query('INSERT INTO local_attendance_team_members(organization_id,team_id,user_id) VALUES($1,$2,$3)',[t.org,team,target]);
 }else{
  await db.database.pool.query(`INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision,local_agent_id)
    VALUES($1,$2,$3,1,$4,0,$5)`,[t.org,t.channel,t.conversation,reference==='HISTORY'?'RESOLVED':'HUMAN_ACTIVE',target]);
 }
 await db.transact(t.org,tx=>removeMembership(tx,{organizationId:t.org,userId:target}));
 expect((await db.database.pool.query('SELECT status FROM memberships WHERE organization_id=$1 AND user_id=$2',[t.org,target])).rows).toEqual([{status:'DISABLED'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT * FROM lock_local_attendance_member($1)',[target]))).rows).toEqual([]);
 const {createLocalAttendanceDirectory}=await directory();
 expect(await createLocalAttendanceDirectory({transact:db.transact}).catalog(t.org,t.channel)).toMatchObject({agents:[{id:t.user}],teams:[]});
 if(reference==='TEAM')expect((await db.database.pool.query('SELECT user_id FROM local_attendance_team_members WHERE organization_id=$1 AND team_id=$2',[t.org,team])).rows).toEqual([{user_id:target}]);
 else expect((await db.database.pool.query('SELECT local_agent_id,state,revision FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$2',[t.org,t.conversation])).rows).toEqual([{local_agent_id:target,state:reference==='HISTORY'?'RESOLVED':'HUMAN_ACTIVE',revision:1}]);
});
it('continues physically removing a member with no attendance references',async()=>{
 const t=await fixture(),target=randomUUID();
 await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",[target,`${target}@example.test`]);
 await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OPERATOR')",[t.org,target]);
 await db.transact(t.org,tx=>removeMembership(tx,{organizationId:t.org,userId:target}));
 expect((await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=$2',[t.org,target])).rows).toEqual([]);
});
