import { describe, expect, it } from 'vitest';
import { IssueApiKeyRequestSchema } from '@jrc/contracts';
import { createPartnerTextSender } from '../../src/modules/messaging/partner-text.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
const org='11111111-1111-4111-8111-111111111111', channel='22222222-2222-4222-8222-222222222222', conversation='33333333-3333-4333-8333-333333333333', key='44444444-4444-4444-8444-444444444444';
function fixture({active=true,provider='BAILEYS',transport='BROKER_TRANSPORT',foreign=false}={}) {
 let prior:any=null;
 const calls: Array<{kind:string;input:any}>=[];
 const repository={
  findChannel:async()=>({id:channel,organizationId:org,provider,transport}),
  findConversation:async()=>({id:conversation,organizationId:foreign?'other':org,channelId:channel}),
  upsertContact:async(_tx:any,input:any)=>{calls.push({kind:'contact',input});return {id:'contact'};},
  setConversationMode:async(_tx:any,input:any)=>{calls.push({kind:'mode',input});return {};},
  getOrCreateConversation:async()=>({id:conversation,organizationId:org,channelId:channel}),
  enqueueOutgoing:async(_tx:any,input:any)=>{calls.push({kind:'enqueue',input});prior={id:channel,conversationId:input.conversationId,state:'ACCEPTED',bodyHash:input.bodyHash,text:input.content.text};return {kind:'created',message:{id:channel,direction:'OUTGOING',state:'ACCEPTED',content:input.content}};},
 } as unknown as MessagingRepository;
 const tx={query:async(sql:string,values:any[])=>{calls.push({kind:sql,input:values});return {rows:sql.includes('FROM messaging_messages WHERE')?(prior?[prior]:[]):sql.includes('FROM api_keys')?(active?[{id:key}]:[]):[{active:true}],rowCount:active?1:0};}} as unknown as TenantTransaction;
 return {calls,setActive(value:boolean){active=value;},send:createPartnerTextSender({repository,transact:async(_org,fn)=>fn(tx)})};
}
describe('partner text admission',()=>{
 it('issues only explicitly selected messaging and webhook scopes',()=>{
  expect(IssueApiKeyRequestSchema.safeParse({name:'partner',scopes:['messaging:read','messaging:send','webhooks:manage']}).success).toBe(true);
  expect(IssueApiKeyRequestSchema.safeParse({name:'partner',scopes:['chatwoot:manage']}).success).toBe(false);
 });
 it('enqueues existing conversation under tenant with authorizing key and stable idempotency',async()=>{
  const h=fixture();await h.send(org,channel,{conversationId:conversation,text:'Synthetic greeting'},'request-1',key);
  expect(h.calls.find(c=>c.kind==='enqueue')?.input).toMatchObject({organizationId:org,channelId:channel,conversationId:conversation,authorizingApiKeyId:key,idempotencyKey:'request-1',source:'OPERATOR'});
 });
 it('creates initial E164 recipient without manufacturing opt-in',async()=>{
  const h=fixture();await h.send(org,channel,{phoneNumber:'+12025550123',text:'Synthetic greeting'},'request-1',key);
  expect(h.calls.find(c=>c.kind==='contact')?.input).toMatchObject({externalId:'12025550123',consentStatus:'UNKNOWN'});
 });
 it.each([{active:false},{transport:'CENTRAL_TRANSPORT'},{foreign:true},{provider:'META'}])('rejects unsafe admission %j',async options=>{
  const h=fixture(options);await expect(h.send(org,channel,{conversationId:conversation,text:'Synthetic greeting'},'request-1',key)).rejects.toBeDefined();
  expect(h.calls.filter(c=>c.kind==='enqueue')).toEqual([]);
 });
});



it('returns the created conversation identity for initial recipients',async()=>{
 const h=fixture();await expect(h.send(org,channel,{phoneNumber:'+12025550123',text:'Synthetic greeting'},'request-2',key)).resolves.toMatchObject({conversationId:conversation});
});


it('replays initial send without repeating creation, takeover or enqueue and conflicts on changed payload',async()=>{
 const h=fixture();const input={phoneNumber:'+12025550123',text:'Synthetic greeting'};
 const first=await h.send(org,channel,input,'request-3',key);
 const second=await h.send(org,channel,input,'request-3',key);
 expect(second).toEqual(first);
 expect(h.calls.filter(c=>c.kind==='contact')).toHaveLength(1);
 expect(h.calls.filter(c=>c.kind==='enqueue')).toHaveLength(1);
 await expect(h.send(org,channel,{...input,text:'Changed'},'request-3',key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 expect(h.calls.filter(c=>c.kind==='enqueue')).toHaveLength(1);
});



it('rechecks authority before an idempotent replay and preserves manual takeover before queue admission',async()=>{
 const h=fixture(),input={conversationId:conversation,text:'Synthetic greeting'};
 await h.send(org,channel,input,'scope-loss-replay',key);
 const mode=h.calls.findIndex(c=>c.kind==='mode'),enqueue=h.calls.findIndex(c=>c.kind==='enqueue');
 expect(mode).toBeGreaterThan(-1);expect(mode).toBeLessThan(enqueue);
 expect(h.calls[mode]!.input).toMatchObject({organizationId:org,conversationId:conversation,mode:'HUMAN'});
 h.setActive(false);
 await expect(h.send(org,channel,input,'scope-loss-replay',key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
 expect(h.calls.filter(c=>c.kind==='enqueue')).toHaveLength(1);
 expect(h.calls.filter(c=>c.kind==='mode')).toHaveLength(1);
});

it('locks the attendance channel before initial contact and conversation writes',async()=>{
 const h=fixture();await h.send(org,channel,{phoneNumber:'+12025550123',text:'Synthetic'},'channel-lock-order',key);
 const channelLock=h.calls.findIndex(c=>c.kind.endsWith('for no key update'));
 const contact=h.calls.findIndex(c=>c.kind==='contact');
 expect(channelLock).toBeGreaterThan(-1);expect(channelLock).toBeLessThan(contact);
});
