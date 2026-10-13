import {afterEach,describe,expect,it} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {buildApp} from '../../src/app.js';
import type {AutomationService,createExecutionService} from '../../src/modules/automations/service.js';

const secret='subflow-catalog-routes-secret-at-least-32-bytes';
const org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
describe('subflow catalog HTTP boundary',()=>{
 const apps:Array<ReturnType<typeof buildApp>>=[];afterEach(async()=>Promise.all(apps.splice(0).map(app=>app.close())));
 it('derives tenant and root from the authenticated request and rejects invented scope',async()=>{
  let role:'OWNER'|'VIEWER'|null='OWNER';const calls:unknown[]=[];
  const service={subflowCatalog:async(organizationId:string,rootId:string,input:unknown)=>{calls.push({organizationId,rootId,input});return {schemaVersion:1,scope:{organizationId,rootAutomationId:rootId},data:[],nextCursor:null};}} as unknown as AutomationService;
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service,executions:{} as ReturnType<typeof createExecutionService>}});apps.push(app);
  const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
  const valid=await app.inject({method:'GET',url:`/v1/automations/${id}/subflow-catalog?pageSize=25`,headers:{authorization}});
  expect(valid.statusCode).toBe(200);expect(valid.json()).toEqual({schemaVersion:1,scope:{organizationId:org,rootAutomationId:id},data:[],nextCursor:null});
  expect(calls).toEqual([{organizationId:org,rootId:id,input:{pageSize:25}}]);
  for(const query of ['organizationId='+user,'pageSize=201','cursor=','extra=true'])
   expect((await app.inject({method:'GET',url:`/v1/automations/${id}/subflow-catalog?${query}`,headers:{authorization}})).statusCode).toBe(400);
  role=null;expect((await app.inject({method:'GET',url:`/v1/automations/${id}/subflow-catalog`,headers:{authorization}})).statusCode).toBe(403);
  expect(calls).toHaveLength(1);
 });
});
