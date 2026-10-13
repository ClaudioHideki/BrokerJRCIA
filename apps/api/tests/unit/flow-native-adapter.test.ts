import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createNativeFlowAdapter} from '../../src/modules/flows/delegation/native-adapter.js';
const context={organizationId:randomUUID(),origin:'https://native.example.test'};
const request={nonce:randomUUID(),externalActorId:'21',accountId:7,destinationRevision:3,inboxIds:[9]};
const decision={...request,accountActive:true,member:true,featureEnabled:true,role:'agent'};
function fixture(){
 let registration:any={...context,accountId:7,destinationRevision:3,revision:1,callbackCredential:'k'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()};
 const resolveRegistration=vi.fn(async()=>registration),fetch=vi.fn(async()=>Response.json(decision));
 const adapter=createNativeFlowAdapter({resolveRegistration,fetch,timeoutMs:100});
 return {adapter,fetch,resolveRegistration,setRegistration:(value:any)=>{registration=value;}};
}
it('makes exactly one bounded authenticated POST to the registered host using unchanged P9 schemas',async()=>{
 const h=fixture();expect(await h.adapter.introspect(request,context,new AbortController().signal)).toEqual(decision);
 expect(h.fetch).toHaveBeenCalledOnce();const [url,init]=h.fetch.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe(context.origin+'/api/v1/jrc_flow_native/introspect');expect(init).toMatchObject({method:'POST',redirect:'error',credentials:'omit',headers:{authorization:'Bearer '+'k'.repeat(43)}});expect(JSON.parse(String(init.body))).toEqual(request);
 expect(h.resolveRegistration).toHaveBeenCalledTimes(2);
});
it('rejects foreign registration context before any network request',async()=>{
 const h=fixture();h.setRegistration({...context,organizationId:randomUUID(),accountId:7,destinationRevision:3,revision:1,callbackCredential:'k'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()});
 await expect(h.adapter.introspect(request,context,new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_AUTHORITY_UNAVAILABLE'});expect(h.fetch).not.toHaveBeenCalled();
});
it.each([302,404,500])('does not retry or follow an unsuccessful callback status %s',async status=>{
 const h=fixture();h.fetch.mockResolvedValueOnce(new Response('private-host-canary',{status,headers:{location:'https://foreign.example.test'}}));
 await expect(h.adapter.introspect(request,context,new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_AUTHORITY_UNAVAILABLE'});expect(h.fetch).toHaveBeenCalledOnce();
});
it('rejects response drift and extra authority fields',async()=>{
 const h=fixture();for(const value of [{...decision,inboxIds:[10]},{...decision,nonce:randomUUID()},{...decision,capabilities:['flow:bind']}]){
  h.fetch.mockResolvedValueOnce(Response.json(value));await expect(h.adapter.introspect(request,context,new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_AUTHORITY_UNAVAILABLE'});
 }
});
it('refuses oversized and interrupted response bodies without retry',async()=>{
 const h=fixture();h.fetch.mockResolvedValueOnce(new Response('x'.repeat(16385)));
 await expect(h.adapter.introspect(request,context,new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_AUTHORITY_UNAVAILABLE'});expect(h.fetch).toHaveBeenCalledOnce();
});
it('times out a stalled response and ignores late fetch completion',async()=>{
 const h=fixture();h.fetch.mockImplementationOnce(()=>new Promise(()=>{}));
 await expect(h.adapter.introspect(request,context,new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_AUTHORITY_UNAVAILABLE'});expect(h.fetch).toHaveBeenCalledOnce();
});
it('revalidates registration after I/O and refuses its revocation',async()=>{
 const h=fixture();h.fetch.mockImplementationOnce(async()=>{h.setRegistration(null);return Response.json(decision);});
 await expect(h.adapter.introspect(request,context,new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_AUTHORITY_UNAVAILABLE'});
});
it('does not dispatch with an already aborted caller signal',async()=>{
 const h=fixture(),controller=new AbortController();controller.abort();
 await expect(h.adapter.introspect(request,context,controller.signal)).rejects.toMatchObject({code:'FLOW_HOST_AUTHORITY_UNAVAILABLE'});expect(h.fetch).not.toHaveBeenCalled();
});
it('never manufactures fence/observe proof while eleven-path host protocol is missing',async()=>{
 const h=fixture();await expect(h.adapter.fenceAndDrain({},new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_FENCE_REQUIRED'});
 await expect(h.adapter.observeFence({},new AbortController().signal)).rejects.toMatchObject({code:'FLOW_HOST_FENCE_REQUIRED'});expect(h.fetch).not.toHaveBeenCalled();
});
