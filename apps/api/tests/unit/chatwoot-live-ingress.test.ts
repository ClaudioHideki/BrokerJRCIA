import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';

const scope={organization_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',integration_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 instance_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',destination_revision:3};
const source={broker_message_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',conversation_id:51,
 message_type:'incoming' as const,message_origin:'LIVE' as const,content:'Synthetic live receipt'};
const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value!==null&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,sorted(item)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const envelope={protocol:'jrc-live-ingress/1',...scope,...source,media:null};
const request={...envelope,request_hash:hash(envelope)};
const receipt={protocol:'jrc-live-ingress/1',...scope,account_id:7,inbox_id:9,broker_message_id:source.broker_message_id,
 conversation_id:51,message_id:61,receipt_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',request_hash:request.request_hash,state:'PERSISTED'};

it('prepares deterministic versioned content proof independently of property insertion order',()=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic'});
 const native=client.liveIngress();
 expect(native.prepare(scope,source)).toEqual(request);
 expect(native.prepare({...scope,destination_revision:3},{...source,content:'Synthetic live receipt'})).toEqual(request);
});

it('pins an optional canonical source timestamp without changing legacy request hashes',()=>{
 const native=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic'}).liveIngress();
 const body=native.prepare(scope,{...source,occurred_at:1_767_323_045});
 expect(body).toEqual({...envelope,occurred_at:1_767_323_045,request_hash:hash({...envelope,occurred_at:1_767_323_045})});
 expect(native.prepare(scope,source)).toEqual(request);
});

it.each([-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN])('rejects invalid source timestamp %s before I/O',value=>{
 const native=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic'}).liveIngress();
 expect(()=>native.prepare(scope,{...source,occurred_at:value})).toThrow();
});

it('verifies the bound capability before selecting the native LIVE path',async()=>{
 const fetch=vi.fn(async()=>Response.json({protocol:'jrc-live-ingress/1',...scope,account_id:7,inbox_id:9,
  supports_text:true,supports_media:true,max_media_bytes:16*1024*1024}));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 expect(await client.liveIngress().capability(7,9,scope)).toBe(true);
 expect(String(fetch.mock.calls[0]?.[0]).endsWith('/api/v1/accounts/7/jrc_broker/inboxes/9/live-ingress/v1/capability')).toBe(true);
 expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({protocol:'jrc-live-ingress/1',...scope});
});

it.each([404,405])('selects stock compatibility only for an absent capability endpoint (%s)',async status=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>new Response('',{status})});
 expect(await client.liveIngress().capability(7,9,scope)).toBe(false);
});

it.each([401,403,409,422,429,500])('does not downgrade after capability failure %s',async status=>{
 const fetch=vi.fn(async()=>new Response('',{status}));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 await expect(client.liveIngress().capability(7,9,scope)).rejects.toThrow();
 expect(fetch).toHaveBeenCalledTimes(1);
});

it('sends one native text request and validates an immutable persistence receipt',async()=>{
 const fetch=vi.fn(async()=>Response.json(receipt));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 expect(await client.liveIngress().persist(7,9,request)).toEqual(receipt);
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(String(fetch.mock.calls[0]?.[0]).endsWith('/live-ingress/v1/messages')).toBe(true);
 expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(request);
});

it('looks up the exact receipt after a lost ACK without a message POST or generic fallback',async()=>{
 const calls:string[]=[];
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async(input)=>{
  const path=new URL(String(input)).pathname;calls.push(path);
  if(path.endsWith('/messages'))throw Error('synthetic lost ACK');
  return Response.json(receipt);
 }});
 const native=client.liveIngress();
 await expect(native.persist(7,9,request)).rejects.toMatchObject({uncertain:true});
 expect(await native.receipt(7,9,request)).toEqual(receipt);
 expect(calls).toEqual(['/api/v1/accounts/7/jrc_broker/inboxes/9/live-ingress/v1/messages',
  `/api/v1/accounts/7/jrc_broker/inboxes/9/live-ingress/v1/receipts/${source.broker_message_id}`]);
});

it('preserves missing receipt as absence and pending media as pending, never as success',async()=>{
 let missing=true;
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>missing
  ?new Response('',{status:404}):Response.json({...receipt,state:'MEDIA_PENDING',message_id:null})});
 expect(await client.liveIngress().receipt(7,9,request)).toBeNull();
 missing=false;
 expect(await client.liveIngress().receipt(7,9,request)).toMatchObject({state:'MEDIA_PENDING',message_id:null});
});

