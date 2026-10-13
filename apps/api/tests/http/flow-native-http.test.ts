import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {issueAccessToken} from '@jrc/security';
import {serviceFixture} from '../unit/flow-native-service-fixture.js';
import {registerNativeFlowRoutes} from '../../src/http/routes/flow-native.js';
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function harness(){
 const h=serviceFixture(),app=Fastify(),secret='native-transport-fixture-secret-32bytes';apps.push(app);
 app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 let role:'ADMIN'|'OPERATOR'|null='ADMIN';
 const lookup=vi.fn(async(digest:string)=>digest===createHash('sha256').update(h.token).digest('hex')?h.org:null);
 const consume=vi.fn(async()=>({allowed:true,count:1,remaining:9,retryAfterMs:0,released:false}));
 await app.register(scope=>registerNativeFlowRoutes(scope,{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,resolveFlowCredential:lookup,service:h.service,
  rateLimit:{store:{kind:'memory',consume},secret,nodeEnv:'test',trustedProxyCidrs:[],ipLimit:20,identityLimit:10,windowMs:60000}}));
 return {...h,app,lookup,consume,setRole:(value:typeof role)=>{role=value;},headers:{authorization:'Bearer '+h.token},jwt:{authorization:'Bearer '+await issueAccessToken({organizationId:h.org,userId:h.actor,role:'ADMIN',authVersion:5},secret)}};
}
it('returns paginated native context through real Fastify with credential-only authority and no cache',async()=>{
 const h=await harness();const response=await h.app.inject({method:'GET',url:'/v1/flow-delegations/native-context?limit=1',headers:h.headers});
 expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({credential:{id:h.credential.id,expiresAt:h.expires.toISOString()},destination:{organizationId:h.org,accountId:7},targets:[{transport:'CENTRAL_TRANSPORT'}],nextCursor:null});
 expect(response.headers['cache-control']).toBe('no-store');expect(h.adapter.introspect).not.toHaveBeenCalled();expect(h.consume).toHaveBeenCalledTimes(3);
 for(const suffix of ['?cursor=garbage','?organizationId='+h.org,'?limit=101'])expect((await h.app.inject({method:'GET',url:'/v1/flow-delegations/native-context'+suffix,headers:h.headers})).statusCode).toBe(400);
 for(const headers of [h.jwt,{authorization:'Bearer '+'s'.repeat(43)},{...h.headers,'x-jrc-api-key':'qr-key'},{...h.headers,'x-organization-id':h.org}])expect([400,401]).toContain((await h.app.inject({method:'GET',url:'/v1/flow-delegations/native-context',headers})).statusCode);
 const body=await h.app.inject({method:'GET',url:'/v1/flow-delegations/native-context',headers:h.headers,payload:{organizationId:h.org}});expect(body.statusCode).toBe(400);
});
it('exchanges the native credential via real Fastify and canonical service with SQL-derived expiry',async()=>{
 const h=await harness(),response=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:h.headers,payload:h.input});
 expect(response.statusCode).toBe(201);expect(response.json()).toMatchObject({expiresAt:h.expires.toISOString()});expect(response.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
 expect(response.headers['cache-control']).toBe('no-store');expect(h.lookup).toHaveBeenCalledWith(createHash('sha256').update(h.token).digest('hex'));
 const revoked=await h.app.inject({method:'DELETE',url:'/v1/flow-delegations/native-sessions/'+response.json().id,headers:h.headers,payload:{externalActorId:h.input.externalActorId,nonce:h.nonce}});
 expect(revoked.statusCode).toBe(200);expect(revoked.json()).toEqual({revoked:true});
});
it('issues and revokes credentials with current Broker administrator authority through real service',async()=>{
 const h=await harness(),url='/v1/flow-delegations/native-credentials';
 const created=await h.app.inject({method:'POST',url,headers:h.jwt,payload:{scopes:['flow:read'],expiresInSeconds:86400}});
 expect(created.statusCode).toBe(201);expect(created.json()).toMatchObject({expiresAt:h.expires.toISOString()});
 const removed=await h.app.inject({method:'DELETE',url:url+'/'+created.json().id,headers:h.jwt});expect(removed.statusCode,removed.body).toBe(200);
 h.setRole('OPERATOR');expect((await h.app.inject({method:'POST',url,headers:h.jwt,payload:{scopes:['flow:read'],expiresInSeconds:60}})).statusCode).toBe(403);
 expect((await h.app.inject({method:'POST',url,headers:h.headers,payload:{scopes:['flow:read'],expiresInSeconds:60}})).statusCode).toBe(401);
});
it('rejects tenant overrides and QR headers before credential digest lookup',async()=>{
 const h=await harness();for(const header of ['x-organization-id','x-jrc-organization-id','x-jrc-api-key']){
  const response=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:{...h.headers,[header]:randomUUID()},payload:h.input});
  expect([400,401]).toContain(response.statusCode);expect(response.headers['cache-control']).toBe('no-store');
 }expect(h.lookup).not.toHaveBeenCalled();expect(h.query).not.toHaveBeenCalled();
});
it('rejects strict body/query authority and out-of-cap credential inputs',async()=>{
 const h=await harness();for(const payload of [{...h.input,organizationId:h.org},{...h.input,accountId:7},{...h.input,role:'administrator'}])expect((await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:h.headers,payload})).statusCode).toBe(400);
 expect((await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions?organizationId='+h.org,headers:h.headers,payload:h.input})).statusCode).toBe(400);
 for(const expiresInSeconds of [59,86401])expect((await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-credentials',headers:h.jwt,payload:{scopes:['flow:read'],expiresInSeconds}})).statusCode).toBe(400);
 expect(h.query).not.toHaveBeenCalled();
});
it('never accepts a Flow session token, JWT or missing credential as native issuance credential',async()=>{
 const h=await harness();for(const headers of [{authorization:'Bearer '+'s'.repeat(43)},h.jwt,{}])expect((await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers,payload:h.input})).statusCode).toBe(401);
 expect(h.query).not.toHaveBeenCalled();
});
it('rate limits before credential lookup with only HMAC keys and fails closed on store outage',async()=>{
 const h=await harness();h.consume.mockResolvedValueOnce({allowed:false,count:21,remaining:0,retryAfterMs:3100,released:false});
 let response=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:h.headers,payload:h.input});expect(response.statusCode).toBe(429);expect(response.headers['retry-after']).toBe('4');expect(h.lookup).not.toHaveBeenCalled();
 expect(h.consume.mock.calls.every(call=>/^(ip|identity):[a-f0-9]{64}$/.test(call[0] as string))).toBe(true);
 h.consume.mockRejectedValueOnce(new Error('private-store-secret'));response=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:h.headers,payload:h.input});expect(response.statusCode).toBe(503);expect(response.body).not.toContain('private-store-secret');expect(h.lookup).not.toHaveBeenCalled();
});
it('sanitizes unknown actual service errors and retains no-store on failures',async()=>{
 const h=await harness();h.query.mockRejectedValueOnce(new Error('private-database-canary'));
 const response=await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:h.headers,payload:h.input});expect(response.statusCode).toBe(500);expect(response.body).not.toContain('private-database-canary');expect(response.headers['cache-control']).toBe('no-store');
});
it('limits a credential as a whole as well as each actor, using distinct HMAC buckets',async()=>{
 const h=await harness();await h.app.inject({method:'POST',url:'/v1/flow-delegations/native-sessions',headers:h.headers,payload:h.input});
 const keys=h.consume.mock.calls.map(call=>String(call[0]));expect(keys.filter(key=>key.startsWith('identity:'))).toHaveLength(2);expect(new Set(keys).size).toBe(3);
});
