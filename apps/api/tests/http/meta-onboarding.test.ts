import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {it,expect,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {registerMetaOnboardingRoutes} from '../../src/http/routes/meta-onboarding.js';
import type {createMetaOnboardingService} from '../../src/modules/meta-onboarding/service.js';
const org='4f2491a2-6853-4ac2-a7ef-c997813a9182';const user='81555d45-b1a2-4a3f-ab95-c1459b0df0d0';const secret='meta-tests-secret-with-at-least-32-characters';
it('uses fresh administrator membership, denies legacy keys and rejects tenant injection',async()=>{
 const app=Fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 let role:'OWNER'|'VIEWER'|null='OWNER';const start=vi.fn(async()=>({state:'x',expiresAt:'future'}));
 await registerMetaOnboardingRoutes(app,{jwtSecret:secret,authenticateApiKey:async()=>({apiKeyId:user,organizationId:org,scopes:['instances:read']}),resolveCurrentRole:async()=>role,
  service:{start} as unknown as ReturnType<typeof createMetaOnboardingService>});
 try {
  const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
  expect((await app.inject({method:'POST',url:'/v1/meta-onboarding/start',headers:{authorization},payload:{organizationId:user}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/v1/meta-onboarding/start',headers:{authorization},payload:{}})).statusCode).toBe(200);
  expect(start).toHaveBeenCalledWith(org,user);
  role='VIEWER';expect((await app.inject({method:'POST',url:'/v1/meta-onboarding/start',headers:{authorization},payload:{}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/meta-onboarding/start',headers:{'x-jrc-api-key':'legacy'},payload:{}})).statusCode).toBe(403);
  expect(start).toHaveBeenCalledTimes(1);
  role='OWNER';start.mockRejectedValueOnce(Object.assign(new Error('private database detail'),{code:'23514',constraint:'tenant_instance_limit'}));
  const quota=await app.inject({method:'POST',url:'/v1/meta-onboarding/start',headers:{authorization},payload:{}});
  expect(quota.statusCode).toBe(409);expect(quota.json().code).toBe('INSTANCE_LIMIT_REACHED');expect(quota.body).not.toContain('private database');
 } finally {await app.close();}
});
