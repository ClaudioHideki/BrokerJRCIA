import {describe,expect,it,vi} from 'vitest';
import {createAutomationSafeHttp} from '../../src/modules/automation-integrations/safe-http.js';
describe('automation HTTP SSRF boundary',()=>{
 it('does not start another DNS request after cancellation during redirect cleanup',async()=>{
  const controller=new AbortController(),clock=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
  const resolve=vi.fn(async()=>['8.8.8.8']);
  const connect=vi.fn(async()=>new Response(new ReadableStream({cancel(){controller.abort();}}),{status:302,headers:{location:'https://next.example'}}));
  try{
   await expect(createAutomationSafeHttp({resolve,connect})({method:'GET',url:'https://one.example'})).rejects.toThrow('AUTOMATION_HTTP_TIMEOUT');
   expect(resolve).toHaveBeenCalledTimes(1);
  }finally{clock.mockRestore();}
 });
 it.each([302,303,307,308])('never forwards arbitrary secret headers or payload to another origin (%s)',async status=>{
  const connect=vi.fn().mockResolvedValueOnce(new Response(null,{status,headers:{location:'https://other.example/path'}})).mockResolvedValue(new Response('ok'));
  const execute=createAutomationSafeHttp({resolve:async()=>['8.8.8.8'],connect});
  await expect(execute({method:'POST',url:'https://one.example/path',headers:{'X-Customer-Secret':'canary'},body:'sensitive'})).rejects.toThrow('AUTOMATION_HTTP_CROSS_ORIGIN_REDIRECT');
  expect(connect).toHaveBeenCalledTimes(1);
 });
 it('bounds DNS resolution by the request deadline',async()=>{
  const connect=vi.fn(),execute=createAutomationSafeHttp({resolve:()=>new Promise(()=>{}),connect});
  await expect(execute({method:'GET',url:'https://slow.example',timeoutMs:15})).rejects.toThrow('AUTOMATION_HTTP_TIMEOUT');
  expect(connect).not.toHaveBeenCalled();
 });
 it.each(['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.2','::1'])("rejects private or metadata address %s",async address=>{const execute=createAutomationSafeHttp({resolve:async()=>[address],connect:vi.fn()});await expect(execute({method:'GET',url:'https://example.test/data'})).rejects.toThrow('AUTOMATION_HTTP_SSRF_REJECTED');});
 it('pins public DNS and strips credentials on a cross-origin redirect',async()=>{const connect=vi.fn(async(input)=>input.target.hostname==='one.example'?new Response(null,{status:302,headers:{location:'https://two.example/result'}}):new Response('ok',{status:200}));const execute=createAutomationSafeHttp({resolve:async()=>['8.8.8.8'],connect});const result=await execute({method:'GET',url:'https://one.example/start',headers:{authorization:'Bearer canary'}});expect(result.body).toBe('ok');expect(connect).toHaveBeenCalledTimes(2);expect(connect.mock.calls[1]![0].headers.authorization).toBeUndefined();expect(connect.mock.calls[1]![0].approvedAddresses).toEqual(['8.8.8.8']);});
 it('enforces https, allowlist, header and response limits',async()=>{const connect=vi.fn(async()=>new Response('x'.repeat(20),{status:200})),execute=createAutomationSafeHttp({resolve:async()=>['8.8.8.8'],connect});await expect(execute({method:'GET',url:'http://example.test'})).rejects.toThrow('AUTOMATION_HTTP_URL_REJECTED');await expect(execute({method:'GET',url:'https://example.test',allowedOrigins:['https://approved.test']})).rejects.toThrow('AUTOMATION_HTTP_ORIGIN_NOT_ALLOWED');await expect(execute({method:'GET',url:'https://example.test',headers:{host:'evil'}})).rejects.toThrow('AUTOMATION_HTTP_HEADER_REJECTED');await expect(execute({method:'GET',url:'https://example.test',maxResponseBytes:10})).rejects.toThrow('AUTOMATION_HTTP_RESPONSE_LIMIT');});
 it('retries only idempotent GET requests within the declared cap',async()=>{const connect=vi.fn().mockResolvedValueOnce(new Response('unavailable',{status:503})).mockResolvedValueOnce(new Response('ok',{status:200})),execute=createAutomationSafeHttp({resolve:async()=>['8.8.8.8'],connect});expect((await execute({method:'GET',url:'https://example.test',retryAttempts:1})).body).toBe('ok');expect(connect).toHaveBeenCalledTimes(2);});
});
