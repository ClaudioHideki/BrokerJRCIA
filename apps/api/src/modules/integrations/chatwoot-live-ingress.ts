import {createHash} from 'node:crypto';
import {z} from 'zod';
import {safeMediaName,validateMedia,type BinaryMedia} from '@jrc/providers';

export const LIVE_INGRESS_PROTOCOL='jrc-live-ingress/1' as const;
const integer=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sourceTime=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const scopeSchema=z.strictObject({organization_id:z.uuid(),integration_id:z.uuid(),instance_id:z.uuid(),destination_revision:integer});
export type LiveIngressScope=z.infer<typeof scopeSchema>;
const mediaSchema=z.strictObject({filename:z.string().min(1).max(255).refine(v=>Buffer.byteLength(v,'utf8')<=255&&!/[\x00-\x1f\x7f/\\]/u.test(v)),
 mime_type:z.string().min(1).max(255),byte_size:integer.max(16*1024*1024),sha256:hash});
const envelopeSchema=scopeSchema.extend({protocol:z.literal(LIVE_INGRESS_PROTOCOL),broker_message_id:z.uuid(),conversation_id:integer,
 message_type:z.enum(['incoming','outgoing']),message_origin:z.enum(['LIVE','EXTERNAL_OBSERVED']),
 content:z.string().refine(v=>Buffer.byteLength(v,'utf8')<=65_536),media:mediaSchema.nullable(),occurred_at:sourceTime.optional()})
 .refine(v=>(v.media!==null||v.content.length>0)&&(v.message_origin!=='EXTERNAL_OBSERVED'||v.message_type==='outgoing'));
const requestSchema=envelopeSchema.extend({request_hash:hash});
export type LiveIngressRequest=z.infer<typeof requestSchema>;
export type LiveIngressInput=Pick<LiveIngressRequest,'broker_message_id'|'conversation_id'|'message_type'|'message_origin'|'content'|'occurred_at'>;
const receiptBase=scopeSchema.extend({protocol:z.literal(LIVE_INGRESS_PROTOCOL),account_id:integer,inbox_id:integer,
 broker_message_id:z.uuid(),conversation_id:integer,receipt_id:z.uuid(),request_hash:hash});
const receiptSchema=z.discriminatedUnion('state',[
 receiptBase.extend({state:z.literal('PERSISTED'),message_id:integer}),
 receiptBase.extend({state:z.literal('MEDIA_PENDING'),message_id:z.null()}),
]);
export type LiveIngressReceipt=z.infer<typeof receiptSchema>;
const lookupSchema=scopeSchema.extend({protocol:z.literal(LIVE_INGRESS_PROTOCOL),broker_message_id:z.uuid(),
 conversation_id:integer,request_hash:hash}).strip();
export type LiveIngressLookup=z.infer<typeof lookupSchema>;
export const liveIngressProofSchema=lookupSchema.extend({attempt_id:z.uuid(),account_id:integer,inbox_id:integer,
 credential_revision:integer,base_url:z.url(),receipt_id:z.uuid().optional(),occurred_at:sourceTime.optional()}).strict();
export type LiveIngressProof=z.infer<typeof liveIngressProofSchema>;
export function liveIngressLookup(value:unknown):LiveIngressLookup {return lookupSchema.parse(value);}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
function fingerprint(value:unknown){return createHash('sha256').update(JSON.stringify(canonical(value)),'utf8').digest('hex');}
function descriptor(file:BinaryMedia){
 validateMedia(file);
 const safe=Buffer.from(safeMediaName(file.fileName),'utf8').toString('utf8'),extension=/\.[a-z0-9]{1,16}$/iu.exec(safe)?.[0]??'';
 let filename=safe;
 if(Buffer.byteLength(safe,'utf8')>255){
  let base='';
  for(const character of safe.slice(0,safe.length-extension.length)){
   if(Buffer.byteLength(base+character+extension,'utf8')>255)break;
   base+=character;
  }
  filename=base+extension;
 }
 return mediaSchema.parse({filename,mime_type:file.mimeType,byte_size:file.bytes.byteLength,
  sha256:createHash('sha256').update(file.bytes).digest('hex')});
}
type Request=(method:'GET'|'POST'|'PATCH',path:string,body?:unknown)=>Promise<unknown>;
type Failure=(code:string,uncertain?:boolean)=>Error;

