import {describe,it,expect,afterEach,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {buildApp} from '../../src/app.js';
import type {AutomationService,createExecutionService} from '../../src/modules/automations/service.js';
import type {CredentialService} from '../../src/modules/automation-integrations/credentials.js';
const secret='http-query-test-secret-with-at-least-32-bytes',org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
describe('HTTP query catalog and policy route authorization',()=>{
 const apps:Array<ReturnType<typeof buildApp>>=[];afterEach(async()=>Promise.all(apps.splice(0).map(app=>app.close())));
 it('derives catalog scope from current membership and rejects invented tenant or cursor parameters',async()=>{
  let role:'OWNER'|'VIEWER'|null='OWNER';const catalog=vi.fn().mockResolvedValue({schemaVersion:1,scope:{organizationId:org,rootAutomationId:id},data:[],nextCursor:null});
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service:{httpCredentialCatalog:catalog} as unknown as AutomationService,executions:{} as ReturnType<typeof createExecutionService>}});apps.push(app);
  const headers={authorization:`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`};
  const response=await app.inject({method:'GET',url:`/v1/automations/${id}/http-credentials?pageSize=25`,headers});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(catalog).toHaveBeenCalledWith(org,id,{pageSize:25});
  for(const query of ['organizationId='+user,'pageSize=201','cursor=','extra=true'])expect((await app.inject({method:'GET',url:`/v1/automations/${id}/http-credentials?${query}`,headers})).statusCode).toBe(400);
  role=null;expect((await app.inject({method:'GET',url:`/v1/automations/${id}/http-credentials`,headers})).statusCode).toBe(403);expect(catalog).toHaveBeenCalledTimes(1);
 });
 it('requires a current administrator and optimistic revision for metadata-only policy updates',async()=>{
  let role:'OWNER'|'VIEWER'|null='OWNER';const update=vi.fn().mockResolvedValue({revision:4});
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),credentials:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service:{updateHttpPolicy:update} as unknown as CredentialService}});apps.push(app);
  const headers={authorization:`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`},body={revision:3,allowedOrigins:['https://api.example.test']};
  expect((await app.inject({method:'PUT',url:`/v1/credentials/${id}/http-policy`,headers,payload:body})).statusCode).toBe(200);expect(update).toHaveBeenCalledWith(org,id,body);
  for(const payload of [{...body,secret:{token:'inline'}},{...body,organizationId:user},{...body,revision:0},{...body,allowedOrigins:['http://localhost']}])expect((await app.inject({method:'PUT',url:`/v1/credentials/${id}/http-policy`,headers,payload})).statusCode).toBe(400);
  role='VIEWER';expect((await app.inject({method:'PUT',url:`/v1/credentials/${id}/http-policy`,headers,payload:body})).statusCode).toBe(403);expect(update).toHaveBeenCalledTimes(1);
 });
});
