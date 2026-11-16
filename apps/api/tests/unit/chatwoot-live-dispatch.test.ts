import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {selectLiveMirrorProtocol,dispatchNativeLiveMirror,assertRejectedNativeRetry} from '../../src/modules/integrations/chatwoot-live-dispatch.js';
import {IntegrationError} from '../../src/modules/integrations/integration-error.js';
const scope={organization_id:randomUUID(),integration_id:randomUUID(),instance_id:randomUUID(),destination_revision:1};
const input={broker_message_id:randomUUID(),conversation_id:51,message_type:'incoming' as const,message_origin:'LIVE' as const,content:'Synthetic durable input'};
function setup(responses:(path:string,body:any)=>unknown){
 const calls:string[]=[],client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',async fetch(url,init){
  const path=new URL(String(url)).pathname;calls.push(path);return Response.json(await responses(path,JSON.parse(String(init?.body))));
 }});
 const body=client.liveIngress().prepare(scope,input),proof={protocol:'jrc-live-ingress/1' as const,...scope,
  broker_message_id:input.broker_message_id,conversation_id:51,request_hash:body.request_hash,attempt_id:randomUUID(),
  account_id:7,inbox_id:9,credential_revision:1,base_url:'https://central.example.test'};
 const receipt={protocol:'jrc-live-ingress/1',...scope,account_id:7,inbox_id:9,broker_message_id:input.broker_message_id,
  conversation_id:51,message_id:61,receipt_id:randomUUID(),request_hash:body.request_hash,state:'PERSISTED'};
 return{client,calls,body,proof,receipt};
}
it.each(['GENERIC','jrc-live-ingress/1'] as const)('preserves the recorded %s protocol without rediscovery',async protocol=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:vi.fn()});
 expect(await selectLiveMirrorProtocol({client,scope,accountId:7,inboxId:9,recorded:protocol,hasPriorAttempt:true})).toBe(protocol);
});
it.each(['attempt','operation','no-instance'])('does not upgrade a generic or unbound %s operation',async reason=>{
 const fetch=vi.fn(),client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 expect(await selectLiveMirrorProtocol({client,scope:reason==='no-instance'?undefined:scope,accountId:7,inboxId:9,
  hasPriorAttempt:reason==='attempt',operation:reason==='operation'?'GROUP_SEND_MESSAGE':undefined})).toBe('GENERIC');
 expect(fetch).not.toHaveBeenCalled();
});
it('does not turn an invalid recorded selection into permission for generic sends',async()=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:vi.fn()});
 await expect(selectLiveMirrorProtocol({client,scope,accountId:7,inboxId:9,recorded:'invalid',hasPriorAttempt:false})).rejects.toThrow();
});
it('selects native only from a verified capability before the first attempt',async()=>{
 const t=setup(()=>({protocol:'jrc-live-ingress/1',...scope,account_id:7,inbox_id:9,supports_text:true,supports_media:true,max_media_bytes:16*1024*1024}));
 expect(await selectLiveMirrorProtocol({client:t.client,scope,accountId:7,inboxId:9,hasPriorAttempt:false})).toBe('jrc-live-ingress/1');
 expect(t.calls).toHaveLength(1);
});
it('recovers the exact persistence receipt after a lost response with no second message POST',async()=>{
 const t=setup(path=>{if(path.endsWith('/messages'))throw Error('lost ACK');return t.receipt;}),pins:unknown[]=[];
 expect(await dispatchNativeLiveMirror({client:t.client,body:t.body,proof:t.proof,pin:async value=>{pins.push(value);}})).toBe(61);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
 expect(t.calls.filter(path=>path.includes('/receipts/'))).toHaveLength(1);
 expect(pins).toEqual([{...t.proof,receipt_id:t.receipt.receipt_id}]);
});
it('pins a pending receipt before inspecting custody and refuses a replacement receipt identity',async()=>{
 const t=setup(path=>path.endsWith('/messages')?{...t.receipt,state:'MEDIA_PENDING',message_id:null}:{...t.receipt,receipt_id:randomUUID()}),pins:unknown[]=[];
 await expect(dispatchNativeLiveMirror({client:t.client,body:t.body,proof:t.proof,pin:async value=>{pins.push(value);}}))
  .rejects.toMatchObject({code:'CHATWOOT_LIVE_RECEIPT_ID_CHANGED',uncertain:true});
 expect(pins).toEqual([{...t.proof,receipt_id:t.receipt.receipt_id}]);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('keeps the operation uncertain while media custody remains pending',async()=>{
 const t=setup(()=>({...t.receipt,state:'MEDIA_PENDING',message_id:null}));
 await expect(dispatchNativeLiveMirror({client:t.client,body:t.body,proof:t.proof,pin:async()=>{}}))
  .rejects.toMatchObject({code:'CHATWOOT_LIVE_CONFIRMATION_PENDING',uncertain:true});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('revalidates before a receipt read and never calls it after local authority was revoked',async()=>{
 let authorized=true;
 const t=setup(()=>{authorized=false;throw Error('Synthetic lost ACK and revocation');});
 await expect(dispatchNativeLiveMirror({client:t.client,body:t.body,proof:t.proof,pin:async()=>{},
  async guard(_operation,_mutation,work){if(!authorized)throw Error('revoked scope');return work();}}))
  .rejects.toMatchObject({uncertain:true});
 expect(t.calls.filter(path=>path.includes('/receipts/'))).toHaveLength(0);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('preserves uncertainty if scope changes while pinning a receipt after a persisted POST',async()=>{
 const t=setup(()=>t.receipt);
 await expect(dispatchNativeLiveMirror({client:t.client,body:t.body,proof:t.proof,
  pin:async()=>{throw new IntegrationError('GROUP_CENTRAL_SCOPE_CHANGED',409);}}))
  .rejects.toMatchObject({code:'CHATWOOT_LIVE_CONFIRMATION_PENDING',uncertain:true});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('cannot dispatch after body, account or hash identity changes relative to the persisted proof',async()=>{
 const t=setup(()=>t.receipt);
 await expect(dispatchNativeLiveMirror({client:t.client,body:t.body,proof:{...t.proof,account_id:8},pin:async()=>{},accountId:7}))
  .rejects.toThrow();
 await expect(dispatchNativeLiveMirror({client:t.client,body:{...t.body,conversation_id:52},proof:t.proof,pin:async()=>{}}))
  .rejects.toThrow();
 expect(t.calls).toEqual([]);
});
it('permits only a definite rejected native request to retry its identical immutable body',()=>{
 const t=setup(()=>t.receipt),context={account_id:7,inbox_id:9,credential_revision:1,base_url:'https://central.example.test'};
 expect(()=>assertRejectedNativeRetry(t.proof,t.body,context,'REJECTED')).not.toThrow();
});
it.each(['UNKNOWN','DISPATCHED','CONFIRMED',undefined])('preserves uncertain prior native state %s without another POST',state=>{
 const t=setup(()=>t.receipt),context={account_id:7,inbox_id:9,credential_revision:1,base_url:'https://central.example.test'};
 expect(()=>assertRejectedNativeRetry(t.proof,t.body,context,state)).toThrow();
 expect(t.calls).toEqual([]);
});
it.each(['account_id','inbox_id','credential_revision','base_url','request_hash','receipt_id'])('rejects retry after proof %s changes',key=>{
 const t=setup(()=>t.receipt),context={account_id:7,inbox_id:9,credential_revision:1,base_url:'https://central.example.test'};
 const changed={...t.proof,[key]:key==='base_url'?'https://other.example.test':key==='request_hash'?'f'.repeat(64):key==='receipt_id'?randomUUID():99};
 expect(()=>assertRejectedNativeRetry(changed,t.body,context,'REJECTED')).toThrow();
 expect(t.calls).toEqual([]);
});
