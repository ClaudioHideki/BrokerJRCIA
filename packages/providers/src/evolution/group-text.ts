import type {EvolutionMessagingClient,ProviderContext} from '@jrc/providers';
type Options=ConstructorParameters<typeof EvolutionMessagingClient>[0];
const failure=(code:string)=>Object.assign(new Error(code),{code});
const maximumBytes=1_048_576;
/** Source-proven sendText route; GROUP is explicit and never converted to a phone.
 * Every post-dispatch failure is uncertain. There is no retry in this port. */
export function createEvolutionGroupTextSender(options:Options) {
  const origin=new URL(options.baseUrl),request=options.fetch??globalThis.fetch;
  if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||origin.search||origin.hash
    ||origin.pathname!=='/'||!options.apiKey||!options.instanceKey)throw failure('INVALID_QR_CONFIGURATION');
  return {async sendText(context:ProviderContext,recipient:{kind:'GROUP';groupJid:string},text:string) {
    if(recipient.kind!=='GROUP'||!/^\d+(?:-\d+)?@g\.us$/u.test(recipient.groupJid)||recipient.groupJid.length>128
      ||typeof text!=='string'||!text.trim()||text.length>4096)throw failure('INVALID_QR_INPUT');
    const remaining=Math.min(options.timeoutMs??15000,context.deadline.getTime()-Date.now());
    if(context.signal.aborted||remaining<=0)throw failure('QR_SEND_NOT_DISPATCHED');
    const signal=AbortSignal.any([context.signal,AbortSignal.timeout(Math.max(1,Math.ceil(remaining)))]);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    // The deadline also bounds injected fetch implementations and stalled bodies.
    const bounded=async<T>(work:Promise<T>):Promise<T>=>{
      signal.throwIfAborted();let rejectAbort:(()=>void)|undefined;
      const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=()=>reject(signal.reason);signal.addEventListener('abort',rejectAbort,{once:true});});
      try{return await Promise.race([work,aborted]);}finally{if(rejectAbort)signal.removeEventListener('abort',rejectAbort);}
    };
    try {
      const response=await bounded(request(new URL(`message/sendText/${encodeURIComponent(options.instanceKey)}`,origin),{
        method:'POST',headers:{'Content-Type':'application/json',apikey:options.apiKey},redirect:'error',signal,
        body:JSON.stringify({number:recipient.groupJid,text,linkPreview:false})}));
      const length=response.headers.get('content-length');
      if(!response.ok||(length!==null&&(!/^\d+$/u.test(length)||Number(length)>maximumBytes))) {
        void response.body?.cancel().catch(()=>{});throw failure('QR_SEND_UNKNOWN');
      }
      reader=response.body?.getReader();if(!reader)throw failure('QR_SEND_UNKNOWN');
      const chunks:Uint8Array[]=[];let size=0;
      for(;;){const chunk=await bounded(reader.read());if(chunk.done)break;size+=chunk.value.byteLength;
        if(size>maximumBytes)throw failure('QR_SEND_UNKNOWN');chunks.push(chunk.value);}
      signal.throwIfAborted();
      const body:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      const key=body&&typeof body==='object'&&!Array.isArray(body)?(body as Record<string,unknown>).key:null;
      if(!key||typeof key!=='object'||Array.isArray(key))throw failure('QR_SEND_UNKNOWN');
      const receipt=key as Record<string,unknown>;
      if(typeof receipt.id!=='string'||!receipt.id||receipt.id.length>256||receipt.remoteJid!==recipient.groupJid
        ||receipt.fromMe!==true)throw failure('QR_SEND_UNKNOWN');
      return {status:'ACCEPTED' as const,upstreamMessageId:receipt.id};
    }catch{if(reader)void reader.cancel().catch(()=>{});throw failure('QR_SEND_UNKNOWN');}
  }};
}
