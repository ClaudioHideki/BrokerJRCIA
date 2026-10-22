import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createPartnerQrHandler } from '../backend.mjs';
import { assertPublicAddresses } from '../safe-http.mjs';

const ID='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const PROVIDER='33333333-3333-4333-8333-333333333333', KEY='synthetic-server-only-tenant-key-32';
const instance={id:ID,name:'Synthetic QR',provider:'BAILEYS',status:'DISCONNECTED',organizationId:OTHER,providerAccountId:PROVIDER};
const grant={allow:true,tenantRef:'host-account-7',allowedInstanceIds:[ID],allowedProviderAccountIds:[PROVIDER]};
const servers=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
async function serve(handler){const server=createServer(handler);servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function harness(options={}){
 const calls=[];
 const upstream=await serve(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  calls.push({url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()});
  const result=options.respond?.(req)??(req.url.startsWith('/v1/provider-accounts')?{data:[{id:PROVIDER,name:'QR engine',provider:'BAILEYS'}],pageInfo:{hasNextPage:false,nextCursor:null}}:
   req.method==='POST'?{instance,operationId:null,pending:false,replayed:false,reconciliationRequired:false,action:{type:'NONE',reason:'NO_USER_ACTION_REQUIRED'}}:
   req.url.startsWith('/v1/instances?')?{data:[instance,{...instance,id:OTHER}],pageInfo:{hasNextPage:false,nextCursor:null}}:instance);
  res.writeHead(options.status??200,{'content-type':'application/json',...(options.headers??{})});res.end(JSON.stringify(result));
 });
 const authorize=options.authorize??vi.fn(async(req)=>({...grant,csrfVerified:req.headers['x-csrf-token']==='host-csrf'}));
 const resolveCredentials=vi.fn(async()=>({apiKey:KEY}));
 const host=await serve(createPartnerQrHandler({brokerOrigin:'https://broker.example.test',authorize,resolveCredentials,
  transport:(url,init)=>fetch(upstream+new URL(url).pathname+new URL(url).search,init),...options.handler}));
 return {host,calls,authorize,resolveCredentials};
}
const post=(body={},extra={})=>({method:'POST',headers:{'content-type':'application/json','x-csrf-token':'host-csrf','idempotency-key':'host-operation-1',...extra},body:JSON.stringify(body)});
it('requires host authentication and server credential resolvers and rejects unsafe fixed origins',()=>{
 expect(()=>createPartnerQrHandler({brokerOrigin:'https://broker.example.test'})).toThrow();
 for(const brokerOrigin of ['http://broker.example.test','https://127.0.0.1','https://broker.example.test/path','https://user:pass@broker.example.test','https://broker.example.test?url=x']){
  expect(()=>createPartnerQrHandler({brokerOrigin,authorize:async()=>null,resolveCredentials:async()=>({apiKey:KEY})})).toThrow();
 }
});
it('denies absent authorization and denies mutations without host-verified CSRF before any upstream request',async()=>{
 const h=await harness({authorize:async()=>null});expect((await fetch(h.host+'/jrc-qr/instances')).status).toBe(403);expect(h.calls).toHaveLength(0);expect(h.resolveCredentials).not.toHaveBeenCalled();
 const missingCsrf=await harness();expect((await fetch(missingCsrf.host+'/jrc-qr/instances/'+ID+'/pair',post({}, {'x-csrf-token':''}))).status).toBe(403);expect(missingCsrf.calls).toHaveLength(0);
});
it('projects tenant-scoped authorized QR lists without keys or organization identifiers',async()=>{
 const h=await harness();const response=await fetch(h.host+'/jrc-qr/instances');expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({data:[{id:ID,name:'Synthetic QR',status:'DISCONNECTED'}]});
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(h.calls[0].headers['x-jrc-api-key']).toBe(KEY);expect(h.calls[0].headers.cookie).toBeUndefined();
 const result=await (await fetch(h.host+'/jrc-qr/instances')).text();expect(result).not.toContain(KEY);expect(result).not.toContain('organizationId');expect(result).not.toContain(OTHER);
});
it('gets QR provider choices through the actual provider accounts contract and creates only BAILEYS with forwarded idempotency',async()=>{
 const h=await harness();expect((await fetch(h.host+'/jrc-qr/providers')).status).toBe(200);expect(h.calls[0].url).toContain('/v1/provider-accounts?provider=BAILEYS');
 expect((await fetch(h.host+'/jrc-qr/instances',post({name:'New QR',providerAccountId:PROVIDER}))).status).toBe(200);
 expect(JSON.parse(h.calls.at(-1).body)).toEqual({name:'New QR',provider:'BAILEYS',providerAccountId:PROVIDER});expect(h.calls.at(-1).headers['idempotency-key']).toBe('host-operation-1');
});
it.each(['pair','reconnect','disconnect'])('allows only authorized instance %s and performs no arbitrary proxying',async operation=>{
 const h=await harness();expect((await fetch(h.host+'/jrc-qr/instances/'+ID+'/'+operation,post())).status).toBe(200);
 expect(h.calls.at(-1).url).toBe('/v1/instances/'+ID+'/'+(operation==='disconnect'?'disconnect':'connect'));
 expect((await fetch(h.host+'/jrc-qr/instances/'+OTHER+'/'+operation,post())).status).toBe(403);
});
it.each([
 ['/instances',{name:'x',providerAccountId:PROVIDER,organizationId:OTHER}],
 ['/instances',{name:'x',providerAccountId:PROVIDER,brokerOrigin:'https://evil.example'}],
 ['/instances/'+ID+'/pair',{url:'https://evil.example'}],
 ['/instances/'+ID+'/disconnect',{apiKey:'injected'}],
 ['/instances',{name:42,providerAccountId:PROVIDER}],
 ['/instances/'+ID+'/pair',{pairingHint:42}],
])('rejects body overrides %s before upstream I/O',async(path,body)=>{
 const h=await harness();expect((await fetch(h.host+'/jrc-qr'+path,post(body))).status).toBe(400);expect(h.calls).toHaveLength(0);
});
it('requires the actual host CSRF header even if a host integration mistakenly returns verified without it',async()=>{
 const h=await harness({authorize:async()=>({...grant,csrfVerified:true})});
 expect((await fetch(h.host+'/jrc-qr/instances/'+ID+'/pair',post({}, {'x-csrf-token':''}))).status).toBe(403);expect(h.calls).toHaveLength(0);
});
it('rejects unknown routes, query overrides, absent idempotency, oversized JSON and invalid provider selection',async()=>{
 const h=await harness();
 expect((await fetch(h.host+'/jrc-qr/proxy?url=https://evil.example')).status).toBe(404);
 expect((await fetch(h.host+'/jrc-qr/instances?organizationId='+OTHER)).status).toBe(400);
 expect((await fetch(h.host+'/jrc-qr/instances/'+ID+'/pair',post({}, {'idempotency-key':''}))).status).toBe(400);
 expect((await fetch(h.host+'/jrc-qr/instances',post({name:'x'.repeat(10000),providerAccountId:PROVIDER}))).status).toBe(413);
 expect((await fetch(h.host+'/jrc-qr/instances',post({name:'x',providerAccountId:OTHER}))).status).toBe(403);expect(h.calls).toHaveLength(0);
});
it('does not follow redirects or relay upstream diagnostics and secrets',async()=>{
 const h=await harness({status:302,headers:{location:'https://evil.example'},respond:()=>({detail:KEY})});
 const response=await fetch(h.host+'/jrc-qr/instances');expect(response.status).toBe(502);expect(await response.text()).not.toContain(KEY);expect(h.calls).toHaveLength(1);
});
it('rejects private, mapped-private and mixed DNS answers',()=>{
 for(const addresses of [['127.0.0.1'],['10.1.2.3'],['169.254.169.254'],['::1'],['::ffff:127.0.0.1'],['8.8.8.8','192.168.1.1']])expect(()=>assertPublicAddresses(addresses)).toThrow();
 expect(()=>assertPublicAddresses(['8.8.8.8'])).not.toThrow();
});
it('does not relay host or transport exception diagnostics even when they resemble adapter errors',async()=>{
 const h=await harness({authorize:async()=>{throw Object.assign(new Error(KEY),{status:500,code:KEY});}});
 const response=await fetch(h.host+'/jrc-qr/instances');expect(response.status).toBe(502);expect(await response.text()).not.toContain(KEY);
});
it('times out a nonresponsive trusted transport without starting another operation',async()=>{
 const h=await harness({handler:{timeoutMs:100,transport:()=>new Promise(()=>{})}});
 const response=await fetch(h.host+'/jrc-qr/instances');expect(response.status).toBe(504);expect(await response.json()).toMatchObject({code:'BROKER_TIMEOUT'});
});
it('rejects oversized upstream responses without exposing their contents',async()=>{
 const h=await harness({respond:()=>({data:'x'.repeat(2_100_100)})});const response=await fetch(h.host+'/jrc-qr/instances');
 expect(response.status).toBe(502);expect((await response.text()).length).toBeLessThan(500);
});
it('rejects non-QR instance mutations before their provider command',async()=>{
 const h=await harness({respond:()=>({...instance,provider:'META'})});
 expect((await fetch(h.host+'/jrc-qr/instances/'+ID+'/pair',post())).status).toBe(502);expect(h.calls).toHaveLength(1);expect(h.calls[0].method).toBe('GET');
});
