import { afterEach,expect,it,vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import type { ChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
const org='4f2491a2-6853-4ac2-a7ef-c997813a9182',id='81555d45-b1a2-4a3f-ab95-c1459b0df0d0',secret='catalog-test-secret-at-least-32-bytes';
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function harness(){
  let role:'OWNER'|'VIEWER'|null='OWNER';
  const catalog={scope:{organizationId:org,channelId:id,integrationId:id,destinationRevision:1,accountId:7,inboxId:9},observedAt:new Date().toISOString(),credentialRevision:1,
    teams:[],agents:[],labels:[],attributes:[],hours:{enabled:null,timezone:null,days:[]},remoteBot:null,inboxPolicy:{greetingEnabled:null,autoAssignmentEnabled:null},
    capabilities:{teams:'UNVERIFIED',agents:'SUPPORTED',inboxMembership:'SUPPORTED',labels:'UNVERIFIED',attributes:'UNVERIFIED',hours:'UNVERIFIED',agentBot:'UNVERIFIED',signatures:'UNVERIFIED',controlEvents:'UNVERIFIED',initialPending:'UNVERIFIED'}};
  const attendanceCatalog=vi.fn().mockResolvedValue(catalog);
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),
    integrations:{service:{attendanceCatalog} as unknown as ChatwootService,jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role}});
  apps.push(app);
  return {app,attendanceCatalog,catalog,setRole:(value:typeof role)=>{role=value;},headers:{authorization:'Bearer '+await issueAccessToken({userId:id,organizationId:org,role:'OWNER'},secret)}};
}
it('serves fresh metadata scoped only by the current authenticated company',async()=>{
  const h=await harness(),response=await h.app.inject({url:`/v1/integrations/chatwoot/connections/${id}/attendance-catalog`,headers:h.headers});
  expect(response.statusCode).toBe(200);expect(response.json()).toEqual(h.catalog);expect(response.headers['cache-control']).toBe('no-store');
  expect(h.attendanceCatalog).toHaveBeenCalledWith(org,id);
  expect((await h.app.inject({url:`/v1/integrations/chatwoot/connections/${id}/attendance-catalog?accountId=8`,headers:h.headers})).statusCode).toBe(400);
});
it('denies anonymous, viewer and a revoked role despite an existing owner token',async()=>{
  const h=await harness(),url=`/v1/integrations/chatwoot/connections/${id}/attendance-catalog`;
  expect((await h.app.inject({url})).statusCode).toBe(401);
  h.setRole('VIEWER');expect((await h.app.inject({url,headers:h.headers})).statusCode).toBe(403);
  h.setRole(null);expect((await h.app.inject({url,headers:h.headers})).statusCode).toBe(403);
  expect(h.attendanceCatalog).not.toHaveBeenCalled();
});
