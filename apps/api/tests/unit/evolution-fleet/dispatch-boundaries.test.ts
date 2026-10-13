import {describe,it,expect,vi} from 'vitest';
import {createEvolutionFleetRuntime,type FleetStore,type EngineSnapshot} from '../../../src/modules/evolution-fleet/runtime.js';
import {loadEvolutionFleet} from '../../../src/modules/evolution-fleet/config.js';
const env={EVOLUTION_BASE_URL:'http://legacy:8080',EVOLUTION_API_KEY:'synthetic-private-key',QR_WEBHOOK_SIGNING_KEY:'synthetic-private-signing-key-32bytes'};
const c={organizationId:'org',requestId:'request',signal:AbortSignal.timeout(30000),deadline:new Date(Date.now()+30000)};
function fixture(){const e=loadEvolutionFleet(env).get('legacy')!;const snapshot:EngineSnapshot={organizationId:'org',instanceId:'instance',upstreamKey:'key',engineId:e.id,generation:e.generation,destinationFingerprint:e.destinationFingerprint,state:'ACTIVE',traditional:false};
const calls:string[]=[];const store:FleetStore={resolve:vi.fn(async()=>({...snapshot})),assert:vi.fn(async()=>undefined),acquire:vi.fn(async()=>({token:'lease',snapshot})),settle:vi.fn(async()=>undefined)};
const factory=()=>new Proxy({},{get:(_t,p)=>p==='then'?undefined:async()=>{calls.push(String(p));return {upstreamMessageId:'synthetic'};}}) as any;
return{snapshot,store,calls,runtime:createEvolutionFleetRuntime(env,undefined,{store,factories:{provider:factory,messaging:factory}})};}
describe('C3 dispatch boundaries',()=>{
it('rechecks binding before dispatch even for injected legacy stores',async()=>{const f=fixture();await f.runtime.provider.disconnect(c,{id:'key'});expect(vi.mocked(f.store.assert).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.store.settle).mock.invocationCallOrder[0]!);expect(f.store.assert).toHaveBeenCalledTimes(2);});
it('marks post-I/O persistence failure uncertain and never claims a known rejection',async()=>{const f=fixture();vi.mocked(f.store.settle).mockRejectedValueOnce(new Error('database lost'));await expect(f.runtime.provider.disconnect(c,{id:'key'})).rejects.toMatchObject({uncertain:true});});
it('keeps a messaging client pinned to its captured engine for every later send',async()=>{const f=fixture();const client=await f.runtime.messaging('org','key');f.snapshot.generation++;await expect(client.sendText('5511999999999','test')).rejects.toMatchObject({code:'EVOLUTION_ENGINE_BINDING_CHANGED'});expect(f.calls).toEqual([]);});
it('rejects a DISABLED binding at the pre-dispatch guard',async()=>{const f=fixture();vi.mocked(f.store.assert).mockImplementation(async(_s,_tx,mutation)=>{if(mutation)throw Object.assign(new Error(),{code:'EVOLUTION_ENGINE_DISABLED'});});await expect(f.runtime.provider.disconnect(c,{id:'key'})).rejects.toMatchObject({code:'EVOLUTION_ENGINE_DISABLED'});expect(f.calls).toHaveLength(0);});
});

it('preserves the historical provider rejection classification without registry or new quota',async()=>{const f=fixture();f.snapshot.traditional=true;const error=Object.assign(new Error('synthetic historical rejection'),{code:'PROVIDER_REQUEST_FAILED'});const runtime=createEvolutionFleetRuntime(env,undefined,{store:f.store,factories:{provider:()=>({disconnect:async()=>{throw error;}}) as any}});await expect(runtime.provider.disconnect(c,{id:'key'})).rejects.toBe(error);expect(error).not.toHaveProperty('uncertain');});
