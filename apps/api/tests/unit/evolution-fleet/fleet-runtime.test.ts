import {describe,it,expect,vi} from 'vitest';
import {createEvolutionFleetRuntime,type FleetStore,type EngineSnapshot} from '../../../src/modules/evolution-fleet/runtime.js';
import {loadEvolutionFleet} from '../../../src/modules/evolution-fleet/config.js';

const env={EVOLUTION_BASE_URL:'http://legacy:8080',EVOLUTION_API_KEY:'legacy-key-private',QR_WEBHOOK_SIGNING_KEY:'legacy-signing-key-private-32-bytes',EVOLUTION_EAST_API_KEY:'east-key-private',EVOLUTION_EAST_SIGNING_KEY:'east-signing-key-private-32-bytes',EVOLUTION_ENGINES_JSON:JSON.stringify({east:{baseUrl:'http://east:8080',apiKeyEnv:'EVOLUTION_EAST_API_KEY',signingKeyEnv:'EVOLUTION_EAST_SIGNING_KEY',generation:2,sessionBudget:8}})};
const context={organizationId:'org-a',requestId:'request',signal:new AbortController().signal,deadline:new Date(Date.now()+30000)};
function fixture(){
 const engine=loadEvolutionFleet(env).get('east')!;
 const snapshot:EngineSnapshot={organizationId:'org-a',instanceId:'instance',upstreamKey:'upstream-a',engineId:'east',generation:2,destinationFingerprint:engine.destinationFingerprint,state:'ACTIVE',traditional:false};
 const store:FleetStore={resolve:vi.fn(async()=>snapshot),acquire:vi.fn(async()=>({token:'lease',snapshot})),assert:vi.fn(async()=>undefined),settle:vi.fn(async()=>undefined)};
 const calls:Array<{engine:string;method:string}>=[];
 const factory=(engine: {id:string})=>new Proxy({}, {get:(_t,method)=>method==='then'?undefined:async()=>{calls.push({engine:engine.id,method:String(method)});return method==='lookupInstance'?{exists:false}:method==='getStatus'?'CONNECTED':undefined;}}) as any;
 const runtime=createEvolutionFleetRuntime(env,undefined,{store,factories:{provider:factory,workspace:factory,groups:factory,messaging:factory}});
 return{snapshot,store,calls,runtime};
}
describe('fleet router',()=>{
 it.each(['provisionInstance','beginConnection','getStatus','disconnect','lookupInstance','reconcileProvisioning','deprovisionInstance'])('routes provider %s using the persisted engine',async(method)=>{
  const f=fixture();const input=method==='provisionInstance'||method==='reconcileProvisioning'?{upstreamInstanceKey:'upstream-a',providerAccountId:'pa'}:method==='beginConnection'?{reference:{id:'upstream-a'}}:{id:'upstream-a'};
  await (f.runtime.provider as any)[method](context,input);expect(f.calls).toEqual([{engine:'east',method}]);expect(f.store.assert).toHaveBeenCalled();
 });
 it.each(['read','updateSettings'])('routes workspace %s and checks after I/O',async method=>{const f=fixture();await(f.runtime.workspace as any)[method](context,'upstream-a',{});expect(f.calls[0]?.engine).toBe('east');expect(f.store.assert).toHaveBeenCalled();});
 it('routes groups and every messaging method without selecting an engine from input',async()=>{
  const f=fixture();await f.runtime.groups.list(context,'upstream-a');const client=await f.runtime.messaging('org-a','upstream-a');
  for(const method of ['sendText','sendMedia','downloadMedia','configureWebhook','readWebhookConfiguration'])await(client as any)[method]('synthetic',{},context);
  expect(f.calls).toHaveLength(6);expect(f.calls.every(c=>c.engine==='east')).toBe(true);
 });
 it('rejects missing/changed configuration before network and never falls back',async()=>{
  const f=fixture();f.snapshot.engineId='missing';await expect(f.runtime.provider.getStatus(context,{id:'upstream-a'})).rejects.toMatchObject({code:'EVOLUTION_ENGINE_UNAVAILABLE'});expect(f.calls).toEqual([]);
 });
 it('does not confirm a mutation after destination changes during I/O',async()=>{
  const f=fixture();vi.mocked(f.store.assert).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('changed'),{code:'EVOLUTION_ENGINE_BINDING_CHANGED'}));
  await expect(f.runtime.provider.disconnect(context,{id:'upstream-a'})).rejects.toMatchObject({code:'EVOLUTION_ENGINE_BINDING_CHANGED',uncertain:true});expect(f.calls).toHaveLength(1);
 });
 it('does not dispatch while a persisted backoff/engine budget is active',async()=>{
  const f=fixture();vi.mocked(f.store.acquire).mockRejectedValueOnce(Object.assign(new Error('backoff'),{code:'EVOLUTION_ENGINE_RETRY_LATER'}));
  await expect(f.runtime.provider.beginConnection(context,{reference:{id:'upstream-a'}})).rejects.toMatchObject({code:'EVOLUTION_ENGINE_RETRY_LATER',uncertain:false});expect(f.calls).toHaveLength(0);
 });
 it('uses engine scoped callback tokens and checks the binding in the ingestion transaction',async()=>{
  const f=fixture();const a=await f.runtime.webhook('org-a','upstream-a','channel-a');const b=await f.runtime.webhook('org-a','upstream-a','channel-b');
  expect(a.token).not.toBe(b.token);expect(a.token).toHaveLength(43);await a.assert({query:vi.fn()} as any);expect(f.store.assert).toHaveBeenCalled();
 });
 it('preserves traditional no-fleet sessions without imposing default one session',()=>{
  const legacy=loadEvolutionFleet({...env,EVOLUTION_ENGINES_JSON:undefined}).get('legacy')!;expect(legacy.sessionBudget).toBeNull();
 });
 it('allows the provider-only legacy installation without inventing a webhook signing key',()=>{
  const legacy=loadEvolutionFleet({...env,EVOLUTION_ENGINES_JSON:undefined,QR_WEBHOOK_SIGNING_KEY:undefined}).get('legacy')!;expect(legacy.providerOptions().baseUrl).toBe('http://legacy:8080');expect(()=>legacy.webhookToken({organizationId:'org',instanceId:'i',upstreamKey:'u',channelId:'c'})).toThrow();
 });
});
