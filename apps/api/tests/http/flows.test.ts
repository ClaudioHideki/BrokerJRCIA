import { afterEach, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { welcomeFlow } from '@jrc/contracts';
import { buildApp } from '../../src/app.js';
import { createFlowService } from '../../src/modules/flows/service.js';
import { MessagingRepositoryError } from '../../src/modules/messaging/repository.js';
const apps:ReturnType<typeof buildApp>[]=[];
const org='4f2491a2-6853-4ac2-a7ef-c997813a9182',secret='flows-local-test-secret-at-least-32-bytes';
async function setup(){
 let role:'OWNER'|'VIEWER'|null='OWNER';
 const service=createFlowService({transact:async()=>{throw new Error('Unexpected DB call');}});
 service.status=vi.fn(async()=>({enabled:true}));
 service.create=vi.fn(async(_org,input)=>({id:org,name:input.name,graph:input.graph,revision:1,publishedVersion:null,updatedAt:new Date().toISOString()}));
 const app=buildApp({nodeEnv:'test',flows:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service}});apps.push(app);
 const token=await issueAccessToken({userId:'8c5f5c0e-37e8-4d6f-a934-9b99e58bcd4d',organizationId:org,role:'OWNER'},secret);
 return {app,service,headers:{authorization:'Bearer '+token},role:(v:typeof role)=>{role=v;}};
}
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
it('derives the tenant from session and refuses forged organization fields',async()=>{
 const h=await setup();
 expect((await h.app.inject({method:'POST',url:'/v1/flows',headers:h.headers,payload:{name:'Novo',graph:welcomeFlow()}})).statusCode).toBe(201);
 expect(h.service.create).toHaveBeenCalledWith(org,{name:'Novo',graph:welcomeFlow()});
 expect((await h.app.inject({method:'POST',url:'/v1/flows',headers:h.headers,payload:{name:'Novo',graph:welcomeFlow(),organizationId:org}})).statusCode).toBe(400);
});
it('checks current membership before editing and does not expose stale session privileges',async()=>{
 const h=await setup();h.role('VIEWER');
 expect((await h.app.inject({method:'POST',url:'/v1/flows',headers:h.headers,payload:{name:'Novo',graph:welcomeFlow()}})).statusCode).toBe(403);
 expect(h.service.create).not.toHaveBeenCalled();h.role(null);
 expect((await h.app.inject({method:'GET',url:'/v1/flows/status',headers:h.headers})).statusCode).toBe(403);
});
it('requires authentication and serves capability status without caching',async()=>{
 const h=await setup();
 expect((await h.app.inject({method:'GET',url:'/v1/flows/status'})).statusCode).toBe(401);
 const result=await h.app.inject({method:'GET',url:'/v1/flows/status',headers:h.headers});
 expect(result.statusCode).toBe(200);expect(result.json()).toEqual({enabled:true});expect(result.headers['cache-control']).toBe('no-store');
});
it('reports an existing inbox automation as a conflict that the operator can resolve',async()=>{
 const h=await setup();
 h.service.bind=vi.fn(async()=>{throw new MessagingRepositoryError('FLOW_INBOX_HAS_AUTOMATION',409);});
 const response=await h.app.inject({method:'POST',url:`/v1/flows/${org}/bind`,headers:h.headers,payload:{channelId:org}});
 expect(response.statusCode).toBe(409);
 expect(response.json().code).toBe('FLOW_INBOX_HAS_AUTOMATION');
});