it('refuses a persisted receipt without a committed message identity',async()=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',
  fetch:async()=>Response.json({...receipt,message_id:null})});
 await expect(client.liveIngress().persist(7,9,request)).rejects.toMatchObject({code:'CHATWOOT_LIVE_RECEIPT_UNPROVEN',uncertain:true});
});

it.each(['capability','receipt'])('classifies read-only %s failures as unavailable, never uncertain message delivery',async operation=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>new Response('',{status:500})});
 const native=client.liveIngress();
 await expect(operation==='capability'?native.capability(7,9,scope):native.receipt(7,9,request))
  .rejects.toMatchObject({retrySafe:true,uncertain:false});
});

it.each(['account_id','inbox_id','conversation_id','organization_id','integration_id','instance_id','destination_revision',
 'broker_message_id','request_hash','protocol','receipt_id','message_id'])('rejects mismatched or invalid receipt %s',async key=>{
 const altered={...receipt,[key]:key==='message_id'?0:typeof receipt[key as keyof typeof receipt]==='number'?999:'invalid'};
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json(altered)});
 await expect(client.liveIngress().persist(7,9,request)).rejects.toMatchObject({code:'CHATWOOT_LIVE_RECEIPT_UNPROVEN',uncertain:true});
});

it('pins private media bytes, descriptor and multipart envelope to the same hash',async()=>{
 const bytes=new Uint8Array([137,80,78,71]),file={bytes,mimeType:'image/png',kind:'image' as const,fileName:'sample.png',caption:'caption'};
 let sent:FormData|undefined;
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async(_input,init)=>{
  sent=init?.body as FormData;const body=JSON.parse(String(sent.get('envelope')));
  return Response.json({...receipt,request_hash:body.request_hash,state:'MEDIA_PENDING',message_id:null});
 }});
 const native=client.liveIngress(),body=native.prepare(scope,{...source,content:'caption'},file);
 expect(body.media).toEqual({filename:'sample.png',mime_type:'image/png',byte_size:4,sha256:createHash('sha256').update(bytes).digest('hex')});
 expect(await native.persist(7,9,body,file)).toMatchObject({state:'MEDIA_PENDING'});
 expect(JSON.parse(String(sent!.get('envelope')))).toEqual(body);
 expect(new Uint8Array(await (sent!.get('file') as File).arrayBuffer())).toEqual(bytes);
});

it('normalizes a long multibyte filename to the receiver byte limit before hashing or multipart I/O',async()=>{
 let sent:FormData|undefined;
 const native=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async(_input,init)=>{
  sent=init?.body as FormData;const body=JSON.parse(String(sent.get('envelope')));
  return Response.json({...receipt,request_hash:body.request_hash});
 }}).liveIngress();
 const file={bytes:new Uint8Array([1]),mimeType:'application/pdf',kind:'document' as const,fileName:'界'.repeat(100)+'.pdf'};
 const body=native.prepare(scope,source,file);
 expect(body.media!.filename).toBe('界'.repeat(83)+'.pdf');
 expect(Buffer.byteLength(body.media!.filename,'utf8')).toBeLessThanOrEqual(255);
 await native.persist(7,9,body,file);
 expect((sent!.get('file') as File).name).toBe(body.media!.filename);
 expect(JSON.parse(String(sent!.get('envelope')))).toEqual(body);
});

it('does not hash a dangling surrogate introduced by the generic filename code-unit limit',()=>{
 const native=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic'}).liveIngress();
 const file={bytes:new Uint8Array([1]),mimeType:'application/pdf',kind:'document' as const,fileName:'🙂'.repeat(59)+'a🙂.pdf'};
 const filename=native.prepare(scope,source,file).media!.filename;
 expect(filename).toBe(filename.toWellFormed());
 expect(filename).toBe('🙂'.repeat(59)+'a�');
});

it('rejects body/hash changes, substituted files and invalid external direction before remote I/O',async()=>{
 const fetch=vi.fn(),client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 const native=client.liveIngress();
 await expect(native.persist(7,9,{...request,content:'different'})).rejects.toThrow();
 expect(()=>native.prepare(scope,{...source,message_origin:'EXTERNAL_OBSERVED'})).toThrow();
 const file={bytes:new Uint8Array([1]),mimeType:'application/pdf',kind:'document' as const,fileName:'sample.pdf'};
 const body=native.prepare(scope,source,file);
 await expect(native.persist(7,9,body,{...file,bytes:new Uint8Array([2])})).rejects.toThrow();
 expect(fetch).not.toHaveBeenCalled();
});
