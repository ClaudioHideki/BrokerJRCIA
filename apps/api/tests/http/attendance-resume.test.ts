import { afterEach,expect,it,vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import { AttendanceError } from '../../src/modules/attendance/types.js';
import type { createAttendanceResumeService } from '../../src/modules/attendance/resume-service.js';
const org='4f2491a2-6853-4ac2-a7ef-c997813a9182',id='81555d45-b1a2-4a3f-ab95-c1459b0df0d0',secret='resume-test-secret-at-least-32-bytes';
const apps:ReturnType<typeof buildApp>[]=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function harness(){
  let role:'OWNER'|'VIEWER'|null='OWNER';
  const operation={id,conversationId:id,state:'PENDING',sessionId:null,errorCode:null};
  const requestAttendanceResume=vi.fn().mockResolvedValue(operation),getOperation=vi.fn().mockResolvedValue(operation);
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),
    attendanceResume:{service:{requestAttendanceResume,getOperation} as unknown as ReturnType<typeof createAttendanceResumeService>,
      jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role}});
  apps.push(app);return {app,operation,requestAttendanceResume,getOperation,setRole:(value:typeof role)=>{role=value;},
    headers:{authorization:'Bearer '+await issueAccessToken({userId:id,organizationId:org,role:'OWNER'},secret),'idempotency-key':'resume-test'}};
}
const body={expectedControlRevision:8,expectedOwnerRevision:1,target:{kind:'NEW_SESSION'}};
it('reserves with authenticated identity, explicit revisions and mandatory idempotency',async()=>{
  const h=await harness(),url=`/v1/attendance/conversations/${id}/resume`;
  const result=await h.app.inject({method:'POST',url,headers:h.headers,payload:body});
  expect(result.statusCode).toBe(202);expect(result.json()).toEqual(h.operation);expect(result.headers['cache-control']).toBe('no-store');
  expect(h.requestAttendanceResume).toHaveBeenCalledWith(org,id,'resume-test',{...body,conversationId:id});
  expect((await h.app.inject({method:'POST',url,headers:{authorization:h.headers.authorization},payload:body})).statusCode).toBe(400);
  expect((await h.app.inject({method:'POST',url,headers:h.headers,payload:{...body,organizationId:org}})).statusCode).toBe(400);
});
it('rejects anonymous, viewer and revoked roles before calling the service',async()=>{
  const h=await harness(),url=`/v1/attendance/conversations/${id}/resume`;
  expect((await h.app.inject({method:'POST',url,payload:body})).statusCode).toBe(401);
  h.setRole('VIEWER');expect((await h.app.inject({method:'POST',url,headers:h.headers,payload:body})).statusCode).toBe(403);
  h.setRole(null);expect((await h.app.inject({url:`/v1/attendance/resume-operations/${id}`,headers:h.headers})).statusCode).toBe(403);
  expect(h.requestAttendanceResume).not.toHaveBeenCalled();expect(h.getOperation).not.toHaveBeenCalled();
});
it('exposes safe conflicts and preserves cross-tenant not-found responses',async()=>{
  const h=await harness();h.requestAttendanceResume.mockRejectedValueOnce(new AttendanceError('ATTENDANCE_OWNER_CHANGED',409));
  expect((await h.app.inject({method:'POST',url:`/v1/attendance/conversations/${id}/resume`,headers:h.headers,payload:body})).json()).toMatchObject({status:409,code:'ATTENDANCE_OWNER_CHANGED'});
  h.getOperation.mockRejectedValueOnce(new AttendanceError('ATTENDANCE_RESUME_NOT_FOUND',404));
  expect((await h.app.inject({url:`/v1/attendance/resume-operations/${id}`,headers:h.headers})).statusCode).toBe(404);
});
