import { createDecipheriv,createHmac,timingSafeEqual } from 'node:crypto';

const maximum=16*1024*1024+26;
/** The pinned Baileys 7.0.0-rc.9 getHttpStream drops signal/redirect options.
 * Keep its getMediaKeys derivation port, but own the narrow bounded HTTP and
 * authenticated CBC stream here. No global fetch patch or vendor edit.
 * Protocol reference: github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc.9/src/Utils/messages-media.ts
 */
export function createBaileysHistoryMediaDownloader({getMediaKeys,fetch:transport=globalThis.fetch}) {
  if(typeof getMediaKeys!=='function'||typeof transport!=='function')throw Error('HISTORY_SOURCE_MEDIA_DOWNLOADER_REQUIRED');
  return async(descriptor,{signal})=>{
    signal.throwIfAborted();
    const mediaType={IMAGE:'image',AUDIO:'audio',VIDEO:'video',DOCUMENT:'document',STICKER:'image'}[descriptor.mediaType];
    if(!mediaType || !/^\/(?!\/)[A-Za-z\d._~!$&'()*+,;=:@%/?-]{1,4000}$/u.test(descriptor.directPath)
      || !/^[A-Za-z\d+/]{43}=$/u.test(descriptor.mediaKey))throw Error('HISTORY_SOURCE_MEDIA_DESCRIPTOR_INVALID');
    const derived=await getMediaKeys(Buffer.from(descriptor.mediaKey,'base64'),mediaType);
    if(![[derived?.iv,16],[derived?.cipherKey,32],[derived?.macKey,32]].every(([key,size])=>key instanceof Uint8Array&&key.length===size))
      throw Error('HISTORY_SOURCE_MEDIA_KEYS_INVALID');
    signal.throwIfAborted();
    const response=await transport(`https://mmg.whatsapp.net${descriptor.directPath}`,{
      method:'GET',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Origin:'https://web.whatsapp.com'},
    });
    const length=response.headers.get('content-length');
    if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});throw Error('HISTORY_SOURCE_MEDIA_DOWNLOAD_FAILED');}
    if(length!==null&&(!/^\d+$/u.test(length)||Number(length)>maximum)) {
      void response.body.cancel().catch(()=>{});throw Error('HISTORY_SOURCE_MEDIA_LIMIT');
    }
    const iv=Buffer.from(derived.iv),cipherKey=Buffer.from(derived.cipherKey),macKey=Buffer.from(derived.macKey);
    return (async function*(){
      const reader=response.body.getReader(),decipher=createDecipheriv('aes-256-cbc',cipherKey,iv),mac=createHmac('sha256',macKey).update(iv);
      let tail=Buffer.alloc(0),received=0;
      try {
        for(;;) {
          signal.throwIfAborted();const part=await reader.read();if(part.done)break;
          received+=part.value.byteLength;if(received>maximum)throw Error('HISTORY_SOURCE_MEDIA_LIMIT');
          const pending=Buffer.concat([tail,part.value]);
          if(pending.length<=10){tail=pending;continue;}
          const encrypted=pending.subarray(0,pending.length-10);tail=Buffer.from(pending.subarray(-10));
          mac.update(encrypted);const clear=decipher.update(encrypted);if(clear.length)yield clear;
        }
        if(tail.length!==10||!timingSafeEqual(tail,mac.digest().subarray(0,10)))throw Error('HISTORY_SOURCE_MEDIA_INTEGRITY');
        const clear=decipher.final();if(clear.length)yield clear;
      } finally {
        void reader.cancel().catch(()=>{});reader.releaseLock();iv.fill(0);cipherKey.fill(0);macKey.fill(0);tail.fill(0);
      }
    })();
  };
}
