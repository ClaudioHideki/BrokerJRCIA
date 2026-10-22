import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { normalizeWebhookUrl, signPartnerEvent, createPartnerEventWorker, retryDelayMs } from './worker.js';

describe('partner webhook delivery', () => {
 it('accepts HTTPS paths but rejects credential, IP, port and local targets', () => {
  expect(normalizeWebhookUrl('https://partner.example/hooks/broker')).toBe('https://partner.example/hooks/broker');
  for(const url of ['http://partner.example/x','https://127.0.0.1/x','https://localhost/x','https://a.internal/x','https://u:p@partner.example/x','https://partner.example:8443/x','https://partner.example/x?token=secret']) expect(()=>normalizeWebhookUrl(url)).toThrow();
 });
 it('signs the exact body, timestamp and immutable event identifier', () => {
  const body='{"eventId":"e1"}';
  expect(signPartnerEvent('secret','e1','123',body)).toBe('sha256='+createHmac('sha256','secret').update('123.e1.'+body).digest('hex'));
  expect(signPartnerEvent('secret','e2','123',body)).not.toBe(signPartnerEvent('secret','e1','123',body));
 });
 it('retries with a bounded exponential backoff',()=>{
  expect(retryDelayMs(1)).toBe(1000); expect(retryDelayMs(4)).toBe(8000); expect(retryDelayMs(10)).toBe(300000);
 });
 it('keeps event identity stable and records failed delivery without sending a message',async()=>{
  const settle=vi.fn(), send=vi.fn().mockResolvedValue(new Response('',{status:503}));
  const claim={deliveryId:'d1',endpointId:'p1',eventId:'e1',organizationId:'o1',url:'https://partner.example/hooks',encryptedSecret:'encrypted',attempts:0,envelope:{eventId:'e1',type:'message.received'}};
  const worker=createPartnerEventWorker({transact:async(_org,work)=>work({} as never),claim:async()=>claim,authorize:async()=>true,settle,openSecret:()=> 'secret',send,now:()=>new Date('2026-10-22T16:00:00Z')});
  expect(await worker.processOne('o1')).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]![1].headers['x-jrc-event-id']).toBe('e1');
  expect(settle).toHaveBeenCalledWith(expect.anything(),claim,{status:'PENDING',attempts:1,errorCode:'HTTP_503',delayMs:1000});
 });
 it('marks permanent client failures terminal, but retries throttling',async()=>{
  for(const [status,expected] of [[400,'FAILED'],[429,'PENDING'],[302,'FAILED']] as const){
   const settle=vi.fn();
   const worker=createPartnerEventWorker({transact:async(_org,work)=>work({} as never),claim:async()=>({deliveryId:'d',endpointId:'p',eventId:'e',organizationId:'o',url:'https://partner.example/x',encryptedSecret:'x',attempts:0,envelope:{eventId:'e'}}),authorize:async()=>true,settle,openSecret:()=> 's',send:async()=>new Response(null,{status})});
   await worker.processOne('o'); expect(settle.mock.calls[0]![2].status).toBe(expected);
  }
 });
 it('does not hold a database transaction during external HTTP and revalidates before dispatch',async()=>{
  let inTransaction=false;const send=vi.fn(async()=>{expect(inTransaction).toBe(false);return new Response(null,{status:200});});
  const authorize=vi.fn(async()=>true),settle=vi.fn();
  const worker=createPartnerEventWorker({transact:async(_org,work)=>{inTransaction=true;try{return await work({} as never);}finally{inTransaction=false;}},claim:async()=>({deliveryId:'d',endpointId:'p',eventId:'e',organizationId:'o',url:'https://partner.example/x',encryptedSecret:'x',attempts:0,envelope:{eventId:'e'}}),authorize,settle,openSecret:()=> 's',send});
  await worker.processOne('o');expect(authorize).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce();
 });
 it('does not send a revoked endpoint after claiming work',async()=>{
  const send=vi.fn(),settle=vi.fn();
  const worker=createPartnerEventWorker({transact:async(_org,work)=>work({} as never),claim:async()=>({deliveryId:'d',endpointId:'p',eventId:'e',organizationId:'o',url:'https://partner.example/x',encryptedSecret:'x',attempts:0,envelope:{eventId:'e'}}),authorize:async()=>false,settle,openSecret:()=> 's',send});
  await worker.processOne('o');expect(send).not.toHaveBeenCalled();
 });
});
