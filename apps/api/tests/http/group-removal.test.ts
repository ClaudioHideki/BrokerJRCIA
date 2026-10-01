import Fastify from 'fastify';
import { expect,it,vi } from 'vitest';
import { registerPlatformRoutes } from '../../src/http/routes/platform.js';
const id='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
const headers={origin:'https://console.example.test',cookie:`platform_session=${'a'.repeat(43)}`,'x-csrf-token':'csrf'};
it('protects group selection and cleanup reconciliation with current platform role, origin and CSRF',async()=>{
  let role='SUPER_ADMIN';
  const requestReconciliation=vi.fn(async()=>({operationId:id,status:'REQUESTED'})),preview=vi.fn();
  const app=Fastify();await registerPlatformRoutes(app,{service:{session:async()=>({user:{id:actor,role},csrfToken:'csrf'})} as never,
    lifecycle:{groups:{preview},requestReconciliation} as never,origin:headers.origin,secureCookies:true});
  try{
    const endpoint=`/v1/platform/organizations/${id}/deletion/${id}/reconcile`;
    for(const bad of [{...headers,origin:'https://wrong.test'},{...headers,'x-csrf-token':'wrong'},{...headers,cookie:''}])
      expect((await app.inject({method:'POST',url:endpoint,headers:bad,payload:{reason:'Conferir remoção'}})).statusCode).toBeGreaterThanOrEqual(400);
    role='SUPPORT';expect((await app.inject({method:'POST',url:endpoint,headers,payload:{reason:'Conferir remoção'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:`/v1/platform/groups/${id}/company-removal-preview`,headers,payload:{reason:'Conferir empresas'}})).statusCode).toBe(403);
    expect(preview).not.toHaveBeenCalled();expect(requestReconciliation).not.toHaveBeenCalled();
    role='SUPER_ADMIN';const result=await app.inject({method:'POST',url:endpoint,headers,payload:{reason:'Conferir remoção'}});
    expect(result.statusCode).toBe(202);expect(requestReconciliation).toHaveBeenCalledWith(id,id,id,'Conferir remoção','PLATFORM',actor);
    expect(result.headers['cache-control']).toBe('no-store');
  }finally{await app.close();}
});
