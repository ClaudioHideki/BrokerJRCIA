import {z} from 'zod';
import {createChatwootSafeFetch} from '../../../integrations/chatwoot-safe-http.js';
import {normalizeChatwootOrigin} from '../../../integrations/chatwoot-destination.js';
import {remoteDeadline} from '../remote.js';
import {FlowDelegationError} from '../service.js';
import {RegistrationVerificationSchema,RegistrationVerificationDecisionSchema,type NativeRegistrationServiceOptions} from './service.js';
const maxBytes=65536;
function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});}
/** The larger limit belongs only to registration tuples; native introspection stays16KiB. */
export function createNativeRegistrationVerifier(options:{fetch?:typeof fetch;timeoutMs?:number}={}):NativeRegistrationServiceOptions['verifyHost']{
 const timeoutMs=z.number().int().min(1).max(10000).parse(options.timeoutMs??10000);
 return async(raw,context)=>{try{
  const request=RegistrationVerificationSchema.parse(raw),origin=normalizeChatwootOrigin(context.origin);
  if(origin!==context.origin||!/^[A-Za-z0-9_-]{43}$/.test(context.callbackCredential))throw new Error();
  const body=JSON.stringify(request);if(Buffer.byteLength(body)>maxBytes)throw new Error();
  return await remoteDeadline(timeoutMs,'FLOW_REGISTRATION_HOST_UNAVAILABLE',async signal=>{
   const transport=options.fetch??createChatwootSafeFetch({origin,timeoutMs,maxResponseBytes:maxBytes});
   const response=await bounded(transport(origin+'/api/v1/jrc_flow_native/registration-challenge',{method:'POST',redirect:'error',credentials:'omit',signal,headers:{authorization:'Bearer '+context.callbackCredential,'content-type':'application/json',accept:'application/json'},body}),signal);
   const length=response.headers.get('content-length');
   if(response.status!==200||length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){void response.body?.cancel().catch(()=>{});throw new Error();}
   const reader=response.body?.getReader();if(!reader)throw new Error();let size=0;const chunks:Uint8Array[]=[];
   try{for(;;){const next=await bounded(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)throw new Error();chunks.push(next.value);}}finally{void reader.cancel().catch(()=>{});}
   signal.throwIfAborted();const decision=RegistrationVerificationDecisionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   const {authorized,...echo}=decision;if(!authorized||JSON.stringify(echo)!==JSON.stringify(request))throw new Error();return decision;
  });
 }catch{throw new FlowDelegationError('FLOW_REGISTRATION_HOST_UNAVAILABLE',503);}};
}
