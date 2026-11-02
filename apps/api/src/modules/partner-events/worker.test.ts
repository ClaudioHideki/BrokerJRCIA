import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { normalizeWebhookUrl, signPartnerEvent, createPartnerEventWorker, retryDelayMs, settleDelivery,type DeliveryClaim } from './worker.js';
import {readPartnerPersistenceReceipt} from './ack-contract.js';

describe('partner webhook delivery', () => {
 const receiptClaim={deliveryId:'00000000-0000-4000-8000-000000000001',endpointId:'00000000-0000-4000-8000-000000000002',eventId:'00000000-0000-4000-8000-000000000003',organizationId:'00000000-0000-4000-8000-000000000004',url:'https://partner.example/hooks',encryptedSecret:'encrypted',attempts:0,envelope:{eventId:'e'},ackMode:'PERSISTENCE_RECEIPT_V1' as const,leaseToken:'lease'};
 const receipt={schemaVersion:1 as const,contract:'PERSISTENCE_RECEIPT_V1' as const,eventId:receiptClaim.eventId,deliveryId:receiptClaim.deliveryId,organizationId:receiptClaim.organizationId,endpointId:receiptClaim.endpointId,receiptId:'00000000-0000-4000-8000-000000000005',persistedAt:'2026-11-01T00:00:00.000Z'};
 async function deliver(response:Response,claim:DeliveryClaim=receiptClaim){const settle=vi.fn();const send=vi.fn<typeof globalThis.fetch>(async()=>response);await createPartnerEventWorker({transact:async(_org,work)=>work({} as never),claim:async()=>claim,authorize:async()=>true,settle,openSecret:()=> 'secret',send}).processOne(claim.organizationId);return {result:settle.mock.calls[0]![2],send};}
 it.each([200,202,204])('keeps legacy HTTP %s acceptance without requiring a body',async status=>{
  const result=await deliver(new Response(null,{status}),{...receiptClaim,ackMode:'HTTP'});expect(result.result.status).toBe('DELIVERED');expect(result.result).not.toHaveProperty('receipt');
 });
 it.each([new Response('<html>login</html>',{status:200,headers:{'content-type':'text/html'}}),new Response('<html>login</html>',{status:200,headers:{'content-type':'application/json'}}),new Response(null,{status:204}),Response.json({...receipt,eventId:'00000000-0000-4000-8000-000000000099'}),Response.json({...receipt,organizationId:'00000000-0000-4000-8000-000000000099'}),Response.json({...receipt,deliveryId:'00000000-0000-4000-8000-000000000099'}),Response.json({...receipt,endpointId:'00000000-0000-4000-8000-000000000099'}),Response.json({...receipt,schemaVersion:2}),Response.json({...receipt,contract:'HTTP'}),Response.json({...receipt,receiptId:undefined}),Response.json({...receipt,persistedAt:'yesterday'}),Response.json({...receipt,secret:'must-not-persist'})])('does not accept an absent, divergent or invalid durable receipt',async response=>{
  expect((await deliver(response)).result).toMatchObject({status:'PENDING',errorCode:'PERSISTENCE_RECEIPT_INVALID'});
 });
 it.each([200,201,202])('requires correlated receipt evidence for HTTP %s and negotiates delivery identity without changing the signed envelope',async status=>{
  const {result,send}=await deliver(Response.json(receipt,{status}));expect(result).toMatchObject({status:'DELIVERED',errorCode:null,receipt});
  expect(send.mock.calls[0]![1]).toMatchObject({redirect:'manual',headers:{'x-jrc-delivery-id':receiptClaim.deliveryId,'x-jrc-ack-mode':'PERSISTENCE_RECEIPT_V1','x-jrc-endpoint-id':receiptClaim.endpointId}});
 });
 it('bounds response bytes even with an injected transport',async()=>{
  expect((await deliver(new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}))).result).toMatchObject({status:'PENDING',errorCode:'PERSISTENCE_RECEIPT_INVALID'});
 });
 it('ends a stalled receipt read at its deadline and cancels the reader',async()=>{
  let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
  await expect(readPartnerPersistenceReceipt(response,AbortSignal.timeout(25))).rejects.toThrow('PERSISTENCE_RECEIPT_INVALID');expect(cancelled).toBe(true);
 });
 it('persists accepted receipt evidence in the same lease-fenced settlement',async()=>{
  const query=vi.fn(async(_sql:string,_params:unknown[])=>({rows:[],rowCount:0}));await settleDelivery({query} as never,receiptClaim,{status:'DELIVERED',attempts:1,errorCode:null,delayMs:0,receipt});
  expect(query.mock.calls[0]![0]).toContain('receipt_id');expect(query.mock.calls[0]![0]).toContain('lease_token=$8');expect(query.mock.calls[0]![0]).toContain('lease_expires_at>now()');expect(query.mock.calls[0]![1]).toContain(receipt.receiptId);
 });
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
