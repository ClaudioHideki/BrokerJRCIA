import {normalizeEvolutionDatabaseError} from './errors.js';
import {randomUUID} from 'node:crypto';
import {EvolutionProviderAdapter,EvolutionWorkspaceClient,EvolutionGroupsClient,EvolutionMessagingClient,createEvolutionGroupTextSender,
 type ProviderContext,type WhatsAppProvider,type WhatsAppProviderAdmin} from '@jrc/providers';
import type {TenantTransaction,OrganizationTransaction} from '../../db/tenant-transaction.js';
import {loadEvolutionFleet,resolveBoundEngine,type EvolutionEngine,type EngineBinding} from './config.js';
export type FleetTransaction=<T>(org:string,work:OrganizationTransaction<T>)=>Promise<T>;
export interface EngineSnapshot extends EngineBinding{organizationId:string;instanceId:string;upstreamKey:string;state:'ACTIVE'|'DRAINING'|'DISABLED';traditional:boolean}
export interface FleetLease{token:string;snapshot:EngineSnapshot}
export interface FleetStore{
 resolve(org:string,key:string,operationId?:string,tx?:TenantTransaction):Promise<EngineSnapshot>;
 acquire(snapshot:EngineSnapshot,mutation:boolean,deadline:Date,operationId?:string,intent?:ProviderContext['engineIntent']):Promise<FleetLease>;
 assert(snapshot:EngineSnapshot,tx?:TenantTransaction,mutation?:boolean):Promise<void>;
 settle(lease:FleetLease,ok:boolean,code:string|null,uncertain?:boolean):Promise<void>;
}
type Factories={provider:(engine:EvolutionEngine)=>WhatsAppProvider&WhatsAppProviderAdmin;
 workspace:(engine:EvolutionEngine)=>Pick<EvolutionWorkspaceClient,'read'|'updateSettings'>;
 groups:(engine:EvolutionEngine)=>Pick<EvolutionGroupsClient,'list'>;
 messaging:(engine:EvolutionEngine,key:string)=>EvolutionMessagingClient;
 groupText:(engine:EvolutionEngine,key:string)=>ReturnType<typeof createEvolutionGroupTextSender>};
