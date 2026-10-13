import {describe,it,expect,vi} from 'vitest';
import {EvolutionMessagingClient,createEvolutionGroupTextSender} from '@jrc/providers';
import {createEvolutionFleetRuntime,type FleetStore,type EngineSnapshot} from '../../../src/modules/evolution-fleet/runtime.js';
import {loadEvolutionFleet} from '../../../src/modules/evolution-fleet/config.js';
import {registerEvolutionEngines} from '../../../src/modules/evolution-fleet/registration.js';
const env={EVOLUTION_BASE_URL:'http://legacy:8080',EVOLUTION_API_KEY:'synthetic-legacy-key',QR_WEBHOOK_SIGNING_KEY:'synthetic-legacy-signing-key-32bytes',EVOLUTION_EAST_KEY:'synthetic-east-key',EVOLUTION_EAST_SIGN:'synthetic-east-signing-key-32bytes',EVOLUTION_WEST_KEY:'synthetic-west-key',EVOLUTION_WEST_SIGN:'synthetic-west-signing-key-32bytes',EVOLUTION_ENGINES_JSON:JSON.stringify({east:{baseUrl:'http://east:8080',apiKeyEnv:'EVOLUTION_EAST_KEY',signingKeyEnv:'EVOLUTION_EAST_SIGN',generation:1,sessionBudget:3},west:{baseUrl:'http://west:8080',apiKeyEnv:'EVOLUTION_WEST_KEY',signingKeyEnv:'EVOLUTION_WEST_SIGN',generation:9,sessionBudget:3,state:'DRAINING',operationBudget:2}})};
const ctx=(org:string)=>({organizationId:org,requestId:'r',deadline:new Date(Date.now()+30000),signal:AbortSignal.timeout(30000)});
describe('fleet wire protocol through canonical clients',()=>{
 it('isolates two tenants and sends group JIDs unchanged on their assigned engine',async()=>{
  const fleet=loadEvolutionFleet(env),calls:Array<{url:string;key:string;body:any}>=[];
  const store:FleetStore={resolve:async(org,key)=>{const e=fleet.get(org==='a'?'east':'west')!;return{organizationId:org,instanceId:org,upstreamKey:key,engineId:e.id,generation:e.generation,destinationFingerprint:e.destinationFingerprint,state:e.state,traditional:false};},acquire:async snapshot=>({token:'test',snapshot}),assert:async()=>{},settle:async()=>{}};
  const request=async(input:URL|string|Request,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));calls.push({url:String(input),key:(init!.headers as any).apikey,body});return new Response(JSON.stringify({key:{id:'synthetic-message',fromMe:true,remoteJid:body.number}}));};
  const runtime=createEvolutionFleetRuntime(env,undefined,{store,factories:{messaging:(e,key)=>new EvolutionMessagingClient({...e.providerOptions(),instanceKey:key,fetch:request}),groupText:(e,key)=>createEvolutionGroupTextSender({...e.providerOptions(),instanceKey:key,fetch:request})}});
  await(await runtime.messaging('a','upstream-a')).sendText('15550000001','a');
  await runtime.groupText(ctx('b'),'upstream-b',{kind:'GROUP',groupJid:'10000@g.us'},'b');
  expect(calls.map(x=>new URL(x.url).hostname)).toEqual(['east','west']);expect(calls.map(x=>x.key)).toEqual([env.EVOLUTION_EAST_KEY,env.EVOLUTION_WEST_KEY]);expect(calls[1]!.body.number).toBe('10000@g.us');
 });
 it('writes only operator metadata and keeps unbounded legacy in DRAINING after opt-in',async()=>{
  const query=vi.fn(async()=>({rows:[{registered:3}]}));const result=await registerEvolutionEngines(env,{query} as any,true);
  expect(result.find(x=>x.id==='legacy')).toMatchObject({sessionBudget:null,state:'DRAINING'});expect(result.find(x=>x.id==='west')).toMatchObject({operationBudget:2,state:'DRAINING'});
  const sqlArgs=JSON.stringify(query.mock.calls[0]);expect(sqlArgs).not.toContain('http:');expect(sqlArgs).not.toContain('synthetic');
 });
 it('keeps configuration scope stable for the existing G3 historical authority',()=>{
  const store={} as FleetStore;const runtime=createEvolutionFleetRuntime({...env,EVOLUTION_ENGINES_JSON:undefined},undefined,{store});expect(runtime.configurationScope('https://broker.example.test')).toBe(JSON.stringify([env.EVOLUTION_BASE_URL,'https://broker.example.test',env.QR_WEBHOOK_SIGNING_KEY]));
 });
});
