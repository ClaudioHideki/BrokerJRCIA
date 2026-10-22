// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountQRCodePanel } from '../panel.mjs';
const ID='11111111-1111-4111-8111-111111111111',PROVIDER='33333333-3333-4333-8333-333333333333';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rGQAAAAASUVORK5CYII=';
const instance={id:ID,name:'<img src=x onerror=alert(1)>',provider:'BAILEYS',status:'DISCONNECTED'};
const panels=[];
afterEach(()=>{panels.splice(0).forEach(panel=>panel.destroy());document.body.replaceChildren();vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
async function harness(mutate,options={}){
 const requests=[];
 vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
  requests.push({url:String(url),init});
  if(init.method==='POST')return mutate?mutate(url,init):Response.json({instance,pending:false,reconciliationRequired:false,operationId:null,action:{type:'NONE',reason:'ALREADY_CONNECTED'}});
  if(String(url).endsWith('/providers'))return Response.json({data:[{id:PROVIDER,name:'Authorized QR engine',provider:'BAILEYS'}],pageInfo:{hasNextPage:false,nextCursor:null}});
  if(String(url).includes('/status'))return Response.json(instance);
  return Response.json({data:[instance],pageInfo:{hasNextPage:false,nextCursor:null}});
 }));
 const container=document.createElement('div');document.body.append(container);
 const panel=mountQRCodePanel(container,{apiBase:'/host/jrc-qr',csrfToken:()=> 'host-csrf',...options});panels.push(panel);await panel.ready;return {container,panel,requests};
}
async function click(container,label){const button=[...container.querySelectorAll('button')].find(button=>button.textContent===label);expect(button,label).toBeDefined();button.click();await vi.waitFor(()=>expect(button.disabled).toBe(false));}
it('rejects external or protocol-relative apiBase configuration',()=>{
 for(const apiBase of ['https://evil.example/qr','//evil.example/qr','/../qr','/qr?key=x'])expect(()=>mountQRCodePanel(document.createElement('div'),{apiBase})).toThrow();
});
it('uses same-origin host session requests and renders untrusted names as text',async()=>{
 const h=await harness();expect(h.container.textContent).toContain(instance.name);expect(h.container.querySelector('img')).toBeNull();
 expect(h.requests.every(row=>row.url.startsWith('/host/jrc-qr/')&&row.init.credentials==='same-origin')).toBe(true);
 expect(JSON.stringify(h.requests)).not.toContain('x-jrc-api-key');
});
it('uses the selected provider and forwards a fresh operation key and host CSRF token',async()=>{
 const h=await harness();const name=h.container.querySelector('input[name=name]');name.value='New QR';name.dispatchEvent(new Event('input',{bubbles:true}));
 h.container.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 await vi.waitFor(()=>expect(h.requests.some(row=>row.init.method==='POST')).toBe(true));const request=h.requests.find(row=>row.init.method==='POST');
 expect(JSON.parse(request.init.body)).toEqual({name:'New QR',providerAccountId:PROVIDER});expect(request.init.headers['x-csrf-token']).toBe('host-csrf');expect(request.init.headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/u);
});
it('renders a validated PNG challenge and erases it on destruction',async()=>{
 const h=await harness(()=>Response.json({instance,pending:false,reconciliationRequired:false,action:{type:'QR_CODE',encoding:'DATA_URL',value:'data:image/png;base64,'+PNG,expiresAt:new Date(Date.now()+60000).toISOString()}}));
 await click(h.container,'Parear');expect(h.container.querySelector('img')?.src).toBe('data:image/png;base64,'+PNG);h.panel.destroy();expect(h.container.childElementCount).toBe(0);
});
it.each(['https://evil.example/qr','data:image/svg+xml,<svg onload=alert(1)>'])('never embeds an arbitrary action URL %s',async value=>{
 const h=await harness(()=>Response.json({instance,pending:false,reconciliationRequired:false,action:{type:'QR_CODE',encoding:'DATA_URL',value,expiresAt:new Date(Date.now()+60000).toISOString()}}));
 await click(h.container,'Parear');expect(h.container.querySelector('img')).toBeNull();expect(h.container.textContent).toMatch(/inválido|inseguro/u);
});
it('never navigates a redirect action and requires explicit disconnection confirmation',async()=>{
 const h=await harness(()=>Response.json({instance,pending:false,reconciliationRequired:false,action:{type:'REDIRECT',url:'https://evil.example',expiresAt:new Date(Date.now()+60000).toISOString()}}));
 await click(h.container,'Reconectar');expect(h.container.querySelector('a')).toBeNull();expect(h.container.textContent).toMatch(/não suportada/u);
 expect([...h.container.querySelectorAll('button')].find(button=>button.textContent==='Desconectar').disabled).toBe(true);
});
it('requires explicit disconnection confirmation before posting',async()=>{
 const h=await harness();vi.spyOn(window,'confirm').mockReturnValue(false);const before=h.requests.length;await click(h.container,'Desconectar');expect(h.requests).toHaveLength(before);
});
it('bounds status polling and stops requesting after cleanup',async()=>{
 const h=await harness(()=>Response.json({instance,pending:true,reconciliationRequired:false,action:{type:'NONE',reason:'CONNECTION_PENDING'}}),{pollIntervalMs:1000,maxPolls:2});
 vi.useFakeTimers();await click(h.container,'Parear');await vi.advanceTimersByTimeAsync(3000);
 expect(h.requests.filter(row=>row.url.endsWith('/status'))).toHaveLength(2);expect(h.container.textContent).toMatch(/limite de consultas/u);
 h.panel.destroy();const count=h.requests.length;await vi.advanceTimersByTimeAsync(10000);expect(h.requests).toHaveLength(count);
});
it('reuses the same idempotency key after an unconfirmed mutation instead of inventing a new send intent',async()=>{
 const h=await harness(()=>{throw new Error('Network outcome unknown');});
 await click(h.container,'Parear');await click(h.container,'Parear');const keys=h.requests.filter(row=>row.init.method==='POST').map(row=>row.init.headers['idempotency-key']);
 expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(h.container.textContent).toMatch(/não foi confirmada/u);
});
it('erases expired QR challenges without issuing another connect command',async()=>{
 const h=await harness(()=>Response.json({instance,pending:false,reconciliationRequired:false,action:{type:'QR_CODE',encoding:'DATA_URL',value:'data:image/png;base64,'+PNG,expiresAt:new Date(Date.now()+1000).toISOString()}}));
 vi.useFakeTimers();await click(h.container,'Parear');expect(h.container.querySelector('img')).not.toBeNull();await vi.advanceTimersByTimeAsync(1500);
 expect(h.container.querySelector('img')).toBeNull();expect(h.requests.filter(row=>row.init.method==='POST')).toHaveLength(1);expect(h.container.textContent).toMatch(/expirou/u);
});
it('aborts pending host requests and discards their results on unmount',async()=>{
 const signals=[];vi.stubGlobal('fetch',(_url,init)=>new Promise((_,reject)=>{signals.push(init.signal);init.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true});}));
 const container=document.createElement('div');document.body.append(container);const panel=mountQRCodePanel(container,{apiBase:'/host/jrc-qr'});panels.push(panel);
 expect(signals).toHaveLength(2);panel.destroy();await panel.ready;expect(signals.every(signal=>signal.aborted)).toBe(true);expect(container.childElementCount).toBe(0);
});
it('confirms an asynchronous disconnection through status and then permits explicit reconnection',async()=>{
 const h=await harness(()=>Response.json({instance:{...instance,status:'DISCONNECTING'},pending:true,reconciliationRequired:false,operationId:ID}));
 vi.spyOn(window,'confirm').mockReturnValue(true);vi.useFakeTimers();
 const button=[...h.container.querySelectorAll('button')].find(button=>button.textContent==='Desconectar');button.click();
 await vi.waitFor(()=>expect(h.requests.some(row=>row.init.method==='POST')).toBe(true));await vi.advanceTimersByTimeAsync(5000);
 expect(h.container.textContent).toMatch(/Desconexão confirmada/u);
 expect([...h.container.querySelectorAll('button')].find(button=>button.textContent==='Reconectar').disabled).toBe(false);
 expect(h.requests.filter(row=>row.init.method==='POST')).toHaveLength(1);
});