const fault=(code:string)=>Object.assign(new Error(code),{code,uncertain:false});
function rowSnapshot(row:Record<string,unknown>,org:string,key:string):EngineSnapshot{
 const generation=Number(row.generation);
 if(typeof row.instanceId!=='string'||typeof row.engineId!=='string'||!Number.isSafeInteger(generation)||generation<=0||typeof row.destinationFingerprint!=='string')throw fault('EVOLUTION_ENGINE_BINDING_REQUIRED');
 return {organizationId:org,instanceId:row.instanceId,upstreamKey:key,engineId:row.engineId,generation,
  destinationFingerprint:row.destinationFingerprint,state:row.state as EngineSnapshot['state'],traditional:row.traditional===true};
}
export function createPostgresFleetStore(transaction:FleetTransaction,fleet:ReadonlyMap<string,EvolutionEngine>):FleetStore{
 const transact:FleetTransaction=async(org,work)=>{try{return await transaction(org,work);}catch(error){throw normalizeEvolutionDatabaseError(error);}};
 const legacy=fleet.get('legacy')!;
 const resolve=async(org:string,key:string,operationId?:string,existingTx?:TenantTransaction)=>{
  const work=async(tx:TenantTransaction)=>{
  const result=await tx.query(`SELECT * FROM public.evolution_resolve_binding($1,$2,$3)`,[org,key,operationId??null]);
  const row=result.rows[0];if(!row)throw fault('EVOLUTION_ENGINE_BINDING_REQUIRED');
  if(row.traditional===true){
   if(fleet.size!==1)throw fault('EVOLUTION_ENGINE_REGISTRATION_REQUIRED');
   return rowSnapshot({...row,engineId:'legacy',generation:legacy.generation,destinationFingerprint:legacy.destinationFingerprint,state:'ACTIVE'},org,key);
  }
  return rowSnapshot(row,org,key);
  };return existingTx?work(existingTx):transact(org,work);
 };
 const assert=async(snapshot:EngineSnapshot,tx?:TenantTransaction,mutation=false)=>{
  const work=async(client:TenantTransaction)=>{
   const result=await client.query(`SELECT public.evolution_assert_binding($1,$2,$3,$4,$5,$6,$7) AS valid`,
    [snapshot.organizationId,snapshot.instanceId,snapshot.engineId,snapshot.generation,snapshot.destinationFingerprint,snapshot.traditional,mutation]);
   if(result.rows[0]?.valid!==true)throw fault('EVOLUTION_ENGINE_BINDING_CHANGED');
  };if(tx)await work(tx);else await transact(snapshot.organizationId,work);
 };
 return{resolve,assert,
  acquire:async(snapshot,mutation,deadline,operationId,intent)=>{
   if(deadline.getTime()<=Date.now())throw fault('EVOLUTION_ENGINE_DEADLINE_EXPIRED');
   if(snapshot.traditional)return{token:'traditional',snapshot};
   const token=randomUUID();const result=await transact(snapshot.organizationId,tx=>tx.query(`SELECT public.evolution_acquire_io($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS acquired`,
    [snapshot.organizationId,snapshot.instanceId,snapshot.engineId,snapshot.generation,snapshot.destinationFingerprint,token,mutation,
     Math.max(1,Math.min(60000,deadline.getTime()-Date.now())),operationId??null,intent?JSON.stringify(intent):null]));
   if(result.rows[0]?.acquired!==true)throw fault('EVOLUTION_ENGINE_RETRY_LATER');return{token,snapshot};
  },
  settle:async(lease,ok,code,uncertain=false)=>{if(!lease.snapshot.traditional){const result=await transact(lease.snapshot.organizationId,tx=>tx.query(
   `SELECT public.evolution_settle_io($1,$2,$3,$4,$5,$6) AS settled`,[lease.snapshot.organizationId,lease.snapshot.instanceId,lease.token,ok,code,uncertain]));
   if(result.rows[0]?.settled!==true)throw fault('EVOLUTION_ENGINE_LEASE_CHANGED');}},
 };
}
/** Private runtime composition. No browser or callback chooses an engine. */
export function createEvolutionFleetRuntime(environment:Record<string,string|undefined>,transact:FleetTransaction|undefined,
 options:{store?:FleetStore;factories?:Partial<Factories>}={}){
 const fleet=loadEvolutionFleet(environment);
 if(!options.store&&!transact)throw new Error('EVOLUTION_FLEET_TRANSACTION_REQUIRED');
 const store=options.store??createPostgresFleetStore(transact!,fleet);
 const factories:Factories={provider:engine=>new EvolutionProviderAdapter(engine.providerOptions()),
  workspace:engine=>new EvolutionWorkspaceClient(engine.providerOptions()),groups:engine=>new EvolutionGroupsClient(engine.providerOptions()),
  messaging:(engine,key)=>new EvolutionMessagingClient({...engine.providerOptions(),instanceKey:key}),
  groupText:(engine,key)=>createEvolutionGroupTextSender({...engine.providerOptions(),instanceKey:key}),...options.factories};
 const capture=(org:string,key:string,operationId?:string,tx?:TenantTransaction)=>store.resolve(org,key,operationId,tx);
 const same=(a:EngineSnapshot,b:EngineSnapshot)=>a.instanceId===b.instanceId&&a.organizationId===b.organizationId&&a.engineId===b.engineId&&a.generation===b.generation&&a.destinationFingerprint===b.destinationFingerprint&&a.traditional===b.traditional;
 const execute=async<T>(context:ProviderContext,key:string,mutation:boolean,invoke:(engine:EvolutionEngine)=>Promise<T>,pinned?:EngineSnapshot,reconciliation=false):Promise<T>=>{
  const snapshot=await capture(context.organizationId,key,context.engineOperationId);
  if(pinned&&!same(snapshot,pinned))throw fault('EVOLUTION_ENGINE_BINDING_CHANGED');
  const engine=resolveBoundEngine(fleet,snapshot);
  if(snapshot.state==='DISABLED'&&(mutation||!reconciliation))throw fault('EVOLUTION_ENGINE_DISABLED');
  if(context.signal.aborted||context.deadline.getTime()<=Date.now())throw fault('EVOLUTION_ENGINE_DEADLINE_EXPIRED');
  let lease:FleetLease;
  try{lease=await store.acquire(snapshot,mutation,context.deadline,context.engineOperationId,context.engineIntent);}catch(error){throw Object.assign(error as Error,{uncertain:false});}
  let dispatched=false,received=false;
  try{
   await store.assert(snapshot,undefined,mutation||!reconciliation);
   dispatched=true;const result=await invoke(engine);received=true;
   await store.assert(snapshot,undefined,mutation||!reconciliation);await store.settle(lease,true,null);return result;
  }catch(error){
   const candidate=error instanceof Error?error:Object.assign(new Error('PROVIDER_OPERATION_FAILED'),{code:'PROVIDER_OPERATION_FAILED'});
   const coded=candidate as Error&{code?:string;canonicalErrorCode?:string;uncertain?:boolean};
   const code=coded.code??coded.canonicalErrorCode??'PROVIDER_OPERATION_FAILED';
   // Preserve historical provider error classification without a registry.
   // New binding/confirmation failures still carry explicit uncertainty.
   if(snapshot.traditional&&!received&&!code.startsWith('EVOLUTION_ENGINE_')){await store.settle(lease,false,code,coded.uncertain===true).catch(()=>undefined);throw coded;}
   const knownRejection=['INVALID_QR_INPUT','QR_REQUEST_REJECTED','QR_RATE_LIMITED','QR_SEND_NOT_DISPATCHED','INVALID_PROVIDER_CONTEXT'].includes(code)||coded.uncertain===false;
   coded.uncertain=mutation&&dispatched&&(received||!knownRejection);
   await store.settle(lease,false,code,coded.uncertain).catch(()=>undefined);
   throw coded;
  }
 };
 const provider:WhatsAppProvider&WhatsAppProviderAdmin={kind:'BAILEYS',
  provisionInstance:(c,i)=>execute(c,i.upstreamInstanceKey,true,e=>factories.provider(e).provisionInstance(c,i)),
  beginConnection:(c,i)=>execute(c,i.reference.id,true,e=>factories.provider(e).beginConnection(c,i)),
  getStatus:(c,i)=>execute(c,i.id,false,e=>factories.provider(e).getStatus(c,i),undefined,true),
  disconnect:(c,i)=>execute(c,i.id,true,e=>factories.provider(e).disconnect(c,i)),
  lookupInstance:(c,i)=>execute(c,i.id,false,e=>factories.provider(e).lookupInstance(c,i),undefined,true),
  reconcileProvisioning:(c,i)=>execute(c,i.upstreamInstanceKey,true,e=>factories.provider(e).reconcileProvisioning(c,i)),
  deprovisionInstance:(c,i)=>execute(c,i.id,true,e=>factories.provider(e).deprovisionInstance(c,i)),
 };
 const workspace:Pick<EvolutionWorkspaceClient,'read'|'updateSettings'>={read:(c,k)=>execute(c,k,false,e=>factories.workspace(e).read(c,k),undefined,true),
  updateSettings:(c,k,s)=>execute(c,k,true,e=>factories.workspace(e).updateSettings(c,k,s))};
 const groups:Pick<EvolutionGroupsClient,'list'>={list:(c,k)=>execute(c,k,false,e=>factories.groups(e).list(c,k))};
 const messaging=async(org:string,key:string,intent?:ProviderContext['engineIntent']):Promise<EvolutionMessagingClient>=>{
  const pinned=await capture(org,key);const initial=factories.messaging(resolveBoundEngine(fleet,pinned),key);
  const methods=new Set(['sendText','sendMedia','downloadMedia','configureWebhook','readWebhookConfiguration']);
  return new Proxy(initial,{get(target,property){if(!methods.has(String(property)))return Reflect.get(target,property,target);
   return async(...args:unknown[])=>{
    const supplied=args.at(-1) as Partial<ProviderContext>|undefined;
    const context:ProviderContext=supplied?.organizationId===org&&supplied.deadline instanceof Date&&supplied.signal instanceof AbortSignal?
     supplied as ProviderContext:{organizationId:org,requestId:randomUUID(),deadline:new Date(Date.now()+30000),signal:AbortSignal.timeout(30000)};
    return execute({...context,...(intent?{engineIntent:intent}:{})},key,!['downloadMedia','readWebhookConfiguration'].includes(String(property)),engine=>{
     const client=factories.messaging(engine,key);return(Reflect.get(client,property,client) as (...args:unknown[])=>Promise<unknown>).apply(client,args);
    },pinned,String(property)==='readWebhookConfiguration');
   };
  }});
 };
 const webhook=async(org:string,key:string,channelId:string)=>{
  const snapshot=await capture(org,key);const engine=resolveBoundEngine(fleet,snapshot);
  return{reconciliationOnly:snapshot.state==='DISABLED',token:engine.webhookToken({organizationId:org,channelId,instanceId:snapshot.instanceId,upstreamKey:key}),
   assert:(tx:TenantTransaction)=>store.assert(snapshot,tx)};
 };
 const guardOperation=async(tx:TenantTransaction,org:string,operationId:string,mutation=false)=>{
  const result=await tx.query(`SELECT public.evolution_assert_operation($1,$2,$3) AS valid`,[org,operationId,mutation]);
  if(result.rows[0]?.valid!==true)throw fault('EVOLUTION_ENGINE_BINDING_CHANGED');
 };
 return{provider,workspace,groups,messaging,webhook,capture,assert:store.assert,guardOperation,
  groupText:(c:ProviderContext,k:string,r:{kind:'GROUP';groupJid:string},text:string)=>execute(c,k,true,e=>factories.groupText(e,k).sendText(c,r,text)),
  // Preserve G3's historical configuration fingerprint when fleet is absent.
  configurationScope:(origin:string)=>fleet.size===1?JSON.stringify([environment.EVOLUTION_BASE_URL,origin,environment.QR_WEBHOOK_SIGNING_KEY]):JSON.stringify(['evolution-fleet:v1',origin,[...fleet.values()].map(engine=>engine.metadata())]),
 };
}
export type EvolutionFleetRuntime=ReturnType<typeof createEvolutionFleetRuntime>;
