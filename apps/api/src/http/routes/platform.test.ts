import Fastify from 'fastify';
import { expect,it,vi } from 'vitest';
import { registerPlatformRoutes } from './platform.js';
import type { PlatformService } from '../../modules/platform/service.js';
it('rejects tenant bearer tokens and cross-origin login before service access',async()=>{
 const app=Fastify();await registerPlatformRoutes(app,{service:{} as PlatformService,origin:'https://console.example.test',secureCookies:true});
 expect((await app.inject({url:'/v1/platform/organizations',headers:{authorization:'Bearer tenant-jwt','x-platform-reason':'support ticket'}})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/v1/platform/auth/login',headers:{origin:'https://evil.test'},payload:{email:'a@example.test',password:'strong-password',totp:'123456'}})).statusCode).toBe(403);
 await app.close();
});
it('protects group mutations by platform session, exact origin, CSRF and strict tenant-neutral input',async()=>{
 const createGroup=vi.fn().mockResolvedValue({id:'11111111-1111-4111-8111-111111111111',name:'Grupo',revision:1,organizationIds:[]});
 const service={session:async()=>({csrfToken:'fixture-csrf'}),createGroup} as unknown as PlatformService;
 const app=Fastify();await registerPlatformRoutes(app,{service,origin:'https://console.example.test',secureCookies:true});
 const headers={origin:'https://console.example.test',cookie:`platform_session=${'a'.repeat(43)}`,'x-csrf-token':'fixture-csrf','x-platform-reason':'Group fixture setup'};
 try {
  expect((await app.inject({method:'POST',url:'/v1/platform/groups',headers:{...headers,origin:'https://other.test'},payload:{name:'Grupo'}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/platform/groups',headers:{...headers,'x-csrf-token':'wrong'},payload:{name:'Grupo'}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/platform/groups',headers:{...headers,cookie:''},payload:{name:'Grupo'}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/v1/platform/groups',headers,payload:{name:'Grupo',organizationId:'arbitrary'}})).statusCode).toBe(400);
  expect(createGroup).not.toHaveBeenCalled();
  const result=await app.inject({method:'POST',url:'/v1/platform/groups',headers,payload:{name:'Grupo'}});
  expect(result.statusCode).toBe(201);expect(result.headers['cache-control']).toBe('no-store');
 }finally{await app.close();}
});
it.each([
 ['tenant_user_limit',409,'USER_LIMIT_REACHED'],
 ['tenant_organization_active',403,'ORGANIZATION_NOT_ACTIVE'],
] as const)('maps %s to a public operational error',async(constraint,status,code)=>{
 const service={
  async session(){return {csrfToken:'fixture-csrf'};},
  async execute(){throw Object.assign(new Error('private database detail'),{code:'23514',constraint});},
 } as unknown as PlatformService;
 const app=Fastify();await registerPlatformRoutes(app,{service,origin:'https://console.example.test',secureCookies:true});
 try {
  const response=await app.inject({method:'PUT',url:'/v1/platform/organizations/11111111-1111-4111-8111-111111111111/memberships',headers:{
   origin:'https://console.example.test',cookie:`platform_session=${'a'.repeat(43)}`,'x-csrf-token':'fixture-csrf','x-platform-reason':'Support ticket fixture',
  },payload:{email:'member@example.test',role:'OPERATOR',status:'ACTIVE'}});
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({status,code});
  expect(response.body).not.toContain('private database detail');
 }finally{await app.close();}
});
