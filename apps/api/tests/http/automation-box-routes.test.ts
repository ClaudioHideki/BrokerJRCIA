import Fastify from 'fastify';
import {serializerCompiler,validatorCompiler} from 'fastify-type-provider-zod';
import {issueAccessToken} from '@jrc/security';
import {it,expect,vi} from 'vitest';
import {registerAutomationRoutes} from '../../src/http/routes/automations.js';
const org='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',automation='33333333-3333-4333-8333-333333333333',channel='44444444-4444-4444-8444-444444444444';
it('protects box routing with current admin authorization and forwards only the authenticated tenant',async()=>{
 const app=Fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 const secret='synthetic-test-secret-over-32-characters';let role:'OWNER'|'OPERATOR'='OWNER';
 const service={boxRoutingCatalog:vi.fn(async()=>({ok:true})),saveBoxRouting:vi.fn(async()=>({revision:1}))};
 await app.register(target=>registerAutomationRoutes(target,{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service:service as never,executions:{} as never}));
 const headers={authorization:`Bearer ${await issueAccessToken({organizationId:org,userId:actor,role:'OWNER',authVersion:1},secret)}`};
 const url=`/v1/automations/${automation}/channels/${channel}/box-routing`;
 try{
  expect((await app.inject({url:url+'?version=1',headers})).statusCode).toBe(200);
  expect(service.boxRoutingCatalog).toHaveBeenCalledWith(org,automation,channel,1);
  const payload={version:1,expectedRevision:0,config:{schemaVersion:1,routes:[{routeKey:'sales',teamId:1,mode:'AGENT',membership:'ALL',agentIds:[]}]}};
  expect((await app.inject({method:'PUT',url,headers,payload})).statusCode).toBe(200);
  expect(service.saveBoxRouting).toHaveBeenCalledWith(org,automation,channel,payload,actor);
  expect((await app.inject({url:url+'?version=1&organizationId='+org,headers})).statusCode).toBe(400);
  role='OPERATOR';expect((await app.inject({method:'PUT',url,headers,payload})).statusCode).toBe(403);
  expect((await app.inject({url:url+'?version=1',headers})).statusCode).toBe(403);
 }finally{await app.close();}
});
