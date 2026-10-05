import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerPlatformRoutes } from './platform.js';
import type { PlatformService } from '../../modules/platform/service.js';
const id='11111111-1111-4111-8111-111111111111';
const headers={origin:'https://console.example.test',cookie:`platform_session=${'a'.repeat(43)}`,'x-csrf-token':'fixture-csrf','x-platform-reason':'Reset existing user password'};
it('guards dedicated password reset against tenant credentials, CSRF, origin and invalid payloads',async()=>{
 const resetUserPassword=vi.fn().mockResolvedValue({ok:true});
 const previewUserPasswordReset=vi.fn().mockResolvedValue({userId:id,email:'person@example.test',status:'ACTIVE',confirmationToken:'fixture',organizations:[]});
 const service={session:async()=>({csrfToken:'fixture-csrf'}),resetUserPassword,previewUserPasswordReset} as unknown as PlatformService;
 const app=Fastify();await registerPlatformRoutes(app,{service,origin:headers.origin,secureCookies:true});
 const url=`/v1/platform/users/${id}/password-reset`,payload={password:'synthetic-password-only',confirmationEmail:'person@example.test',confirmationToken:'fixture'};
 try {
  for(const h of [{...headers,cookie:'',authorization:'Bearer tenant'},{...headers,cookie:'','x-jrc-api-key':'tenant-key'},{...headers,'x-csrf-token':'wrong'},{...headers,origin:'https://evil.test'}]){
   expect([401,403]).toContain((await app.inject({method:'POST',url,headers:h,payload})).statusCode);
  }
  for(const invalid of [{...payload,password:'short'},{...payload,password:'x'.repeat(257)},{...payload,organizationId:id},{password:payload.password}]){
   const result=await app.inject({method:'POST',url,headers,payload:invalid});expect(result.statusCode).toBe(400);expect(result.body).not.toContain(payload.password);
  }
  expect(resetUserPassword).not.toHaveBeenCalled();
  const preview=await app.inject({url:`${url}-preview`,headers});expect(preview.statusCode).toBe(200);expect(preview.headers['cache-control']).toBe('no-store');
  const result=await app.inject({method:'POST',url,headers,payload});expect(result.statusCode).toBe(200);expect(result.json()).toEqual({ok:true});expect(result.body).not.toContain(payload.password);
  expect(resetUserPassword).toHaveBeenCalledWith('a'.repeat(43),headers['x-platform-reason'],id,payload);
 }finally{await app.close();}
});
