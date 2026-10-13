import {describe,expect,it} from 'vitest';
import {loadEvolutionFleet,resolveBoundEngine} from '../../../src/modules/evolution-fleet/config.js';

const environment={EVOLUTION_BASE_URL:'http://evolution:8080',EVOLUTION_API_KEY:'synthetic-legacy-key',QR_WEBHOOK_SIGNING_KEY:'synthetic-legacy-signing-key',EVOLUTION_EAST_KEY:'synthetic-east-key',EVOLUTION_EAST_SIGNING_KEY:'synthetic-east-signing-key'};
const engine={baseUrl:'https://east.example.test',apiKeyEnv:'EVOLUTION_EAST_KEY',signingKeyEnv:'EVOLUTION_EAST_SIGNING_KEY',generation:1,sessionBudget:2000};
const configured=(patch={})=>({...environment,EVOLUTION_ENGINES_JSON:JSON.stringify({east:{...engine,...patch}})});

describe('persistent Evolution destination contract',()=>{
 it('preserves the historical destination and exposes only safe operator metadata',()=>{
  const fleet=loadEvolutionFleet(environment),legacy=fleet.get('legacy')!;
  expect(resolveBoundEngine(fleet,{engineId:'legacy',generation:1,destinationFingerprint:legacy.destinationFingerprint})).toBe(legacy);
  expect(legacy.metadata()).toEqual({id:'legacy',generation:1,destinationFingerprint:legacy.destinationFingerprint,sessionBudget:null});
  expect(JSON.stringify(legacy)).not.toContain('synthetic');
  expect(JSON.stringify(legacy)).not.toContain('evolution:8080');
 });
 it('routes to the persisted engine and never falls back when that engine is missing',()=>{
  const fleet=loadEvolutionFleet(configured()),east=fleet.get('east')!;
  expect(resolveBoundEngine(fleet,{engineId:'east',generation:1,destinationFingerprint:east.destinationFingerprint})).toBe(east);
  expect(()=>resolveBoundEngine(loadEvolutionFleet(environment),{engineId:'east',generation:1,destinationFingerprint:east.destinationFingerprint})).toThrow('EVOLUTION_ENGINE_UNAVAILABLE');
 });
 it('allows a secret rotation but rejects a destination or generation change for a live binding',()=>{
  const first=loadEvolutionFleet(configured()).get('east')!;
  const bound={engineId:'east',generation:1,destinationFingerprint:first.destinationFingerprint};
  const rotated=loadEvolutionFleet({...configured(),EVOLUTION_EAST_KEY:'rotated-synthetic-key'});
  expect(resolveBoundEngine(rotated,bound).destinationFingerprint).toBe(first.destinationFingerprint);
  expect(()=>resolveBoundEngine(loadEvolutionFleet(configured({baseUrl:'https://other.example.test'})),bound)).toThrow('EVOLUTION_ENGINE_BINDING_CHANGED');
  expect(()=>resolveBoundEngine(loadEvolutionFleet(configured({generation:2})),bound)).toThrow('EVOLUTION_ENGINE_BINDING_CHANGED');
 });
 it('rejects endpoints and fields that could redirect a session or expose secrets',()=>{
  for(const patch of [{baseUrl:'https://u:secret@example.test'},{baseUrl:'https://east.example.test/path'},{baseUrl:'https://east.example.test?token=a'},{baseUrl:'file:///tmp/a'},{apiKey:'inline-secret'},{apiKeyEnv:'DATABASE_URL'},{generation:0},{sessionBudget:0}]){
   expect(()=>loadEvolutionFleet(configured(patch))).toThrow('EVOLUTION_ENGINE_CONFIGURATION_INVALID');
  }
  expect(()=>loadEvolutionFleet({...configured(),EVOLUTION_EAST_KEY:''})).toThrow('EVOLUTION_ENGINE_CONFIGURATION_INVALID');
 });
 it('cannot redefine the reserved historical engine through the fleet document',()=>{
  expect(()=>loadEvolutionFleet({...environment,EVOLUTION_ENGINES_JSON:JSON.stringify({legacy:engine})})).toThrow('EVOLUTION_ENGINE_CONFIGURATION_INVALID');
 });
 it('derives separate webhook authority for the engine generation and physical binding',()=>{
  const fleet=loadEvolutionFleet(configured()),east=fleet.get('east')!,legacy=fleet.get('legacy')!;
  const scope={organizationId:'00000000-0000-4000-8000-000000000001',channelId:'00000000-0000-4000-8000-000000000002',instanceId:'00000000-0000-4000-8000-000000000003',upstreamKey:'synthetic-instance'};
  expect(east.webhookToken(scope)).not.toBe(legacy.webhookToken(scope));
  expect(east.webhookToken(scope)).not.toBe(east.webhookToken({...scope,channelId:'00000000-0000-4000-8000-000000000004'}));
  expect(east.webhookToken(scope)).toMatch(/^[A-Za-z0-9_-]{43}$/);
 });
});
