
import Fastify from 'fastify';
import {it,expect,vi} from 'vitest';
import {registerPlatformRoutes} from '../../src/http/routes/platform.js';
import {PlatformError,type PlatformService} from '../../src/modules/platform/service.js';
import type {ChannelFacade} from '../../src/modules/channels/facade.js';
it('requires platform auth, CSRF, reason and audited authority for tenant channel management',async()=>{
 const org='11111111-2222-4333-8444-555555555555',id='11111111-2222-4333-8444-555555555556',actor='11111111-2222-4333-8444-555555555557';let support=false;
 const service={session:vi.fn(async()=>({csrfToken:'csrf',user:{id:actor}})),authorizeChannels:vi.fn(async(_t:string,_r:string,_o:string,write:boolean)=>{if(support&&write)throw new PlatformError(403,'PLATFORM_FORBIDDEN');return actor;})} as unknown as PlatformService;
 const channels={list:vi.fn(async()=>({data:[]})),setArchived:vi.fn(async()=>({ok:true}))} as unknown as ChannelFacade;
 const app=Fastify();await registerPlatformRoutes(app,{service,origin:'https://console.example.test',secureCookies:false,channels});
 const headers={cookie:'platform_session='+ 'a'.repeat(43),origin:'https://console.example.test','x-csrf-token':'csrf','x-platform-reason':'Review customer registration'};
 try{
  expect((await app.inject({method:'GET',url:'/v1/platform/organizations/'+org+'/channels',headers})).statusCode).toBe(200);
  expect(channels.list).toHaveBeenCalledWith(org,true);
  const url='/v1/platform/organizations/'+org+'/channels/'+id+'/archive';
  expect((await app.inject({method:'POST',url,headers:{...headers,'x-csrf-token':'wrong'},payload:{archived:true}})).statusCode).toBe(403);
  support=true;expect((await app.inject({method:'POST',url,headers,payload:{archived:true}})).statusCode).toBe(403);expect(channels.setArchived).not.toHaveBeenCalled();
  support=false;expect((await app.inject({method:'POST',url,headers,payload:{archived:true}})).statusCode).toBe(200);
  expect(channels.setArchived).toHaveBeenCalledWith(org,id,true,undefined,actor);
  expect(service.authorizeChannels).toHaveBeenCalledWith('a'.repeat(43),'Review customer registration',org,true);
 }finally{await app.close();}
});
