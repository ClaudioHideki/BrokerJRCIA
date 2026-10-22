import { describe,it,expect,vi } from 'vitest';
import { createPartnerEventService } from './service.js';
import { createIntegrationSecrets } from '../integrations/secrets.js';
const org='00000000-0000-4000-8000-000000000001';
describe('partner event service',()=>{
 it('creates a distinct signing secret, encrypts it and returns it only at creation',async()=>{
  let stored:unknown[]=[];
  const query=vi.fn(async(sql:string,params:unknown[])=>{
   if(sql.includes('tenant_is_active'))return {rows:[{active:true}]};
   if(sql.includes('count(*)'))return {rows:[{count:0}]};
   if(sql.includes('INSERT INTO')){stored=params;return {rows:[{id:params[1],url:params[2],status:'ACTIVE',createdAt:new Date(),revokedAt:null}]};}
   return {rows:[]};
  });
  const secrets=createIntegrationSecrets(Buffer.alloc(32,8).toString('base64'));
  const service=createPartnerEventService({transact:async(_org,work)=>work({query} as never),secrets});
  const one=await service.create(org,{url:'https://partner.example/hook'},'idempotency-one');
  expect(one.signingSecret.length).toBeGreaterThan(32); expect(stored[3]).not.toBe(one.signingSecret);
  expect(secrets.decrypt(`partner-webhook:${org}:${one.endpoint.id}`,String(stored[3]))).toBe(one.signingSecret);
  const two=await service.create(org,{url:'https://partner.example/hook2'},'idempotency-two');expect(two.signingSecret).not.toBe(one.signingSecret);
 });
 it('refuses destination secrets in URL before any database access',async()=>{
  const transact=vi.fn();const service=createPartnerEventService({transact,secrets:createIntegrationSecrets(Buffer.alloc(32,8).toString('base64'))});
  await expect(service.create(org,{url:'https://partner.example/hook?token=abc'},'idempotency-one')).rejects.toThrow('INVALID_WEBHOOK_URL'); expect(transact).not.toHaveBeenCalled();
 });
 it('replays same intent using encrypted secret and rejects reusing a key for a new URL',async()=>{
  const secrets=createIntegrationSecrets(Buffer.alloc(32,8).toString('base64')),id='00000000-0000-4000-8000-000000000002';
  const row={id,url:'https://partner.example/hook',status:'ACTIVE',createdAt:new Date(),revokedAt:null,encryptedSecret:secrets.encrypt(`partner-webhook:${org}:${id}`,'same-signing-secret')};
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('tenant_is_active')?[{active:true}]:sql.includes('idempotency_key')?[row]:[]}));
  const service=createPartnerEventService({transact:async(_org,work)=>work({query} as never),secrets});
  const replay=await service.create(org,{url:row.url},'idempotency-one');expect(replay.signingSecret).toBe('same-signing-secret');expect(replay.replayed).toBe(true);expect(replay.endpoint).not.toHaveProperty('encryptedSecret');
  expect(query.mock.calls.some(([sql])=>sql.includes('INSERT'))).toBe(false);
  await expect(service.create(org,{url:'https://partner.example/other'},'idempotency-one')).rejects.toThrow('WEBHOOK_IDEMPOTENCY_CONFLICT');
 });
 it('publishes committed events before a cursor read',async()=>{
  const queries:string[]=[];const query=vi.fn(async(sql:string)=>{queries.push(sql);return {rows:sql.includes('tenant_is_active')?[{active:true}]:[]};});
  const service=createPartnerEventService({transact:async(_org,work)=>work({query} as never),secrets:createIntegrationSecrets(Buffer.alloc(32,8).toString('base64'))});
  await service.events(org,{limit:10});
  const publication=queries.findIndex(sql=>sql.includes('partner_publish_events'));
  expect(publication).toBeGreaterThan(-1);expect(publication).toBeLessThan(queries.findIndex(sql=>sql.includes('FROM partner_events WHERE')));
 });
 it('revokes pending delivery together with wiping the signing secret',async()=>{
  const queries:string[]=[];const query=vi.fn(async(sql:string)=>{queries.push(sql);return {rows:sql.includes('tenant_is_active')?[{active:true}]:[{id:'e',status:'REVOKED',createdAt:new Date(),revokedAt:new Date()}]};});
  const service=createPartnerEventService({transact:async(_org,work)=>work({query} as never),secrets:createIntegrationSecrets(Buffer.alloc(32,8).toString('base64'))});
  await service.revoke(org,'e'); expect(queries.join('\n')).toContain('encrypted_secret=NULL');expect(queries.join('\n')).toContain("status='CANCELLED'");
 });
 it('reports cursor expiry rather than silently skipping retained history',async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('tenant_is_active')?[{active:true}]:sql.includes('min(sequence_number)')?[{earliestCursor:'100'}]:sql.includes('last_pruned_cursor')?[{lastPrunedCursor:'99'}]:[]}));
  const service=createPartnerEventService({transact:async(_org,work)=>work({query} as never),secrets:createIntegrationSecrets(Buffer.alloc(32,8).toString('base64'))});
  await expect(service.events(org,{limit:10,after:'50'})).rejects.toThrow('EVENT_CURSOR_EXPIRED');
  expect(await service.events(org,{limit:10,after:'0'})).toMatchObject({retentionDays:30,earliestCursor:'100'});
 });
});
