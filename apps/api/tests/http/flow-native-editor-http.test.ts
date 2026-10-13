import Fastify from 'fastify';import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';import {afterEach,expect,it,vi} from 'vitest';import {randomUUID,createHash} from 'node:crypto';
import {registerFlowDelegationRoutes} from '../../src/http/routes/flow-delegation.js';
const apps:ReturnType<typeof Fastify>[]=[],org=randomUUID(),id=randomUUID(),channel=randomUUID(),token='s'.repeat(43),access={organizationId:org,token},headers={authorization:'Bearer '+token};
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function harness(){const catalog=()=>({schemaVersion:1,scope:{organizationId:org,rootAutomationId:id},data:[],nextCursor:null}),service={status:vi.fn(async()=>({enabled:true,canEdit:true,canPublish:true,canSimulate:true})),nodes:vi.fn(async()=>({schemaVersion:1,data:[]})),importPreview:vi.fn(async()=>({schemaVersion:1,name:'Imported',graph:{nodes:[],edges:[]},report:{}})),simulate:vi.fn(async()=>({status:'COMPLETED',state:{variables:{}},effects:[],trace:[]})),httpCredentialCatalog:vi.fn(async()=>catalog()),subflowCatalog:vi.fn(async()=>catalog()),aiCredentialCatalog:vi.fn(async()=>catalog()),uploadMedia:vi.fn(async()=>({schemaVersion:1,scope:{organizationId:org,rootAutomationId:id,channelId:channel},id:randomUUID(),revision:1,status:'READY',name:'imagem.png',kind:'image',mimeType:'image/png',byteSize:3}))};
 const app=Fastify();apps.push(app);app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);await app.register(scope=>registerFlowDelegationRoutes(scope,{service:service as never,jwtSecret:'synthetic-secret-only-32-byte-value',authenticateApiKey:async()=>null,resolveCurrentRole:async()=>null,resolveFlowSession:async digest=>digest===createHash('sha256').update(token).digest('hex')?org:null}));return {app,service};}
it('routes current metadata catalogs and exact HTTP/AI simulation through the scoped common service ports',async()=>{
 const h=await harness();for(const [suffix,method] of [['http-credentials','httpCredentialCatalog'],['subflow-catalog','subflowCatalog'],['ai-credentials','aiCredentialCatalog']] as const){const r=await h.app.inject({url:`/v1/delegated-flows/${id}/${suffix}?pageSize=1`,headers});expect(r.statusCode).toBe(200);expect(h.service[method]).toHaveBeenCalledWith(access,id,{pageSize:1});}
 const payload={text:'Oi',events:[{type:'HTTP_RESPONSE',nodeId:'http',outcome:'success',status:200,body:'{"ok":true}'},{type:'AI_RESPONSE',nodeId:'ai',outcome:'success',output:{category:'support'}}]};
 expect((await h.app.inject({method:'POST',url:`/v1/delegated-flows/${id}/simulate`,headers,payload})).statusCode).toBe(200);expect(h.service.simulate).toHaveBeenCalledWith(access,id,payload);
 expect((await h.app.inject({method:'POST',url:`/v1/delegated-flows/${id}/simulate`,headers,payload:{...payload,organizationId:randomUUID()}})).statusCode).toBe(400);
});
it('keeps import graph bytes independent from control response bounds',async()=>{
 const h=await harness(),payload={source:'AUTO',content:'x'.repeat(20_000),integrationIds:[randomUUID()]};expect((await h.app.inject({method:'POST',url:'/v1/delegated-flows/import-preview',headers,payload})).statusCode).toBe(200);expect(h.service.importPreview).toHaveBeenCalledWith(access,payload);
 h.service.status.mockResolvedValueOnce({privateResponseCanary:'x'.repeat(16_385)} as never);const r=await h.app.inject({url:'/v1/delegated-flows/status',headers});expect(r.statusCode).toBe(502);expect(r.body).not.toContain('privateResponseCanary');expect(r.headers['cache-control']).toBe('no-store');
});
it('accepts bounded raw media only under opaque Flow session authority and rejects extra tenant headers',async()=>{
 const h=await harness(),key=randomUUID(),mediaHeaders={...headers,'content-type':'application/octet-stream','x-jrc-media-mime':'image/png','x-jrc-media-kind':'image','x-jrc-media-name':'imagem.png','idempotency-key':key},url=`/v1/delegated-flows/${id}/channels/${channel}/media`;
 expect((await h.app.inject({method:'POST',url,headers:mediaHeaders,payload:Buffer.from([0,1,2])})).statusCode).toBe(200);expect(h.service.uploadMedia).toHaveBeenCalledWith(access,id,channel,{bytes:Buffer.from([0,1,2]),mimeType:'image/png',kind:'image',fileName:'imagem.png',idempotencyKey:key});
 expect((await h.app.inject({method:'POST',url,headers:{...mediaHeaders,'x-organization-id':org},payload:Buffer.from([0,1,2])})).statusCode).toBe(400);
 expect((await h.app.inject({method:'POST',url,headers:{...mediaHeaders,authorization:'Bearer '+'c'.repeat(43)},payload:Buffer.from([0,1,2])})).statusCode).toBe(401);
});
it('returns413 on the actual raw media stream ceiling instead of invoking the service',async()=>{
 const h=await harness(),r=await h.app.inject({method:'POST',url:`/v1/delegated-flows/${id}/channels/${channel}/media`,headers:{...headers,'content-type':'application/octet-stream','x-jrc-media-mime':'image/png','x-jrc-media-kind':'image','x-jrc-media-name':'imagem.png','idempotency-key':randomUUID()},payload:Buffer.alloc(16*1024*1024+1)});
 expect(r.statusCode).toBe(413);expect(h.service.uploadMedia).not.toHaveBeenCalled();
});
