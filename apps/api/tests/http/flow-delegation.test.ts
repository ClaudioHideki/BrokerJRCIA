import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {issueAccessToken} from '@jrc/security';
import {registerFlowDelegationRoutes} from '../../src/http/routes/flow-delegation.js';
import {FlowDelegationError} from '../../src/modules/flows/delegation/service.js';
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const org=randomUUID(),actor=randomUUID(),integration=randomUUID(),id=randomUUID(),token='s'.repeat(43),secret='flow-http-synthetic-fixture-secret-32';
const graph={nodes:[{id:'s',type:'start',label:'Start',position:{x:0,y:0},data:{}}],edges:[]};
const definition={schemaVersion:1,id,organizationId:org,name:'Scoped',lifecycleStatus:'DRAFT',draft:{revision:1,graph},activeVersion:null,updatedAt:'2026-10-08T00:00:00.000Z',scopeRevision:1};
async function harness(){
 let role:'OWNER'|'ADMIN'|'OPERATOR'|'VIEWER'|null='OWNER';
 const service={issueBrokerSession:vi.fn(async()=>({id,token,expiresAt:'2026-10-08T00:05:00.000Z'})),configureExecutorProfile:vi.fn(async()=>({revision:1,hostKind:'STOCK',originCapabilityRevision:1})),revokeSession:vi.fn(async()=>({revoked:true})),setMemberGrant:vi.fn(async()=>({revision:1})),
 list:vi.fn(async()=>({data:[(({scopeRevision,...rest})=>rest)(definition)],nextCursor:null})),get:vi.fn(async()=>definition),create:vi.fn(async()=>definition),save:vi.fn(async()=>({...definition,draft:{revision:2,graph}})),publish:vi.fn(async()=>({schemaVersion:1,automationId:id,organizationId:org,version:1,graph,checksum:'a'.repeat(64),publishedAt:'2026-10-08T00:00:00.000Z'})),versions:vi.fn(async()=>({data:[]})),validate:vi.fn(async()=>({valid:true,diagnostics:[],errors:[]})),
 prepareCutover:vi.fn(async()=>({id,revision:1,phase:'DRAINED'})),getCutover:vi.fn(async()=>null),reconcileCutover:vi.fn(async()=>({id,revision:1,phase:'DRAINED'})),bind:vi.fn(async()=>({schemaVersion:1,id,organizationId:org,automationId:id,version:1,channelId:integration,humanDestinationId:null,status:'ACTIVE',revision:1,ownerRevision:1,createdAt:'2026-10-08T00:00:00.000Z',updatedAt:'2026-10-08T00:00:00.000Z'})),simulate:vi.fn(async()=>({status:'COMPLETED',state:{variables:{}},effects:[],trace:[]}))};
 const app=Fastify();apps.push(app);app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 const resolver=vi.fn(async(hash:string)=>hash===createHash('sha256').update(token).digest('hex')?org:null);
 const current=vi.fn(async()=>role);
 await app.register(async scope=>registerFlowDelegationRoutes(scope,{jwtSecret:secret,authenticateApiKey:async()=>({organizationId:org,apiKeyId:id,scopes:['*']}),resolveCurrentRole:current,resolveFlowSession:resolver,service:service as never}));
 return {app,service,resolver,current,setRole:(value:typeof role)=>{role=value;},jwt:{authorization:`Bearer ${await issueAccessToken({organizationId:org,userId:actor,role:'OWNER',authVersion:7},secret)}`},flow:{authorization:`Bearer ${token}`}};
}
it('issues a separate short-lived Flow session using current JWT principal and strict persisted scopes',async()=>{
 const h=await harness(),input={integrationIds:[integration],scopes:['flow:read','flow:edit']};
 const r=await h.app.inject({method:'POST',url:'/v1/flow-delegations/sessions',headers:h.jwt,payload:input});
 expect(r.statusCode).toBe(201);expect(r.headers['cache-control']).toBe('no-store');expect(r.json()).toEqual({id,token,expiresAt:'2026-10-08T00:05:00.000Z'});
 expect(h.service.issueBrokerSession).toHaveBeenCalledWith({organizationId:org,actorId:actor,authVersion:7},input);
 for(const payload of [{...input,organizationId:randomUUID()},{...input,accountId:7},{...input,scopes:['flow:read','flow:read']}])expect((await h.app.inject({method:'POST',url:'/v1/flow-delegations/sessions',headers:h.jwt,payload})).statusCode).toBe(400);
});
it('rejects invalid authentication, API keys and revoked membership before issuance or profile mutation',async()=>{
 const h=await harness(),url='/v1/flow-delegations/sessions',payload={integrationIds:[integration],scopes:['flow:read']};
 expect((await h.app.inject({method:'POST',url,payload})).statusCode).toBe(401);
 expect((await h.app.inject({method:'POST',url,headers:{'x-jrc-api-key':'synthetic'},payload})).statusCode).toBe(403);
 h.setRole(null);expect((await h.app.inject({method:'POST',url,headers:h.jwt,payload})).statusCode).toBe(403);
 h.setRole('OPERATOR');expect((await h.app.inject({method:'POST',url:'/v1/flow-delegations/executor-profiles',headers:h.jwt,payload:{integrationId:integration,expectedRevision:0}})).statusCode).toBe(403);
 expect(h.service.issueBrokerSession).not.toHaveBeenCalled();expect(h.service.configureExecutorProfile).not.toHaveBeenCalled();
});
it('allows operator read-session issuance but rejects write scopes and VIEWER',async()=>{
 const h=await harness(),url='/v1/flow-delegations/sessions';h.setRole('OPERATOR');
 expect((await h.app.inject({method:'POST',url,headers:h.jwt,payload:{integrationIds:[integration],scopes:['flow:read']}})).statusCode).toBe(201);
 expect((await h.app.inject({method:'POST',url,headers:h.jwt,payload:{integrationIds:[integration],scopes:['flow:edit']}})).statusCode).toBe(403);
 h.setRole('VIEWER');expect((await h.app.inject({method:'POST',url,headers:h.jwt,payload:{integrationIds:[integration],scopes:['flow:read']}})).statusCode).toBe(403);
});
it('resolves opaque Flow token to organization through digest lookup and never accepts editor tenant fields',async()=>{
 const h=await harness();const r=await h.app.inject({url:'/v1/delegated-flows?pageSize=100',headers:h.flow});
 expect(r.statusCode).toBe(200);expect(h.resolver).toHaveBeenCalledWith(createHash('sha256').update(token).digest('hex'));
 expect(h.service.list).toHaveBeenCalledWith({organizationId:org,token},{pageSize:100});expect(r.body).not.toContain(token);
 for(const suffix of ['?organizationId='+org,'?pageSize=101','?cursor=not+base64'])expect((await h.app.inject({url:'/v1/delegated-flows'+suffix,headers:h.flow})).statusCode).toBe(400);
 expect((await h.app.inject({url:'/v1/delegated-flows',headers:{...h.flow,'x-organization-id':org}})).statusCode).toBe(400);
 for(const headers of [h.jwt,{'x-jrc-api-key':'synthetic'},{authorization:'Bearer '+'x'.repeat(43)},{...h.flow,'x-jrc-api-key':'synthetic'}])expect((await h.app.inject({url:'/v1/delegated-flows',headers})).statusCode).toBe(401);
});
it('passes create/save/publish/bind CAS to the real scoped facade without client authority or proof',async()=>{
 const h=await harness(),base='/v1/delegated-flows',input={name:'Scoped',graph,integrationIds:[integration]};
 expect((await h.app.inject({method:'POST',url:base,headers:{...h.flow,'idempotency-key':'create-fixture'},payload:input})).statusCode).toBe(201);
 expect(h.service.create).toHaveBeenCalledWith({organizationId:org,token},input,'create-fixture');
 const save={name:'Edited',graph,revision:1,expectedScopeRevision:1};expect((await h.app.inject({method:'PUT',url:base+'/'+id,headers:h.flow,payload:save})).statusCode).toBe(200);
 const publish={revision:2,expectedScopeRevision:1};expect((await h.app.inject({method:'POST',url:base+'/'+id+'/publish',headers:h.flow,payload:publish})).statusCode).toBe(200);
 const bind={integrationId:integration,cutoverId:id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0};expect((await h.app.inject({method:'POST',url:base+'/'+id+'/bindings',headers:h.flow,payload:bind})).statusCode).toBe(201);
 expect(h.service.bind).toHaveBeenCalledWith({organizationId:org,token},id,bind);
 for(const payload of [{...bind,hostKind:'STOCK'},{...bind,proof:{admissionClosed:true}},{...bind,channelId:integration}])expect((await h.app.inject({method:'POST',url:base+'/'+id+'/bindings',headers:h.flow,payload})).statusCode).toBe(400);
});
it('exposes UNKNOWN through GET and explicit read-only reconciliation, never prepare replay',async()=>{
 const h=await harness(),base='/v1/delegated-flows/integrations/'+integration+'/cutover';
 h.service.getCutover.mockResolvedValueOnce({id,integrationId:integration,phase:'UNKNOWN',revision:4,expectedOwnerRevision:0,updatedAt:'2026-10-08T00:00:00.000Z',proofValidUntil:null,ready:false} as never);
 expect((await h.app.inject({url:base,headers:h.flow})).json()).toMatchObject({phase:'UNKNOWN',ready:false});
 const input={cutoverId:id,expectedCutoverRevision:4,expectedOwnerRevision:0};expect((await h.app.inject({method:'POST',url:base+'/reconcile',headers:h.flow,payload:input})).statusCode).toBe(200);
 expect(h.service.reconcileCutover).toHaveBeenCalledWith({organizationId:org,token},integration,input);expect(h.service.prepareCutover).not.toHaveBeenCalled();
});
it('sanitizes provider errors and rejects extra credential fields in strict responses',async()=>{
 const h=await harness(),url='/v1/delegated-flows/'+id;
 h.service.get.mockRejectedValueOnce(new Error('raw-provider-secret '+token));let r=await h.app.inject({url,headers:h.flow});expect(r.statusCode).toBe(500);expect(r.body).not.toContain(token);expect(r.body).not.toContain('raw-provider');
 h.service.get.mockRejectedValueOnce(new FlowDelegationError('FLOW_SCOPE_CHANGED',409));r=await h.app.inject({url,headers:h.flow});expect(r.statusCode).toBe(409);expect(r.json()).toMatchObject({code:'FLOW_SCOPE_CHANGED'});
 h.service.get.mockResolvedValueOnce({...definition,accessToken:'private-response-canary'} as never);r=await h.app.inject({url,headers:h.flow});expect(r.statusCode).toBe(500);expect(r.body).not.toContain('private-response-canary');
});
it.each([['FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED',409],['FLOW_QR_IDENTITY_UNVERIFIED',409],['FLOW_CUTOVER_OBSERVATION_FAILED',503]])('preserves the safe operational status for %s without provider details',async(code,status)=>{
 const h=await harness();h.service.get.mockRejectedValueOnce(new FlowDelegationError(code,status));const r=await h.app.inject({url:'/v1/delegated-flows/'+id,headers:h.flow});expect(r.statusCode).toBe(status);expect(r.json()).toMatchObject({code});expect(r.headers['cache-control']).toBe('no-store');
});