/** Additive LAB2 receiver. Generic compatibility is chosen before dispatch only. */
export function createLiveIngressConsumer(request:Request,failure:Failure){
 const path=(accountId:number,inboxId:number)=>`/api/v1/accounts/${integer.parse(accountId)}/jrc_broker/inboxes/${integer.parse(inboxId)}/live-ingress/v1`;
 const parseRequest=(value:unknown)=>{
  const parsed=requestSchema.parse(value),{request_hash,...body}=parsed;
  if(fingerprint(body)!==request_hash)throw failure('CHATWOOT_LIVE_REQUEST_CONFLICT');
  return parsed;
 };
 const checkReceipt=(value:unknown,accountId:number,inboxId:number,expected:LiveIngressLookup,uncertain:boolean):LiveIngressReceipt=>{
  const parsed=receiptSchema.safeParse(value),body=parsed.success?parsed.data:undefined;
  if(!body||body.account_id!==accountId||body.inbox_id!==inboxId||body.conversation_id!==expected.conversation_id
   ||body.broker_message_id!==expected.broker_message_id||body.request_hash!==expected.request_hash
   ||Object.keys(scopeSchema.shape).some(key=>body[key as keyof LiveIngressScope]!==expected[key as keyof LiveIngressScope]))
   throw failure('CHATWOOT_LIVE_RECEIPT_UNPROVEN',uncertain);
  return body;
 };
 return {
  prepare(scope:LiveIngressScope,input:LiveIngressInput,file?:BinaryMedia):LiveIngressRequest{
   const envelope=envelopeSchema.parse({...scope,...input,protocol:LIVE_INGRESS_PROTOCOL,media:file?descriptor(file):null});
   return {...envelope,request_hash:fingerprint(envelope)};
  },
  async capability(accountId:number,inboxId:number,input:LiveIngressScope):Promise<boolean>{
   const scope=scopeSchema.parse(input);
   let result:unknown;
   try{result=await request('POST',`${path(accountId,inboxId)}/capability`,{protocol:LIVE_INGRESS_PROTOCOL,...scope});}
   catch(error){
    if(error instanceof Error&&'httpStatus' in error&&[404,405].includes(Number(error.httpStatus)))return false;
    throw error;
   }
   const parsed=scopeSchema.extend({protocol:z.literal(LIVE_INGRESS_PROTOCOL),account_id:integer,inbox_id:integer,
    supports_text:z.literal(true),supports_media:z.literal(true),max_media_bytes:integer.min(16*1024*1024)}).safeParse(result);
   if(!parsed.success||parsed.data.account_id!==accountId||parsed.data.inbox_id!==inboxId
    ||Object.keys(scopeSchema.shape).some(key=>parsed.data[key as keyof LiveIngressScope]!==scope[key as keyof LiveIngressScope]))
    throw failure('CHATWOOT_LIVE_CAPABILITY_UNPROVEN');
   return true;
  },
  async persist(accountId:number,inboxId:number,input:LiveIngressRequest,file?:BinaryMedia):Promise<LiveIngressReceipt>{
   const envelope=parseRequest(input);
   if(Boolean(file)!==(envelope.media!==null)||file&&fingerprint(descriptor(file))!==fingerprint(envelope.media))
    throw failure('CHATWOOT_LIVE_MEDIA_CONFLICT');
   let body:unknown=envelope;
   if(file){
    const form=new FormData();form.set('envelope',JSON.stringify(envelope));
    form.set('file',new Blob([new Uint8Array(file.bytes)],{type:file.mimeType}),envelope.media!.filename);body=form;
   }
   return checkReceipt(await request('POST',`${path(accountId,inboxId)}/messages`,body),accountId,inboxId,envelope,true);
  },
  async receipt(accountId:number,inboxId:number,input:LiveIngressLookup):Promise<LiveIngressReceipt|null>{
   const envelope=liveIngressLookup(input),scope=scopeSchema.parse(Object.fromEntries(Object.keys(scopeSchema.shape).map(key=>[key,envelope[key as keyof LiveIngressScope]])));
   let result:unknown;
   try{result=await request('POST',`${path(accountId,inboxId)}/receipts/${envelope.broker_message_id}`,
    {protocol:LIVE_INGRESS_PROTOCOL,...scope,request_hash:envelope.request_hash});}
   catch(error){if(error instanceof Error&&'httpStatus' in error&&error.httpStatus===404)return null;throw error;}
   return checkReceipt(result,accountId,inboxId,envelope,false);
  },
 };
}
