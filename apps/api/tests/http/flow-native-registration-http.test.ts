import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {issueAccessToken} from '@jrc/security';
import {registrationFixture} from '../unit/flow-native-registration-fixture.js';
import {registerNativeFlowRoutes} from '../../src/http/routes/flow-native.js';
const apps:ReturnType<typeof Fastify>[]=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function harness(){const h=registrationFixture(),app=Fastify(),secret='fixture-native-registration-secret32';apps.push(app);app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 await app.register(scope=>registerNativeFlowRoutes(scope,{service:h.nativeService,registration:h.service,jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=> 'ADMIN',resolveFlowCredential:async digest=>digest===createHash('sha256').update(h.token).digest('hex')?h.org:null,rateLimit:{store:{kind:'memory',consume:async()=>({allowed:true,count:1,remaining:9,retryAfterMs:0,released:false})},secret,nodeEnv:'test',trustedProxyCidrs:[],ipLimit:100,identityLimit:100,windowMs:60000}}));
 return {...h,app,headers:{authorization:'Bearer '+h.token},jwt:{authorization:'Bearer '+await issueAccessToken({organizationId:h.org,userId:h.actor,role:'ADMIN',authVersion:5},secret)}};
}
it('issues, reads, registers and revokes through real Fastify with separate JWT and native credential audiences',async()=>{
 const h=await harness(),path='/v1/flow-delegations/native-registration-challenges';
 const issued=await h.app.inject({method:'POST',url:path,headers:h.jwt,payload:h.input});expect(issued.statusCode,issued.body).toBe(201);
 const challenge=issued.json(),headers={...h.headers,'x-jrc-flow-challenge':challenge.transferNonce};
 const read=await h.app.inject({method:'GET',url:path+'/'+challenge.challengeId,headers});expect(read.statusCode,read.body).toBe(200);expect(read.json().state).toBe('PENDING');expect(read.headers['cache-control']).toBe('no-store');
 const registered=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-registrations',headers,payload:{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)}});expect(registered.statusCode,registered.body).toBe(201);
 const revoked=await h.app.inject({method:'DELETE',url:'/v1/flow-delegations/native-registrations/'+registered.json().id,headers:h.jwt});expect(revoked.statusCode,revoked.body).toBe(200);expect(revoked.json()).toEqual({revoked:true});
 expect((await h.app.inject({method:'POST',url:path,headers:h.headers,payload:h.input})).statusCode).toBe(401);
 expect((await h.app.inject({method:'GET',url:path+'/'+challenge.challengeId,headers:{...h.jwt,'x-jrc-flow-challenge':challenge.transferNonce}})).statusCode).toBe(401);
});
it('enforces64KiB only for registration endpoints and preserves16KiB session body limits',async()=>{
 const h=await harness(),path='/v1/flow-delegations/native-registration-challenges',body=JSON.stringify(h.input),exact=body+' '.repeat(65536-Buffer.byteLength(body));
 const accepted=await h.app.inject({method:'POST',url:path,headers:{...h.jwt,'content-type':'application/json'},payload:exact});expect(accepted.statusCode,accepted.body).toBe(201);
 const overflow=await h.app.inject({method:'POST',url:path,headers:{...h.jwt,'content-type':'application/json'},payload:exact+' '});expect(overflow.statusCode).toBe(413);expect(overflow.headers['cache-control']).toBe('no-store');
 const session=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:{...h.headers,'content-type':'application/json'},payload:exact});expect(session.statusCode).toBe(413);
});
it('requires challenge nonce header and rejects body/query tenant inputs without exposing callback secrets',async()=>{
 const h=await harness(),issued=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-registration-challenges',headers:h.jwt,payload:h.input});expect(issued.statusCode).toBe(201);const c=issued.json();
 expect((await h.app.inject({method:'GET',url:'/v1/flow-delegations/native-registration-challenges/'+c.challengeId,headers:h.headers})).statusCode).toBe(400);
 const response=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-registrations',headers:{...h.headers,'x-jrc-flow-challenge':c.transferNonce},payload:{challengeId:c.challengeId,callbackCredential:'x'.repeat(43),organizationId:h.org}});expect(response.statusCode).toBe(400);expect(response.body).not.toContain('x'.repeat(43));
});
