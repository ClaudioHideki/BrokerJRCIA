import {afterEach,expect,it,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {buildApp} from '../../src/app.js';
import type {createQrMessagingService} from '../../src/modules/messaging/qr-service.js';
const org='11111111-1111-4111-8111-111111111111',instance='22222222-2222-4222-8222-222222222222',channel='33333333-3333-4333-8333-333333333333',secret='synthetic-partner-activation-jwt-secret-32-bytes';
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
function harness(scopes=['instances:write','messaging:send']){
 let active=true;
 const activate=vi.fn(async()=>({id:channel,provider:'BAILEYS' as const,ownerRevision:0,botPublicId:null}));
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),integrations:{jwtSecret:secret,authenticateApiKey:async raw=>active&&raw==='synthetic-key'?{apiKeyId:channel,organizationId:org,scopes}:null,resolveCurrentRole:async()=> 'OWNER',qr:{activate} as unknown as ReturnType<typeof createQrMessagingService>}});
 apps.push(app);return {app,activate,revoke(){active=false;}};
}
const url=`/v1/messaging/instances/${instance}/partner-activate`,headers={'x-jrc-api-key':'synthetic-key','idempotency-key':'partner-activation'};
it('activates the tenant instance without a remote platform service and preserves canonical replay identity',async()=>{
 const h=harness();const first=await h.app.inject({method:'POST',url,headers,payload:{}}),second=await h.app.inject({method:'POST',url,headers,payload:{}});
 expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({id:channel,instanceId:instance,provider:'BAILEYS'});expect(second.json()).toEqual(first.json());expect(h.activate).toHaveBeenCalledWith(org,instance);
 h.revoke();expect((await h.app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(401);expect(h.activate).toHaveBeenCalledTimes(2);
});
it.each([{scopes:['instances:write']},{scopes:['messaging:send']},{scopes:['instances:read']},{scopes:[]}])('requires both explicit activation scopes %j',async({scopes})=>{
 const h=harness(scopes);expect((await h.app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(403);expect(h.activate).not.toHaveBeenCalled();
});
it('rejects JWT, absent idempotency, and forged tenant, while keeping the original JWT route protected',async()=>{
 const h=harness();const token=await issueAccessToken({userId:channel,organizationId:org,role:'OWNER'},secret);
 expect((await h.app.inject({method:'POST',url,headers:{authorization:`Bearer ${token}`,'idempotency-key':'jwt-not-admitted'},payload:{}})).statusCode).toBe(403);
 expect((await h.app.inject({method:'POST',url,headers:{'x-jrc-api-key':'synthetic-key'},payload:{}})).statusCode).toBe(400);
 expect((await h.app.inject({method:'POST',url,headers,payload:{organizationId:org}})).statusCode).toBe(400);
 expect((await h.app.inject({method:'POST',url:url+'?organizationId='+org,headers,payload:{}})).statusCode).toBe(400);
 expect((await h.app.inject({method:'POST',url:`/v1/messaging/instances/${instance}/activate`,headers,payload:{}})).statusCode).toBe(403);
 expect(h.activate).not.toHaveBeenCalled();
});
