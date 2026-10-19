import {describe,expect,it,vi} from 'vitest';
import {createHistorySourceRuntime} from '../../src/modules/history-import/runtime.js';
import type {EvolutionFleetRuntime} from '../../src/modules/evolution-fleet/runtime.js';
import type {HistorySourceScope} from '../../src/modules/history-import/types.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
const org='4f2491a2-6853-4ac2-a7ef-c997813a9182',id='81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
describe('server-owned history source configuration',()=>{
 it('leaves a source absent when not configured, without probing engines or requesting credentials',async()=>{
  const capture=vi.fn();const runtime=createHistorySourceRuntime({}, {capture} as unknown as EvolutionFleetRuntime,async()=>{throw new Error('NO_DB_EXPECTED');});
  expect(runtime.source).toBeUndefined();await runtime.close();expect(capture).not.toHaveBeenCalled();
 });
 it.each([
  {HISTORY_EVOLUTION_DATABASE_URL:'https://not-a-postgres.invalid'},
  {HISTORY_EVOLUTION_DATABASES_JSON:'{"legacy":"META_APP_SECRET"}'},
  {HISTORY_EVOLUTION_DATABASES_JSON:'{"legacy":"HISTORY_EVOLUTION_READ_URL"}'},
 ])('rejects invalid private configuration without exposing it',environment=>{
  expect(()=>createHistorySourceRuntime(environment,{} as EvolutionFleetRuntime,async()=>{throw new Error('NO_DB_EXPECTED');})).toThrow('HISTORY_SOURCE_CONFIGURATION_INVALID');
 });
 it('pins the engine binding on the caller transaction and rejects a disabled engine',async()=>{
  let disabled=false;
  const capture=vi.fn(async()=>({organizationId:org,instanceId:id,upstreamKey:'server-instance',engineId:'legacy',generation:1,destinationFingerprint:'a'.repeat(64),traditional:true,state:disabled?'DISABLED':'ACTIVE'}));
  const assert=vi.fn(async()=>{});const fleet={capture,assert} as unknown as EvolutionFleetRuntime;
  const runtime=createHistorySourceRuntime({HISTORY_EVOLUTION_DATABASE_URL:'postgresql://fixture@127.0.0.1:1/fixture',QR_WEBHOOK_SIGNING_KEY:'synthetic-key'},fleet,async()=>{throw new Error('NO_DB_EXPECTED');});
  const scope:HistorySourceScope={organizationId:org,channelId:id,instanceId:id,instanceKey:'server-instance',sourceRevision:1,sourceFingerprint:'b'.repeat(64)};
  const tx={} as TenantTransaction;
  try{const fingerprint=await runtime.source!.bindingFingerprint!(tx,scope);expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
   expect(capture).toHaveBeenCalledWith(org,'server-instance',undefined,tx);expect(assert).toHaveBeenCalledWith(expect.objectContaining({engineId:'legacy'}),tx);
   await expect(runtime.source!.capability({...scope,providerFingerprint:'c'.repeat(64)})).rejects.toMatchObject({code:'HISTORY_SNAPSHOT_SCOPE_CHANGED'});
   disabled=true;await expect(runtime.source!.bindingFingerprint!(tx,scope)).rejects.toMatchObject({code:'HISTORY_SOURCE_UNAVAILABLE'});
  }finally{await runtime.close();}
 });
});
