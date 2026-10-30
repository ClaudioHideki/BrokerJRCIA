import {expect,it} from 'vitest';
import {createDurablePrivateMediaStore,type PrivateMediaTransaction} from '../../src/modules/messaging/durable-private-media.js';
import type {PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';

// PostgreSQL is an external boundary here; this fixture supplies persisted rows
// while the real durable dispatcher, authority helpers and transport run.
function preparedUpload({partner=true,allowed=false,channel=true,active=true,state='PREPARED',expiresDuringMediaLock=false}={}) {
 const actions:string[]=[],queries:string[]=[],org='11111111-1111-4111-8111-111111111111',channelId='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
 const object={id,organization_id:org,channel_id:channelId,media_id:'44444444-4444-4444-8444-444444444444',profile:'private-v1',destination_fingerprint:'a'.repeat(64),plain_byte_size:5,plain_sha256:'b'.repeat(64),cipher_byte_length:9,cipher_sha256:'c'.repeat(64),mime_type:'text/plain',kind:'document',file_name:'fixture.txt',staging_ciphertext:'synthetic',state:'STAGED',reserved_bytes:5};
 const operation={id,object_id:id,state,kind:'PUT',lease_token:null as string|null,lease_expires_at:new Date(Date.now()+60_000),dispatched_at:null};
 const media={id:object.media_id,organization_id:org,channel_id:channelId,source:'UPLOAD',descriptor:partner?{uploadKind:'PARTNER',apiKeyId:'55555555-5555-4555-8555-555555555555'}:{rootAutomationId:'66666666-6666-4666-8666-666666666666'},status:'STORING'};
 let expired=false;
 const transact=(async(_org,work)=>work({query:async(sql:string,values:unknown[]=[])=>{
  const q=sql.toLowerCase().replace(/\s+/g,' ').trim();queries.push(q);
  const rows=(rows:unknown[])=>({rows,rowCount:rows.length});
  if(q.startsWith('select * from media_private_objects'))return rows([object]);
  if(q.startsWith('select * from media_private_operations'))return rows([operation]);
  if(q.includes('from media_private_operations')&&q.startsWith('select object_id,state'))return rows([{object_id:id,state:operation.state}]);
  if(q.includes('from messaging_media')&&q.startsWith('select')){if(q.includes('for update')&&expiresDuringMediaLock)expired=true;return rows([media]);}
  if(q.includes('from api_keys'))return rows(allowed&&(!expired||!q.includes('clock_timestamp()'))&&values[0]===org&&values[1]===media.descriptor.apiKeyId&&JSON.stringify(values[2])==='["media:upload"]'?[{id:media.descriptor.apiKeyId}]:[]);
  if(q.includes('media_private_channel_open'))return rows(values[0]===org&&values[1]===channelId?[{open:channel&&active,archived:false}]:[]);
  if(q.includes('tenant_is_active'))return rows([{active:values[0]===org&&active}]);
  if(q.includes('from instances')||q.includes('from messaging_channels'))return rows([{id:channelId}]);
  if(q.startsWith('update media_private_operations')){
   if(q.includes("state='dispatched'")){operation.state='DISPATCHED';operation.lease_token=String(values[1]);}
   else if(q.includes("state='rejected'")){operation.state='REJECTED';}
   else if(q.includes('set state=$3'))operation.state=String(values[2]);
   return rows([operation]);
  }
  if(q.startsWith('update media_private_objects')){if(q.includes("state='rejected'")){object.state='REJECTED';object.reserved_bytes=0;object.staging_ciphertext='';}else object.state='READY';return rows([object]);}
  if(q.startsWith('update messaging_media')){media.status=q.includes("status='failed'")?'FAILED':'READY';return rows([media]);}
  throw new Error(`Unexpected test SQL: ${q}`);
 }})) as PrivateMediaTransaction;
 const transport:PrivateObjectStore={destinationFingerprint:object.destination_fingerprint,
  async put(){actions.push('PUT');return {outcome:'CONFIRMED'};},
  async inspect(){actions.push('INSPECT');return {outcome:'MISSING'};},
  async read(){throw new Error('Not a read test');},async remove(){throw new Error('Not cleanup');}};
 const create=()=>createDurablePrivateMediaStore({encryptionKey:Buffer.alloc(32,7).toString('base64'),transact,cleanupTransact:async()=>{throw new Error('No cleanup');},objectStore:transport,profile:'private-v1'});
 return {create,org,id,object,operation,media,actions,queries};
}

it('rejects a persisted PREPARED partner upload after key revocation before physical PUT',async()=>{
 const h=preparedUpload();expect(await h.create().dispatchPut(h.org,h.id)).toBe('REJECTED');
 expect(h.actions).toEqual([]);expect(h.operation.state).toBe('REJECTED');expect(h.object.reserved_bytes).toBe(0);expect(h.media.status).toBe('FAILED');
});
it('reapplies partner upload authority when a new durable worker resumes PREPARED storage',async()=>{
 const h=preparedUpload();expect(await h.create().runOnce(h.org)).toBe(true);expect(h.actions).toEqual([]);expect(h.operation.state).toBe('REJECTED');
});
it.each([{active:false},{channel:false}])('rejects resumed partner storage when operational scope is closed: %j',async values=>{
 const h=preparedUpload({...values,allowed:true});expect(await h.create().dispatchPut(h.org,h.id)).toBe('REJECTED');expect(h.actions).toEqual([]);
});
it('keeps an authorized partner and a legacy automation upload dispatchable',async()=>{
 for(const options of [{allowed:true},{partner:false}]){const h=preparedUpload(options);expect(await h.create().dispatchPut(h.org,h.id)).toBe('CONFIRMED');expect(h.actions).toEqual(['PUT']);}
});
it('does not make a terminal or uncertain PUT depend on the original upload key',async()=>{
 for(const state of ['CONFIRMED','UNKNOWN']){const h=preparedUpload({state});expect(await h.create().dispatchPut(h.org,h.id)).toBe(state);expect(h.actions).toEqual([]);expect(h.queries.some(q=>q.includes('from api_keys'))).toBe(false);}
});
it('rechecks wall-clock expiry after the media lock before changing a prepared upload to DISPATCHED',async()=>{
 const h=preparedUpload({allowed:true,expiresDuringMediaLock:true});
 expect(await h.create().dispatchPut(h.org,h.id)).toBe('REJECTED');expect(h.actions).toEqual([]);expect(h.operation.state).toBe('REJECTED');
});
