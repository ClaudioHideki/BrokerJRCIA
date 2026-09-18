import { afterEach, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import { createFlowService, FlowError } from '../../src/modules/flows/service.js';
import { createFlowChatwootService } from '../../src/modules/flows/chatwoot-service.js';

const org='4f2491a2-6853-4ac2-a7ef-c997813a9182',secret='flows-http-test-key-at-least-32-bytes';
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
async function setup(){
  let role:'OWNER'|'VIEWER'|null='OWNER';
  const transact=async():Promise<never>=>{throw new Error('Unexpected database call');};
  const service=createFlowService({transact});
  const chatwoot=createFlowChatwootService({transact,publicOrigin:'https://broker.example.test',encryptionKey:Buffer.alloc(32,1).toString('base64'),resolveBinding:async()=>undefined,resolveIntegration:async()=>undefined});
  chatwoot.bind=vi.fn(async()=>({id:org,flowId:org,inboxId:7,accountId:2,name:'Fixture',channelType:'Channel::Email',status:'READY',lastError:null}));
  chatwoot.ingest=vi.fn(async()=>({accepted:true}));
  const app=buildApp({nodeEnv:'test',flows:{service,chatwoot,jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role}});apps.push(app);
  const token=await issueAccessToken({userId:'8c5f5c0e-37e8-4d6f-a934-9b99e58bcd4d',organizationId:org,role:'OWNER'},secret);
  return {app,chatwoot,headers:{authorization:'Bearer '+token},role:(v:typeof role)=>{role=v;}};
}
it('only a current administrator can attach a bot and cannot supply a different tenant',async()=>{
  const h=await setup(),url='/v1/flows/'+org+'/chatwoot/bind';
  expect((await h.app.inject({method:'POST',url,payload:{inboxId:7}})).statusCode).toBe(401);
  expect((await h.app.inject({method:'POST',url,headers:h.headers,payload:{inboxId:7,organizationId:org}})).statusCode).toBe(400);
  expect((await h.app.inject({method:'POST',url,headers:h.headers,payload:{inboxId:7}})).statusCode).toBe(200);
  expect(h.chatwoot.bind).toHaveBeenCalledWith(org,org,7);
  h.role('VIEWER');expect((await h.app.inject({method:'POST',url,headers:h.headers,payload:{inboxId:7}})).statusCode).toBe(403);
});
it('preserves the exact signed bytes and exposes signature failures without a JWT requirement',async()=>{
  const h=await setup(),raw='{ "event": "message_created" }',url='/v1/flows/chatwoot/'+org+'/events';
  expect((await h.app.inject({method:'POST',url,headers:{'content-type':'application/json','x-chatwoot-timestamp':'123','x-chatwoot-signature':'sig'},payload:raw})).statusCode).toBe(202);
  expect(h.chatwoot.ingest).toHaveBeenCalledWith(org,Buffer.from(raw),'123','sig');
  vi.mocked(h.chatwoot.ingest).mockRejectedValueOnce(new FlowError('FLOW_SIGNATURE_INVALID',401));
  const result=await h.app.inject({method:'POST',url,headers:{'content-type':'application/json'},payload:raw});
  expect(result.statusCode).toBe(401);expect(result.json().code).toBe('FLOW_SIGNATURE_INVALID');
});
