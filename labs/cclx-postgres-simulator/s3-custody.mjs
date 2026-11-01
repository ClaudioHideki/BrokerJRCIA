import {requireLabOnly} from './state.mjs';
import {createS3PrivateObjectStore,privateObjectKey} from '../../apps/api/dist/modules/messaging/private-object-store.js';

/** Dedicated local synthetic destination only. Never reads production environment defaults. */
export function createLabS3Custody(config,options={}){
 requireLabOnly(options);
 let url;try{url=new URL(config.endpoint);}catch{throw Error('UNSAFE_LAB_S3');}
 if(Object.keys(config).some(key=>!['endpoint','bucket','accessKeyId','secretAccessKey'].includes(key))||
  !['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
  !/^cclx-lab-[a-f0-9-]{36}$/.test(config.bucket))throw Error('UNSAFE_LAB_S3');
 const profile='cclx-lab',store=createS3PrivateObjectStore({...config,profile,region:'us-east-1',dedicatedBucket:true,allowLoopbackHttpForTests:true,requestTimeoutMs:5000});
 const ref=(organizationId,eventId)=>({organizationId,channelId:'00000000-0000-4000-8000-000000000920',mediaId:eventId,operationId:eventId});
 const control=()=>({deadline:new Date(Date.now()+15000)});
 return {
  async persist({organizationId,eventId,bytes,hash}){
   const reference=ref(organizationId,eventId),expected={byteLength:bytes.length,sha256:hash};
   const result=await store.put(reference,bytes,expected,control());
   // Conditional-put conflicts and ambiguous upload results require actual verified GET.
   // Permission/preflight failures remain failures, even if a prior object might exist.
   if(result.outcome!=='CONFIRMED'&&result.code!=='OBJECT_CONFLICT'&&result.outcome!=='UNKNOWN')throw Error(result.code);
   const read=await store.read(reference,expected,control());
   if(read.outcome!=='CONFIRMED')throw Error(read.code??'S3_READBACK_MISSING');
   return {storage:'S3',objectName:privateObjectKey(profile,reference),destinationFingerprint:store.destinationFingerprint,readbackVerified:true,retention:'KEEP'};
  }
 };
}
