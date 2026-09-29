import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerPlatformRoutes } from '../../src/http/routes/platform.js';
import type { PlatformService } from '../../src/modules/platform/service.js';
import type { SupportService } from '../../src/modules/support/service.js';

it('requires the administrative cookie, origin and CSRF before a support reply',async()=>{
  const actor='11111111-2222-4333-8444-555555555557',id='11111111-2222-4333-8444-555555555556';
  const service={session:vi.fn(async()=>({csrfToken:'csrf',user:{id:actor,role:'SUPPORT'}}))} as unknown as PlatformService;
  const result={ticket:{id,organizationId:actor,organizationName:'Empresa sintética',title:'Conexão de teste',status:'WAITING_CUSTOMER',revision:2,assigneeId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),firstResponseAt:null,responseDueAt:new Date().toISOString(),resolvedAt:null},messages:[],olderMessagesAvailable:false};
  const support={list:vi.fn(async()=>({data:[]})),reply:vi.fn(async()=>result)} as unknown as SupportService;
  const app=Fastify();await registerPlatformRoutes(app,{service,support,origin:'https://console.example.test',secureCookies:false});
  const headers={cookie:'platform_session='+'a'.repeat(43),origin:'https://console.example.test','x-csrf-token':'csrf'};
  const payload={message:'Vamos verificar o canal.',revision:1,requestId:'11111111-2222-4333-8444-555555555558'},url=`/v1/platform/support/tickets/${id}/replies`;
  try{
    expect((await app.inject('/v1/platform/support/tickets')).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/platform/support/tickets',headers})).statusCode).toBe(200);
    for(const modified of [{...headers,origin:'https://wrong.example.test'},{...headers,'x-csrf-token':'wrong'}])expect((await app.inject({method:'POST',url,headers:modified,payload})).statusCode).toBe(403);
    expect(support.reply).not.toHaveBeenCalled();
    expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(200);
    expect(support.reply).toHaveBeenCalledWith({kind:'PLATFORM',actorId:actor},id,payload);
  }finally{await app.close();}
});
