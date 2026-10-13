import {z} from 'zod';
import {createChatwootSafeFetch} from '../../../integrations/chatwoot-safe-http.js';
import {normalizeChatwootOrigin} from '../../../integrations/chatwoot-destination.js';
import {remoteDeadline} from '../remote.js';
import {InstallationProofSchema} from './contracts.js';
import type {InstallationOptions} from './service.js';
export function createInstallationVerifier(options:{fetch?:typeof fetch;timeoutMs?:number}={}):InstallationOptions['verifyHost']{
 const timeoutMs=z.number().int().min(1).max(10000).parse(options.timeoutMs??10000),limit=16384;
 return async(raw,context)=>remoteDeadline(timeoutMs,'FLOW_INSTALLATION_HOST_UNAVAILABLE',async signal=>{
  const input=InstallationProofSchema.parse(raw),origin=normalizeChatwootOrigin(context.origin);
  if(origin!==context.origin||!/^[A-Za-z0-9_-]{43}$/.test(context.callbackCredential))throw new Error('FLOW_INSTALLATION_DENIED');
  const body=JSON.stringify(input);if(Buffer.byteLength(body)>limit)throw new Error('FLOW_INSTALLATION_TOO_LARGE');
  const transport=options.fetch??createChatwootSafeFetch({origin,timeoutMs,maxResponseBytes:limit});
  const response=await transport(origin+'/api/v1/jrc_flow_native/installation-challenge',{method:'POST',redirect:'error',credentials:'omit',signal,headers:{authorization:'Bearer '+context.callbackCredential,'content-type':'application/json',accept:'application/json'},body});
  const length=response.headers.get('content-length');if(response.status!==200||length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)){void response.body?.cancel();throw new Error('FLOW_INSTALLATION_INVALID_RESPONSE');}
  const reader=response.body?.getReader();if(!reader)throw new Error('FLOW_INSTALLATION_INVALID_RESPONSE');let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw new Error('FLOW_INSTALLATION_INVALID_RESPONSE');chunks.push(next.value);}}finally{void reader.cancel().catch(()=>{});}
  signal.throwIfAborted();const value=InstallationProofSchema.extend({authorized:z.literal(true)}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))),{authorized,...echo}=value;
  if(!authorized||JSON.stringify(echo)!==JSON.stringify(input))throw new Error('FLOW_INSTALLATION_INVALID_RESPONSE');return value;
 });
}
