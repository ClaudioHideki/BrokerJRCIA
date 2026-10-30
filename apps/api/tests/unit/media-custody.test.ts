import {expect,it} from 'vitest';
import {createMediaCustodyService} from '../../src/modules/media-custody/service.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=uuid(1),key=uuid(2),receiptId=uuid(3),idempotency=uuid(4);
const input={schemaVersion:1 as const,channelId:uuid(5),messageId:uuid(6),mediaId:uuid(7),endpointId:uuid(8),destinationVersion:1 as const,clientReceiptId:uuid(9),byteSize:123,sha256:'a'.repeat(64),storageObjectId:'synthetic/archive/attachment',attestation:'DURABLY_STORED' as const};
function harness(){
 const state={active:true,authorized:true,controlBound:false,expiresAtLock:false,mediaStatus:'READY',matches:true,endpointActive:true,existing:null as any,inserts:0,mutations:[] as string[]};
 const tx={query:async(sql:string,p:any[]=[])=>{
  if(sql.includes('tenant_is_active'))return {rows:[{active:state.active}]};
  if(sql.includes('FROM api_keys'))return {rows:state.authorized?[{id:key}]:[]};
  if(sql.includes('FROM chatwoot_control_bindings'))return {rows:state.controlBound?[{api_key_id:key}]:[]};
  if(sql.includes('FOR SHARE OF m, a')){if(state.expiresAtLock)state.authorized=false;return {rows:state.matches?[{status:state.mediaStatus,byteSize:123,sha256:'a'.repeat(64)}]:[]};}
  if(sql.includes('FROM partner_webhook_endpoints'))return {rows:state.endpointActive?[{id:input.endpointId}]:[]};
  if(sql.includes('FROM media_custody_receipts'))return {rows:state.existing?[state.existing]:[]};
  if(sql.includes('INSERT INTO media_custody_receipts')){state.inserts++;state.existing={id:receiptId,organizationId:org,...input,idempotencyKey:p[2],requestHash:p[3],acceptedAt:new Date('2026-10-29T00:00:00Z')};return {rows:[state.existing]};}
  if(/^(UPDATE|DELETE)/u.test(sql.trim()))state.mutations.push(sql);
  return {rows:[],rowCount:1};
 }} as unknown as TenantTransaction;
 const service=createMediaCustodyService({transact:async(_org,work)=>work(tx)});
 return {state,service};
}
it('persists a stable receipt and returns the same identity after ACK loss without changing bytes or READY',async()=>{
 const h=harness();const first=await h.service.record(org,key,input,idempotency);
 const replay=await h.service.record(org,key,input,idempotency);
 expect(first.receipt.id).toBe(receiptId);expect(replay.receipt).toEqual(first.receipt);expect(replay.replayed).toBe(true);
 expect(h.state.inserts).toBe(1);expect(h.state.mutations).toEqual([]);
});
it('rejects divergent replay even when message and media identifiers still match',async()=>{
 const h=harness();await h.service.record(org,key,input,idempotency);
 await expect(h.service.record(org,key,{...input,storageObjectId:'different'},idempotency)).rejects.toMatchObject({code:'MEDIA_CUSTODY_CONFLICT',statusCode:409});
 expect(h.state.inserts).toBe(1);
});
it.each(['PENDING','DOWNLOADING','STORING','UNKNOWN','FAILED'])('refuses %s media and never promotes it',async status=>{
 const h=harness();h.state.mediaStatus=status;
 await expect(h.service.record(org,key,input,idempotency)).rejects.toMatchObject({code:'MEDIA_NOT_READY',statusCode:409});expect(h.state.inserts).toBe(0);expect(h.state.mutations).toEqual([]);
});
it.each([{byteSize:124},{sha256:'b'.repeat(64)}])('refuses mismatched byte integrity %j',async change=>{
 const h=harness();await expect(h.service.record(org,key,{...input,...change},idempotency)).rejects.toMatchObject({code:'MEDIA_CUSTODY_INTEGRITY_MISMATCH',statusCode:409});expect(h.state.inserts).toBe(0);
});
it('refuses another tenant/channel/message/media reference',async()=>{
 const h=harness();h.state.matches=false;
 await expect(h.service.record(org,key,input,idempotency)).rejects.toMatchObject({code:'MEDIA_REFERENCE_NOT_FOUND',statusCode:404});expect(h.state.inserts).toBe(0);
});
it('requires a registered active destination',async()=>{
 const h=harness();h.state.endpointActive=false;
 await expect(h.service.record(org,key,input,idempotency)).rejects.toMatchObject({code:'MEDIA_DESTINATION_NOT_ACTIVE',statusCode:409});expect(h.state.inserts).toBe(0);
});
it('refuses a control-bound credential even if an archive scope was added to its key row',async()=>{
 const h=harness();h.state.controlBound=true;
 await expect(h.service.record(org,key,input,idempotency)).rejects.toMatchObject({code:'MEDIA_CUSTODY_CONTROL_CREDENTIAL',statusCode:403});expect(h.state.inserts).toBe(0);
});
it.each([false,true])('rechecks revoked or expired credentials after blocking locks (during lock=%s)',async during=>{
 const h=harness();h.state.authorized=during;h.state.expiresAtLock=during;
 await expect(h.service.record(org,key,input,idempotency)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});expect(h.state.inserts).toBe(0);
});
it('reports KEEP and no deletion eligibility even after an authenticated receipt',async()=>{
 const h=harness();await h.service.record(org,key,input,idempotency);
 const evaluation=await h.service.evaluate(org,key,receiptId);
 expect(evaluation).toMatchObject({schemaVersion:1,policy:'KEEP',eligibleForDeletion:false,reason:'KEEP_POLICY',physicalStorageVerified:false});expect(h.state.mutations).toEqual([]);
});
