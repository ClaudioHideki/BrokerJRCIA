import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {z} from 'zod';
import type {OrganizationTransaction} from '../../db/tenant-transaction.js';
import type {EvolutionFleetRuntime,EngineSnapshot} from '../evolution-fleet/runtime.js';
import {createPostgresHistorySource} from './postgres-source.js';
import {HistoryImportError,type HistorySnapshotSource,type HistorySourceScope} from './types.js';
import {qrPhone} from '../messaging/qr-events.js';
const descriptors=z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),z.string().min(1).max(4096)).refine(value=>Object.keys(value).length<=128);
const fingerprint=(snapshot:EngineSnapshot)=>createHash('sha256').update(JSON.stringify([snapshot.engineId,snapshot.generation,snapshot.destinationFingerprint,snapshot.traditional])).digest('hex');
export function createHistorySourceRuntime(environment:Record<string,string|undefined>,fleet:EvolutionFleetRuntime,transact:<T>(org:string,work:OrganizationTransaction<T>)=>Promise<T>){
 const references:Record<string,string>={};
 if(environment.HISTORY_EVOLUTION_DATABASE_URL)references.legacy='HISTORY_EVOLUTION_DATABASE_URL';
 const pools=new Map<string,Pool>();
 try{
  const json=environment.HISTORY_EVOLUTION_DATABASES_JSON;
  if(json){if(Buffer.byteLength(json)>65536)throw new Error();Object.assign(references,descriptors.parse(JSON.parse(json)));}
  for(const [engine,reference] of Object.entries(references)){
   const connectionString=/^postgres(?:ql)?:\/\//.test(reference)?reference:/^HISTORY_EVOLUTION_[A-Z0-9_]{1,95}$/.test(reference)?environment[reference]:undefined;if(!connectionString)throw new Error();
   if(!['postgres:','postgresql:'].includes(new URL(connectionString).protocol))throw new Error();
   const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,options:'-c default_transaction_read_only=on -c statement_timeout=10000'});
   // Idle socket failures must not crash the API; the next availability/read reports a sanitized failure.
   pool.on('error',()=>{});pools.set(engine,pool);
  }
 }catch{for(const pool of pools.values())void pool.end();throw new Error('HISTORY_SOURCE_CONFIGURATION_INVALID');}
 if(!pools.size)return{source:undefined,close:async()=>{}};
 const source:HistorySnapshotSource={...createPostgresHistorySource({transact,resolveDatabase:async(scope:HistorySourceScope)=>{
  const snapshot=await fleet.capture(scope.organizationId,scope.instanceKey);
  if(snapshot.state==='DISABLED'||scope.providerFingerprint!==fingerprint(snapshot))throw new HistoryImportError('HISTORY_SNAPSHOT_SCOPE_CHANGED');
  const pool=pools.get(snapshot.engineId);if(!pool)throw new HistoryImportError('HISTORY_SOURCE_NOT_CONFIGURED',503);return pool;
 },verifyOwner:async(scope,jid)=>{
  const phone=qrPhone(jid),key=environment.QR_WEBHOOK_SIGNING_KEY;if(!phone||!key||!scope.ownerFingerprint||!/^[a-f0-9]{64}$/.test(scope.ownerFingerprint))return false;
  const expected=createHmac('sha256',key).update(`qr-identity:v1:${scope.organizationId}:${scope.channelId}:${scope.instanceKey}:${phone}`).digest();
  return timingSafeEqual(expected,Buffer.from(scope.ownerFingerprint,'hex'));
 }}),bindingFingerprint:async(tx,scope)=>{
  const snapshot=await fleet.capture(scope.organizationId,scope.instanceKey,undefined,tx);
  if(snapshot.state==='DISABLED')throw new HistoryImportError('HISTORY_SOURCE_UNAVAILABLE',503);
  await fleet.assert(snapshot,tx);return fingerprint(snapshot);
 }};
 return{source,close:async()=>{await Promise.all([...pools.values()].map(pool=>pool.end()));}};
}
