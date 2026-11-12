import { createHash } from 'node:crypto';
import { historyCaptureScopeKey } from './history-projection.mjs';
export { createBaileysHistoryMediaDownloader } from './history-media-download.mjs';

/** Host port uses the pinned Baileys decryptor, never an event-supplied URL or
 * the legacy Prisma message cache. Source keys remain in this private process. */
function abortable(promise,signal) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
async function collect(stream,reference,signal) {
  const chunks=[],hash=createHash('sha256');let length=0;
  const iterator=stream[Symbol.asyncIterator]();
  try {
    while(true) {
      const part=await abortable(iterator.next(),signal);if(part.done)break;
      const chunk=part.value;
      if(!(chunk instanceof Uint8Array))throw Error('HISTORY_MEDIA_INTEGRITY');
      length+=chunk.byteLength;
      if(length>reference.byteSize || length>16*1024*1024)throw Error('HISTORY_MEDIA_INTEGRITY');
      const copy=Buffer.from(chunk);chunks.push(copy);hash.update(copy);
    }
    if(length!==reference.byteSize || hash.digest('hex')!==reference.sha256)throw Error('HISTORY_MEDIA_INTEGRITY');
    return Buffer.concat(chunks,length);
  } finally {
    for(const chunk of chunks)chunk.fill(0);
    stream.destroy?.();
    // Some async generators wait for their unresolved next() before return().
    // Abort the network port and release our lease; never await that dead stream.
    Promise.resolve(iterator.return?.()).catch(()=>{});
  }
}

/** One bounded low-priority media operation per tick. Source descriptors/bytes
 * stay KEEP; the final source receipt is correlated and authority-fenced. */
export function createHistoryMediaWorker({journal,assertCurrentScope,download,persist,clock=()=>new Date()}) {
  if(![assertCurrentScope,download,persist,clock].every(value=>typeof value==='function'))throw Error('HISTORY_SOURCE_MEDIA_WORKER_INVALID');
  return Object.freeze({async runOnce(scope,runId,now,{signal:outer}={}) {
    const current=Object.freeze({...scope}),at=new Date(now.getTime());
    const received=await journal.claimMedia(current,runId,at);if(!received)return {kind:'IDLE'};
    if(received.scopeKey!==historyCaptureScopeKey(current)||received.runId!==runId)throw Error('HISTORY_SOURCE_MEDIA_CORRELATION');
    const claim=Object.freeze({...received,reference:Object.freeze({...received.reference}),descriptor:Object.freeze({...received.descriptor})});
    const signal=outer?AbortSignal.any([outer,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000);
    let code='AUTHORITY_CHANGED',bytes;
    try {
      await assertCurrentScope(null,current);signal.throwIfAborted();code='DOWNLOAD_FAILED';
      const stream=await abortable(download(claim.descriptor,{signal}),signal);
      try {bytes=await collect(stream,claim.reference,signal);}
      catch(error) {if(error?.message==='HISTORY_MEDIA_INTEGRITY')code='INTEGRITY_FAILED';throw error;}
      code='AUTHORITY_CHANGED';await assertCurrentScope(null,current);signal.throwIfAborted();code='PERSISTENCE_UNCERTAIN';
      const receipt=await persist(claim.reference,bytes,{scope:current,runId,scopeKey:claim.scopeKey,signal});
      if(await journal.settleMedia(current,claim,receipt,clock(),assertCurrentScope))return {kind:'READY'};
    } catch { /* Only the allowlisted category may escape; URLs/keys/errors stay private. */ }
    finally {bytes?.fill(0);}
    await journal.retryMedia(current,claim,code,clock());
    return {kind:'RETRY',code};
  }});
}
