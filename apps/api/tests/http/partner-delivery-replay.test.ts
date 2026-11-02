import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {describe,it,expect} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {registerPartnerWebhookRoutes} from '../../src/http/routes/partner-webhooks.js';
import {createPartnerEventService} from '../../src/modules/partner-events/service.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
const org='00000000-0000-4000-8000-000000000001',key='00000000-0000-4000-8000-000000000002',id='00000000-0000-4000-8000-000000000003',idem='00000000-0000-4000-8000-000000000004',secret='a'.repeat(40);
async function harness(scopes:string[]=['webhooks:manage'],constraint?:string){
 const app=Fastify({genReqId:()=>org});app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 const service=createPartnerEventService({secrets:createIntegrationSecrets(Buffer.alloc(32,8).toString('base64')),transact:async(tenant,work)=>{
  if(tenant!==org)throw Error('TENANT');
  return work({query:async(sql:string,values:unknown[])=>{
   if(sql.includes('tenant_is_active'))return {rows:[{active:true}]};
   if(values[0]!==key)throw Error('KEY');
   if(constraint)throw {code:'23514',constraint,message:'private database detail'};
   if(sql.includes('partner_replay_delivery'))return {rows:[{result:{schemaVersion:1,replay:{id:idem,deliveryId:id,endpointId:key,eventId:org,replayNumber:1,priorAttempts:10,acceptedAt:'2026-10-29T00:00:00.000Z'},replayed:false}}]};
   return {rows:[{result:{schemaVersion:1,retentionDays:30,counts:{PENDING:1,RUNNING:0,DELIVERED:2,FAILED:3,CANCELLED:0},oldestPendingAt:null,expiredLeases:0,replays:1,lifetimeAttempts:40}}]};
  }} as never);
 }});
 await app.register(registerPartnerWebhookRoutes,{jwtSecret:secret,authenticateApiKey:async value=>value==='valid'?{organizationId:org,apiKeyId:key,scopes}:null,service});return app;
}
const headers={'x-jrc-api-key':'valid','idempotency-key':idem};
describe('versioned delivery replay HTTP',()=>{
 it('exposes an additive replay response with stable delivery identity',async()=>{const app=await harness();try{
  const response=await app.inject({method:'POST',url:`/v1/partner-webhook-deliveries/${id}/replay`,headers,payload:{}});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({schemaVersion:1,replay:{deliveryId:id,eventId:org,endpointId:key,priorAttempts:10}});expect(response.headers['cache-control']).toBe('no-store');
 }finally{await app.close();}});
 it('requires an empty strict body and UUID idempotency; refuses tenant injection',async()=>{const app=await harness();try{
  for(const payload of [{organizationId:org},{url:'https://elsewhere.test'},{schemaVersion:1}])expect((await app.inject({method:'POST',url:`/v1/partner-webhook-deliveries/${id}/replay`,headers,payload})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`/v1/partner-webhook-deliveries/${id}/replay`,headers:{...headers,'idempotency-key':'not-uuid'},payload:{}})).statusCode).toBe(400);
 }finally{await app.close();}});
 it('denies JWT even ADMIN and keys lacking explicit webhooks scope',async()=>{for(const scopes of [[],['webhooks:manage']]){const app=await harness(scopes);try{
  const token=await issueAccessToken({userId:org,organizationId:org,role:'ADMIN'},secret);
  for(const url of [`/v1/partner-webhook-deliveries/${id}/replay`,'/v1/partner-webhook-delivery-stats']){
   const method=url.endsWith('replay')?'POST':'GET';
   expect((await app.inject({method,url,headers:{authorization:`Bearer ${token}`,'idempotency-key':idem},...(method==='POST'?{payload:{}}:{})})).statusCode).toBe(403);
   if(!scopes.length)expect((await app.inject({method,url,headers,...(method==='POST'?{payload:{}}:{})})).statusCode).toBe(403);
  }
 }finally{await app.close();}}});
 it('returns aggregate stats and rejects unrecognized filters',async()=>{const app=await harness();try{
  const response=await app.inject({method:'GET',url:`/v1/partner-webhook-delivery-stats?endpointId=${key}`,headers});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({schemaVersion:1,counts:{FAILED:3},lifetimeAttempts:40});expect(response.body).not.toMatch(/payload|url|secret|apiKey/);
  expect((await app.inject({method:'GET',url:'/v1/partner-webhook-delivery-stats?organizationId='+org,headers})).statusCode).toBe(400);
 }finally{await app.close();}});
 it('maps database revocation and conflict to sanitized problem details',async()=>{for(const [constraint,status] of [['partner_replay_forbidden',403],['partner_replay_conflict',409]] as const){const app=await harness(undefined,constraint);try{
  const response=await app.inject({method:'POST',url:`/v1/partner-webhook-deliveries/${id}/replay`,headers,payload:{}});expect(response.statusCode).toBe(status);expect(response.body).not.toContain('private database');
 }finally{await app.close();}}});
});
