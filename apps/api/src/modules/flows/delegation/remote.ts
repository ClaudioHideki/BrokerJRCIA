import {FlowDelegationError} from './service.js';
/** Configured server budget, independent of any editor input. Late adapter
 * results cannot settle a lease; the caller retains UNKNOWN after a timeout. */
export async function remoteDeadline<T>(timeoutMs:number,code:string,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work(controller.signal),new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>{controller.abort();reject(new FlowDelegationError(code,503));},timeoutMs);
 })]);}finally{clearTimeout(timer);}
}
