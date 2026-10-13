import {normalizeEvolutionDatabaseError} from './errors.js';
import {randomUUID} from 'node:crypto';
import {EvolutionProviderAdapter} from '@jrc/providers';
import {loadEvolutionFleet,resolveBoundEngine,type EngineBinding} from './config.js';
import type {LifecycleTransaction,CleanupDispatchContext} from '../lifecycle/service.js';
const fail=(code:string)=>Object.assign(new Error(code),{code});
/** The canonical deletion lease is the authority. No instance/table lookup after
 * purge and no URL/token in the persisted cleanup snapshot. */
export function createEvolutionCleanupRuntime(environment:NodeJS.ProcessEnv,transaction:LifecycleTransaction){
 const transact:LifecycleTransaction=async work=>{try{return await transaction(work);}catch(error){throw normalizeEvolutionDatabaseError(error);}};
 const fleet=loadEvolutionFleet(environment);
 const snapshot=async(tx:Parameters<Parameters<LifecycleTransaction>[0]>[0],context:CleanupDispatchContext,mutation:boolean,org?:string,key?:string)=>{
  const row=(await tx.query(`SELECT * FROM public.evolution_cleanup_snapshot($1,$2,$3,$4)`,[context.deletionId,context.lease,context.instanceId,mutation])).rows[0];
  if(!row)throw fail('EVOLUTION_ENGINE_BINDING_REQUIRED');
  if(org!==undefined&&(row.organizationId!==org||row.upstreamKey!==key))throw fail('EVOLUTION_ENGINE_BINDING_CHANGED');
  if(row.traditional===true){if(fleet.size!==1)throw fail('EVOLUTION_ENGINE_REGISTRATION_REQUIRED');return fleet.get('legacy')!;}
  const binding:EngineBinding={engineId:row.engineId,generation:Number(row.generation),destinationFingerprint:row.destinationFingerprint};
  return resolveBoundEngine(fleet,binding);
 };
 const execute=async<T>(org:string,key:string,context:CleanupDispatchContext|undefined,mutation:boolean,invoke:(provider:EvolutionProviderAdapter)=>Promise<T>):Promise<T>=>{
  if(!context)throw fail('EVOLUTION_ENGINE_CLEANUP_LEASE_REQUIRED');
  const engine=await transact(tx=>snapshot(tx,context,mutation,org,key)),token=randomUUID();
  const acquired=(await transact(tx=>tx.query(`SELECT public.evolution_acquire_cleanup($1,$2,$3,$4,$5) AS acquired`,[context.deletionId,context.lease,context.instanceId,token,mutation]))).rows[0];
  if(acquired?.acquired!==true)throw fail('EVOLUTION_ENGINE_RETRY_LATER');
  let dispatched=false;
  try{
   await transact(tx=>snapshot(tx,context,mutation,org,key));dispatched=true;
   const result=await invoke(new EvolutionProviderAdapter(engine.providerOptions()));
   await transact(async tx=>{const current=await snapshot(tx,context,mutation,org,key);if(current.destinationFingerprint!==engine.destinationFingerprint||current.generation!==engine.generation)throw fail('EVOLUTION_ENGINE_BINDING_CHANGED');
    // Unregistered traditional installations do not acquire an engine quota.
    await tx.query(`SELECT public.evolution_settle_cleanup($1,$2,$3,$4,true,false)`,[context.deletionId,context.lease,context.instanceId,token]);
   });return result;
  }catch(error){
   if(dispatched)await transact(tx=>tx.query(`SELECT public.evolution_settle_cleanup($1,$2,$3,$4,false,$5)`,[context.deletionId,context.lease,context.instanceId,token,mutation])).catch(()=>undefined);
   throw error;
  }
 };
 return{
  deprovision:(org:string,key:string,context?:CleanupDispatchContext)=>execute(org,key,context,true,p=>p.deprovisionInstance({organizationId:org,requestId:randomUUID(),deadline:new Date(Date.now()+30000),signal:AbortSignal.timeout(30000)},{id:key})),
  instanceExists:(org:string,key:string,context?:CleanupDispatchContext)=>execute(org,key,context,false,async p=>(await p.lookupInstance({organizationId:org,requestId:randomUUID(),deadline:new Date(Date.now()+30000),signal:AbortSignal.timeout(30000)},{id:key})).exists),
  assertCleanup:async(tx:Parameters<Parameters<LifecycleTransaction>[0]>[0],context:CleanupDispatchContext,mutation:boolean)=>{await snapshot(tx,context,mutation);},
 };
}
