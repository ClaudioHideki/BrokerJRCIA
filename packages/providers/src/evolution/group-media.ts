import type {EvolutionMessagingClient} from './messaging.js';
import type {ProviderContext} from '../contracts/types.js';
import {MediaError,validateMedia,safeMediaName,type BinaryMedia} from '../media.js';
type Options=ConstructorParameters<typeof EvolutionMessagingClient>[0];
const failure=(code:string,uncertain=false)=>Object.assign(new Error(code),{code,uncertain});
const maximumBytes=1_048_576;
/** Additive GROUP-only media port. Never routes a group through a phone sender.
 * Engine receipt must name this group and our own message; no retry in this port. */
export function createEvolutionGroupMediaSender(options:Options){
 const origin=new URL(options.baseUrl),request=options.fetch??globalThis.fetch;
 if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||origin.search||origin.hash
  ||origin.pathname!=='/'||!options.apiKey||!options.instanceKey)throw failure('INVALID_QR_CONFIGURATION');
 return{async sendMedia(context:ProviderContext,recipient:{kind:'GROUP';groupJid:string},input:BinaryMedia){
  if(recipient.kind!=='GROUP'||!/^\d+(?:-\d+)?@g\.us$/u.test(recipient.groupJid)||recipient.groupJid.length>128)throw failure('INVALID_QR_INPUT');
  try{validateMedia(input);if(input.kind==='sticker'&&input.caption)throw new MediaError('MEDIA_CAPTION_UNSUPPORTED');}
  catch(error){throw Object.assign(error as Error,{uncertain:false});}
  const media={...input,bytes:new Uint8Array(input.bytes)};
  const encoded=Buffer.from(media.bytes).toString('base64');
  const body=media.kind==='sticker'?{number:recipient.groupJid,sticker:encoded}:{number:recipient.groupJid,media:encoded,mediatype:media.kind,
   mimetype:media.mimeType,fileName:media.kind==='image'?'image.jpg':safeMediaName(media.fileName),...(media.caption?{caption:media.caption}:{})};
  const route=media.kind==='sticker'?'sendSticker':'sendMedia';
  const remaining=Math.min(options.timeoutMs??15000,context.deadline.getTime()-Date.now());
  if(context.signal.aborted||remaining<=0)throw failure('QR_SEND_NOT_DISPATCHED');
  const signal=AbortSignal.any([context.signal,AbortSignal.timeout(Math.max(1,Math.ceil(remaining)))]);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const bounded=async<T>(work:Promise<T>):Promise<T>=>{
   signal.throwIfAborted();let rejectAbort:(()=>void)|undefined;
   const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=()=>reject(signal.reason);signal.addEventListener('abort',rejectAbort,{once:true});});
   try{return await Promise.race([work,aborted]);}finally{if(rejectAbort)signal.removeEventListener('abort',rejectAbort);}
  };
  try{
   const response=await bounded(request(new URL('message/'+route+'/'+encodeURIComponent(options.instanceKey),origin),{
    method:'POST',headers:{'Content-Type':'application/json',apikey:options.apiKey},redirect:'error',signal,body:JSON.stringify(body)}));
   const length=response.headers.get('content-length');
   if(!response.ok||(length!==null&&(!/^\d+$/u.test(length)||Number(length)>maximumBytes))){void response.body?.cancel().catch(()=>{});throw failure('QR_SEND_UNKNOWN',true);}
   reader=response.body?.getReader();if(!reader)throw failure('QR_SEND_UNKNOWN',true);
   const chunks:Uint8Array[]=[];let size=0;
   for(;;){const chunk=await bounded(reader.read());if(chunk.done)break;size+=chunk.value.byteLength;if(size>maximumBytes)throw failure('QR_SEND_UNKNOWN',true);chunks.push(chunk.value);}
   signal.throwIfAborted();
   const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
   const key=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as Record<string,unknown>).key:null;
   if(!key||typeof key!=='object'||Array.isArray(key))throw failure('QR_SEND_UNKNOWN',true);
   const receipt=key as Record<string,unknown>;
   if(typeof receipt.id!=='string'||!receipt.id||receipt.id.length>256||receipt.remoteJid!==recipient.groupJid||receipt.fromMe!==true)throw failure('QR_SEND_UNKNOWN',true);
   return{status:'ACCEPTED' as const,upstreamMessageId:receipt.id};
  }catch{if(reader)void reader.cancel().catch(()=>{});throw failure('QR_SEND_UNKNOWN',true);}
 }};
}
