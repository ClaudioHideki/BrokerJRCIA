import {afterEach,expect,it,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {buildApp} from '../../src/app.js';
import {AttendanceError} from '../../src/modules/attendance/types.js';
const org='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',channel='33333333-3333-4333-8333-333333333333',teamId='44444444-4444-4444-8444-444444444444';
const secret='attendance-directory-synthetic-secret-32-bytes',apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
async function harness(){
 let role:'OWNER'|'OPERATOR'|'VIEWER'|null='OWNER';
 const team={id:teamId,name:'Team',status:'ACTIVE',revision:1,memberIds:[]};
 const row={conversationId:actor,sessionId:teamId,sessionRevision:1,cycle:1,state:'WAITING_HUMAN',target:{kind:'QUEUE'}};
 const directory={catalog:vi.fn().mockResolvedValue({scope:{kind:'LOCAL',organizationId:org,channelId:channel},agents:[],teams:[]}),listTeams:vi.fn().mockResolvedValue({agents:[],teams:[]}),createTeam:vi.fn().mockResolvedValue(team),updateTeam:vi.fn().mockResolvedValue(team),replaceMembers:vi.fn().mockResolvedValue(team),queue:vi.fn().mockResolvedValue({scope:{kind:'LOCAL',organizationId:org,channelId:channel},data:[row]}),assign:vi.fn().mockResolvedValue(row)};
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),attendanceLocal:{jwtSecret:secret,authenticateApiKey:async()=>({organizationId:org,apiKeyId:teamId,scopes:['*']}),resolveCurrentRole:async()=>role,service:{listChannels:vi.fn().mockResolvedValue([])},directory} as never});
 apps.push(app);return {app,directory,setRole:(v:typeof role)=>{role=v;},headers:{authorization:'Bearer '+await issueAccessToken({userId:actor,organizationId:org,role:'OWNER'},secret)}};
}
it('exposes authenticated metadata-only administration and catalog with no-store',async()=>{
 const h=await harness();
 const created=await h.app.inject({method:'POST',url:'/v1/attendance/local-teams',headers:h.headers,payload:{name:'Team'}});
 expect(created.statusCode).toBe(201);expect(created.headers['cache-control']).toBe('no-store');
 expect(h.directory.createTeam).toHaveBeenCalledWith(org,actor,{name:'Team'});
 expect((await h.app.inject({url:'/v1/attendance/local-teams',headers:h.headers})).statusCode).toBe(200);
 expect((await h.app.inject({url:`/v1/attendance/local-channels/${channel}/catalog`,headers:h.headers})).statusCode).toBe(200);
 expect(h.directory.catalog).toHaveBeenCalledWith(org,actor,channel);
 for(const [suffix,payload] of [['',{expectedRevision:1,name:'Team',status:'ARCHIVED'}],['/members',{expectedRevision:1,memberIds:[actor]}]] as const){
  expect((await h.app.inject({method:'PUT',url:`/v1/attendance/local-teams/${teamId}${suffix}`,headers:h.headers,payload})).statusCode).toBe(200);
 }
});
it('permits operator queue/claim routing while rejecting administration and forged actor fields',async()=>{
 const h=await harness();h.setRole('OPERATOR');
 expect((await h.app.inject({url:`/v1/attendance/local-channels/${channel}/queue`,headers:h.headers})).statusCode).toBe(200);
 const body={expectedSessionId:teamId,sessionRevision:1,target:{kind:'AGENT',agentId:actor}};
 expect((await h.app.inject({method:'POST',url:`/v1/attendance/local-conversations/${actor}/assignment`,headers:h.headers,payload:body})).statusCode).toBe(200);
 expect(h.directory.assign).toHaveBeenCalledWith(org,actor,actor,body);
 expect((await h.app.inject({url:'/v1/attendance/local-teams',headers:h.headers})).statusCode).toBe(403);
 expect((await h.app.inject({method:'POST',url:`/v1/attendance/local-conversations/${actor}/assignment`,headers:h.headers,payload:{...body,actorId:teamId}})).statusCode).toBe(400);
});
it('rejects api keys, viewers, revoked users and anonymous callers before dispatch',async()=>{
 const h=await harness(),url=`/v1/attendance/local-channels/${channel}/queue`;
 expect((await h.app.inject({url})).statusCode).toBe(401);
 expect((await h.app.inject({url,headers:{'x-jrc-api-key':'synthetic-key'}})).statusCode).toBe(403);
 for(const role of ['VIEWER',null] as const){h.setRole(role);expect((await h.app.inject({url,headers:h.headers})).statusCode).toBe(403);}
 expect(h.directory.queue).not.toHaveBeenCalled();
});
it('rejects numeric targets, duplicate members and untrusted organization query fields',async()=>{
 const h=await harness();
 expect((await h.app.inject({url:`/v1/attendance/local-channels/${channel}/catalog?organizationId=${teamId}`,headers:h.headers})).statusCode).toBe(400);
 expect((await h.app.inject({method:'PUT',url:`/v1/attendance/local-teams/${teamId}/members`,headers:h.headers,payload:{expectedRevision:1,memberIds:[actor,actor]}})).statusCode).toBe(400);
 expect((await h.app.inject({method:'POST',url:`/v1/attendance/local-conversations/${actor}/assignment`,headers:h.headers,payload:{expectedSessionId:teamId,sessionRevision:1,target:{kind:'AGENT',agentId:5}}})).statusCode).toBe(400);
 expect(h.directory.replaceMembers).not.toHaveBeenCalled();expect(h.directory.assign).not.toHaveBeenCalled();
});
it('reports a safe revision conflict and hides unexpected database detail',async()=>{
 const h=await harness(),url=`/v1/attendance/local-conversations/${actor}/assignment`,payload={expectedSessionId:teamId,sessionRevision:1,target:{kind:'QUEUE'}};
 h.directory.assign.mockRejectedValueOnce(new AttendanceError('ATTENDANCE_SESSION_CHANGED',409));
 const conflict=await h.app.inject({method:'POST',url,headers:h.headers,payload});
 expect(conflict.statusCode).toBe(409);expect(conflict.json()).toMatchObject({code:'ATTENDANCE_SESSION_CHANGED'});expect(conflict.headers['cache-control']).toBe('no-store');
 h.directory.assign.mockRejectedValueOnce(new Error('secret-db-diagnostic'));
 const failure=await h.app.inject({method:'POST',url,headers:h.headers,payload});
 expect(failure.statusCode).toBe(500);expect(failure.body).not.toContain('secret-db-diagnostic');
});
