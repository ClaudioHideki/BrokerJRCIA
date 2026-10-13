import {z} from 'zod';
import {createChatwootSafeFetch} from '../../integrations/chatwoot-safe-http.js';
import {normalizeChatwootOrigin} from '../../integrations/chatwoot-destination.js';
import {FlowIntrospectionRequestSchema,FlowIntrospectionDecisionSchema,FlowCutoverProofSchema} from '@jrc/contracts';
import {NativeOwnershipRequestSchema} from './native-ownership-contracts.js';
import {FlowDelegationError,type NativeRequest,type FlowDelegationOptions} from './service.js';
import {remoteDeadline} from './remote.js';
const registrationSchema=z.strictObject({organizationId:z.uuid(),origin:z.string(),accountId:z.number().int().positive(),destinationRevision:z.number().int().positive(),revision:z.number().int().positive(),callbackCredential:z.string().regex(/^[A-Za-z0-9_-]{43}$/),expiresAt:z.iso.datetime()});
export type NativeCallbackRegistration=z.infer<typeof registrationSchema>;
export interface NativeAdapterOptions {
 resolveRegistration(context:{organizationId:string;origin:string},signal:AbortSignal):Promise<NativeCallbackRegistration|null>;
 timeoutMs?:number;
 fetch?:typeof globalThis.fetch;
}
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
 });
}
export function createNativeFlowAdapter(options:NativeAdapterOptions):NonNullable<FlowDelegationOptions['nativeAdapter']>{
 const timeoutMs=z.number().int().min(1).max(10000).parse(options.timeoutMs??10000),maxBytes=16384;
 async function current(context:{organizationId:string;origin:string},request:NativeRequest,signal:AbortSignal){
  signal.throwIfAborted();const registration=registrationSchema.parse(await abortable(options.resolveRegistration(context,signal),signal));
  if(registration.organizationId!==context.organizationId||normalizeChatwootOrigin(registration.origin)!==context.origin||registration.origin!==context.origin||registration.accountId!==request.accountId||registration.destinationRevision!==request.destinationRevision||Date.parse(registration.expiresAt)<=Date.now())throw new Error('FLOW_REGISTRATION_CHANGED');
  return registration;
 }
 async function ownership(raw:Record<string,unknown>,callerSignal:AbortSignal,operation:'fence'|'observe'){
  try{
   callerSignal.throwIfAborted();const request=NativeOwnershipRequestSchema.parse(raw);
   const context={organizationId:request.organizationId,origin:normalizeChatwootOrigin(request.origin)};
   if(context.origin!==request.origin||Date.parse(request.leaseExpiresAt)<=Date.now())throw new Error('FLOW_HOST_LEASE_CHANGED');
   return await remoteDeadline(timeoutMs,'FLOW_HOST_FENCE_REQUIRED',async deadlineSignal=>{
    const signal=AbortSignal.any([callerSignal,deadlineSignal]),nativeRequest={nonce:request.nonce,externalActorId:request.externalActorId,accountId:request.accountId,destinationRevision:request.destinationRevision,inboxIds:[request.inboxId]},registration=await current(context,nativeRequest,signal);
    const transport=options.fetch??createChatwootSafeFetch({origin:registration.origin,timeoutMs,maxResponseBytes:maxBytes});
    const response=await abortable(transport(registration.origin+'/api/v1/jrc_flow_native/ownership/'+operation,{method:'POST',redirect:'error',credentials:'omit',signal,headers:{authorization:'Bearer '+registration.callbackCredential,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(request)}),signal);
    if(response.status!==200){void response.body?.cancel().catch(()=>{});throw new Error('FLOW_HOST_STATUS');}
    const reader=response.body?.getReader();if(!reader)throw new Error('FLOW_HOST_BODY_REQUIRED');const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const chunk=await abortable(reader.read(),signal);if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes)throw new Error('FLOW_HOST_BODY_LIMIT');chunks.push(chunk.value);}}finally{void reader.cancel().catch(()=>{});}
    const proof=FlowCutoverProofSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    for(const key of ['organizationId','accountId','inboxId','integrationId','cutoverId','cutoverRevision','expectedOwnerRevision'] as const)if(proof[key]!==request[key])throw new Error('FLOW_HOST_PROOF_CHANGED');
    if(proof.hostSourceSha!==request.expectedHostSourceSha||proof.hostImageDigest!==request.expectedHostImageDigest)throw new Error('FLOW_HOST_IDENTITY_CHANGED');
    const after=await current(context,nativeRequest,signal);signal.throwIfAborted();if(JSON.stringify(after)!==JSON.stringify(registration)||Date.parse(request.leaseExpiresAt)<=Date.now())throw new Error('FLOW_REGISTRATION_CHANGED');return proof;
   });
  }catch{throw new FlowDelegationError('FLOW_HOST_FENCE_REQUIRED',409);}
 }
 return {
  async introspect(raw,context,callerSignal){
   try{
    callerSignal.throwIfAborted();const request=FlowIntrospectionRequestSchema.parse(raw);
    return await remoteDeadline(timeoutMs,'FLOW_HOST_AUTHORITY_UNAVAILABLE',async deadlineSignal=>{
     const signal=AbortSignal.any([callerSignal,deadlineSignal]),registration=await current(context,request,signal);
     const transport=options.fetch??createChatwootSafeFetch({origin:registration.origin,timeoutMs,maxResponseBytes:maxBytes});
     const response=await abortable(transport(registration.origin+'/api/v1/jrc_flow_native/introspect',{method:'POST',redirect:'error',credentials:'omit',signal,
      headers:{authorization:'Bearer '+registration.callbackCredential,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(request)}),signal);
     if(response.status!==200){void response.body?.cancel().catch(()=>{});throw new Error('FLOW_HOST_STATUS');}
     const reader=response.body?.getReader();if(!reader)throw new Error('FLOW_HOST_BODY_REQUIRED');
     const chunks:Uint8Array[]=[];let size=0;
     try{for(;;){const chunk=await abortable(reader.read(),signal);if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes)throw new Error('FLOW_HOST_BODY_LIMIT');chunks.push(chunk.value);}}
     finally{void reader.cancel().catch(()=>{});}
     const decision=FlowIntrospectionDecisionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
     if(decision.nonce!==request.nonce||decision.externalActorId!==request.externalActorId||decision.accountId!==request.accountId||decision.destinationRevision!==request.destinationRevision||JSON.stringify([...decision.inboxIds].sort((a,b)=>a-b))!==JSON.stringify([...request.inboxIds].sort((a,b)=>a-b)))throw new Error('FLOW_HOST_DECISION_CHANGED');
     const after=await current(context,request,signal);signal.throwIfAborted();if(JSON.stringify(after)!==JSON.stringify(registration))throw new Error('FLOW_REGISTRATION_CHANGED');
     return decision;
    });
   }catch{throw new FlowDelegationError('FLOW_HOST_AUTHORITY_UNAVAILABLE',503);}
  },
  fenceAndDrain:(request,signal)=>ownership(request,signal,'fence'),
  observeFence:(request,signal)=>ownership(request,signal,'observe'),
 };
}
