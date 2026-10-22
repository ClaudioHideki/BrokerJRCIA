import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {describe,it,expect,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {registerPartnerWebhookRoutes} from '../../src/http/routes/partner-webhooks.js';
const org='00000000-0000-4000-8000-000000000001',secret='a'.repeat(40);
async function harness(scopes:string[]=['webhooks:manage']){
 const app=Fastify({genReqId:()=>org});app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 const service={create:vi.fn(async()=>({endpoint:{id:org,url:'https://partner.example/hook',status:'ACTIVE',createdAt:'2026-10-22T16:00:00.000Z',revokedAt:null},signingSecret:'secret',replayed:false})),list:vi.fn(async()=>({data:[]})),revoke:vi.fn(),events:vi.fn(async()=>({schemaVersion:1,retentionDays:30,earliestCursor:null,lastPrunedCursor:'0',data:[],nextCursor:'0'})),deliveries:vi.fn(async()=>({data:[]}))};
 await app.register(registerPartnerWebhookRoutes,{jwtSecret:secret,authenticateApiKey:async key=>key==='valid'?{organizationId:org,apiKeyId:org,scopes}:null,service:service as never});
 return {app,service};
}
describe('generic webhook API',()=>{
 it('reports parser errors as client errors instead of a server failure',async()=>{
  const {app,service}=await harness();try{
   for(const payload of ['', '{']) {
    const response=await app.inject({method:'POST',url:'/v1/partner-webhooks',headers:{'x-jrc-api-key':'valid','idempotency-key':'bad-json','content-type':'application/json'},payload});
    expect(response.statusCode).toBe(400);
   }
   const unsupported=await app.inject({method:'POST',url:'/v1/partner-webhooks',headers:{'x-jrc-api-key':'valid','idempotency-key':'wrong-content','content-type':'application/x-jrc-test'},payload:'content'});
   expect(unsupported.statusCode).toBe(415);expect(service.create).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it('requires explicit key scope and passes only authenticated tenant to service',async()=>{
  const {app,service}=await harness();try{
   const response=await app.inject({method:'POST',url:'/v1/partner-webhooks',headers:{'x-jrc-api-key':'valid','idempotency-key':'webhook-one'},payload:{url:'https://partner.example/hook'}});
   expect(response.statusCode).toBe(201);expect(service.create).toHaveBeenCalledWith(org,{url:'https://partner.example/hook'},'webhook-one');expect(response.headers['cache-control']).toBe('no-store');
  }finally{await app.close();}
  const denied=await harness(['messages:write']);try{expect((await denied.app.inject({method:'GET',url:'/v1/partner-events',headers:{'x-jrc-api-key':'valid'}})).statusCode).toBe(403);expect(denied.service.events).not.toHaveBeenCalled();}finally{await denied.app.close();}
 });
 it('rejects tenant injection and unbounded/invalid cursors',async()=>{
  const {app,service}=await harness();try{
   expect((await app.inject({method:'POST',url:'/v1/partner-webhooks',headers:{'x-jrc-api-key':'valid','idempotency-key':'webhook-one'},payload:{url:'https://partner.example/hook',organizationId:org}})).statusCode).toBe(400);
   expect((await app.inject({method:'GET',url:'/v1/partner-events?after=999999999999999999999999',headers:{'x-jrc-api-key':'valid'}})).statusCode).toBe(400);
   expect(service.create).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it('permits admin JWT and refuses viewer JWT',async()=>{
  const {app}=await harness();try{for(const [role,status] of [['ADMIN',200],['VIEWER',403]] as const){
   const token=await issueAccessToken({userId:org,organizationId:org,role},secret);
   expect((await app.inject({method:'GET',url:'/v1/partner-webhooks',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(status);
  }}finally{await app.close();}
 });
});
