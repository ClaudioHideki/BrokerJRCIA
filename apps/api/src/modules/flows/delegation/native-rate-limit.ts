import {createHmac} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import {assertRuntimeRateLimitStore} from '../../auth/rate-limit/memory-store.js';
import {resolveClientIp} from '../../auth/rate-limit/keys.js';
import type {RateLimitStore} from '../../auth/rate-limit/store.js';
import {FlowDelegationError} from './service.js';
export interface NativeRateLimitOptions {store:RateLimitStore;secret:string;nodeEnv:'development'|'test'|'production';trustedProxyCidrs:readonly string[];ipLimit:number;identityLimit:number;windowMs:number}
export class NativeRateLimitError extends FlowDelegationError {
 constructor(code:string,status:number,readonly retryAfter:number){super(code,status);}
}
export function createNativeRateLimit(options:NativeRateLimitOptions){
 assertRuntimeRateLimitStore(options.store,options.nodeEnv);
 if(Buffer.byteLength(options.secret)<32||![options.ipLimit,options.identityLimit,options.windowMs].every(value=>Number.isSafeInteger(value)&&value>0))throw new Error('FLOW_RATE_LIMIT_CONFIGURATION_REQUIRED');
 const key=(kind:'ip'|'identity',values:unknown[])=>`${kind}:${createHmac('sha256',options.secret).update(JSON.stringify(['flow-native',...values])).digest('hex')}`;
 async function consume(kind:'ip'|'identity',values:unknown[]){
  let decision;try{decision=await options.store.consume(key(kind,values),kind==='ip'?options.ipLimit:options.identityLimit,options.windowMs);}catch{throw new NativeRateLimitError('FLOW_RATE_LIMIT_UNAVAILABLE',503,5);}
  if(!decision.allowed)throw new NativeRateLimitError('FLOW_RATE_LIMITED',429,Math.max(1,Math.ceil(decision.retryAfterMs/1000)));
 }
 return {
  async ip(request:FastifyRequest){
   let address;try{address=resolveClientIp({remoteAddress:request.socket.remoteAddress??request.ip,...(request.headers['x-forwarded-for']?{forwardedFor:request.headers['x-forwarded-for']}:{}),trustedProxyCidrs:options.trustedProxyCidrs});}catch{throw new FlowDelegationError('INVALID_REQUEST',400);}
   await consume('ip',[request.method,request.routeOptions.url,address]);
  },
  async identity(request:FastifyRequest,organizationId:string,identity:string,actor:string){
   await consume('identity',[request.method,request.routeOptions.url,organizationId,identity]);
   await consume('identity',[request.method,request.routeOptions.url,organizationId,identity,actor]);
  },
 };
}
