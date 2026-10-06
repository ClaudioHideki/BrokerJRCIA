import { afterEach,expect,it,vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import { AttendanceError } from '../../src/modules/attendance/types.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',secret='local-attendance-test-at-least-32-bytes';
const apps:ReturnType<typeof buildApp>[]=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
async function harness(){
 let role:'OWNER'|'VIEWER'|null='OWNER';
 const data=[{scope:{kind:'LOCAL',organizationId:org,channelId:id},name:'Synthetic inbox'}],listChannels=vi.fn().mockResolvedValue(data);
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),
 attendanceLocal:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service:{listChannels}}});
 apps.push(app);
 return {app,data,listChannels,setRole:(v:typeof role)=>{role=v;},headers:{authorization:'Bearer '+await issueAccessToken({userId:id,organizationId:org,role:'OWNER'},secret)}};
}
it('returns only the authenticated tenant catalog with no-store',async()=>{
 const h=await harness(),result=await h.app.inject({url:'/v1/attendance/local-channels',headers:h.headers});
 expect(result.statusCode).toBe(200);expect(result.json()).toEqual({data:h.data});expect(result.headers['cache-control']).toBe('no-store');
 expect(h.listChannels).toHaveBeenCalledWith(org);
 expect((await h.app.inject({url:'/v1/attendance/local-channels?organizationId='+id,headers:h.headers})).statusCode).toBe(400);
});
it('rejects anonymous, viewer and revoked membership before reading the catalog',async()=>{
 const h=await harness();expect((await h.app.inject({url:'/v1/attendance/local-channels'})).statusCode).toBe(401);
 h.setRole('VIEWER');expect((await h.app.inject({url:'/v1/attendance/local-channels',headers:h.headers})).statusCode).toBe(403);
 h.setRole(null);expect((await h.app.inject({url:'/v1/attendance/local-channels',headers:h.headers})).statusCode).toBe(403);
 expect(h.listChannels).not.toHaveBeenCalled();
});
it('reports safe catalog conflicts without leaking database errors',async()=>{
 const h=await harness();h.listChannels.mockRejectedValueOnce(new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409));
 expect((await h.app.inject({url:'/v1/attendance/local-channels',headers:h.headers})).json()).toMatchObject({status:409,code:'ATTENDANCE_CATALOG_TOO_LARGE'});
 h.listChannels.mockRejectedValueOnce(new Error('secret diagnostic detail'));
 const result=await h.app.inject({url:'/v1/attendance/local-channels',headers:h.headers});
 expect(result.statusCode).toBe(500);expect(result.body).not.toContain('secret diagnostic detail');
});
