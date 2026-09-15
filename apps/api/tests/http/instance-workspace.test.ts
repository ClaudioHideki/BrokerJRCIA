import {expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {issueAccessToken} from '@jrc/security';
import {registerInstanceWorkspaceRoutes} from '../../src/http/routes/instance-workspace.js';
import {InstanceWorkspaceService} from '../../src/modules/instances/workspace.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';

const orgA='11111111-1111-4111-8111-111111111111',orgB='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',user='44444444-4444-4444-8444-444444444444';
const settings={rejectCall:false,msgCall:'',groupsIgnore:false,alwaysOnline:false,readMessages:false,readStatus:false,syncFullHistory:false};
it('enforces organization, current role, strict settings, API key boundary and cancellation context through HTTP',async()=>{
  const provider={read:vi.fn(async()=>({profile:{name:'Demo',phone:null,state:'open'},counts:{contacts:1,chats:2,messages:3},settings})),updateSettings:vi.fn(async()=>undefined)};
  const service=new InstanceWorkspaceService({provider,transact:async<T>(org:string,operation:(tx:TenantTransaction)=>Promise<T>)=>operation({query:async(sql:string)=>{
    if(sql.includes('FROM instances'))return {rows:org===orgA?[{id,name:'Demo',status:'CONNECTED',provider:'BAILEYS',upstreamKey:'jrc_private',organizationStatus:'ACTIVE',createdAt:new Date(0),updatedAt:new Date(0)}]:[]};
    if(sql.includes('FROM memberships'))return {rows:[{role:'OWNER'}]};
    return {rows:[]};
  }} as unknown as TenantTransaction)});
  const app=Fastify();app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
  let currentRole:'OWNER'|'VIEWER'|null='OWNER';app.decorate('resolveTenantRole',async()=>currentRole);
  const jwtSecret='t'.repeat(48);
  await app.register(async scope=>registerInstanceWorkspaceRoutes(scope,{service,jwtSecret,authenticateApiKey:async()=>({organizationId:orgA,apiKeyId:id,scopes:['*']})}));
  const tokenA=await issueAccessToken({userId:user,organizationId:orgA,role:'OWNER'},jwtSecret);
  const tokenB=await issueAccessToken({userId:user,organizationId:orgB,role:'OWNER'},jwtSecret);
  const headers={authorization:`Bearer ${tokenA}`};const url=`/v1/instances/${id}`;
  try{
    expect((await app.inject({url:`${url}/workspace`})).statusCode).toBe(401);
    expect((await app.inject({url:`${url}/workspace`,headers:{authorization:`Bearer ${tokenB}`}})).statusCode).toBe(404);
    expect(provider.read).not.toHaveBeenCalled();
    const response=await app.inject({url:`${url}/workspace`,headers});expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');expect(response.json().counts.messages).toBe(3);expect(response.body).not.toContain('jrc_private');
    expect((await app.inject({url:`${url}/workspace`,headers:{'x-jrc-api-key':'test'}})).statusCode).toBe(403);
    expect((await app.inject({method:'PUT',url:`${url}/settings`,headers,payload:{...settings,token:'forbidden'}})).statusCode).toBe(400);
    currentRole='VIEWER';expect((await app.inject({method:'PUT',url:`${url}/settings`,headers,payload:settings})).statusCode).toBe(403);
    expect(provider.updateSettings).not.toHaveBeenCalled();
    currentRole='OWNER';expect((await app.inject({method:'PUT',url:`${url}/settings`,headers,payload:settings})).statusCode).toBe(200);
    expect(provider.updateSettings).toHaveBeenCalledOnce();
    currentRole=null;expect((await app.inject({url:`${url}/workspace`,headers})).statusCode).toBe(401);
  }finally{await app.close();}
});
