import {createHash,createHmac} from 'node:crypto';
import {z} from 'zod';

const id=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const keyReference=z.string().regex(/^EVOLUTION_[A-Z][A-Z0-9_]{0,95}$/);
const descriptor=z.strictObject({baseUrl:z.string().max(2048),apiKeyEnv:keyReference,signingKeyEnv:keyReference,
 generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),sessionBudget:z.number().int().positive().max(100_000),state:z.enum(['ACTIVE','DRAINING','DISABLED']).default('ACTIVE'),operationBudget:z.number().int().min(1).max(256).default(8)});
const document=z.record(id,descriptor).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=128&&!Object.hasOwn(value,'legacy'));
export class EvolutionFleetError extends Error{
 constructor(readonly code:'EVOLUTION_ENGINE_CONFIGURATION_INVALID'|'EVOLUTION_ENGINE_UNAVAILABLE'|'EVOLUTION_ENGINE_BINDING_CHANGED'){
  super(code);this.name='EvolutionFleetError';
 }
}
export interface EngineBinding{engineId:string;generation:number;destinationFingerprint:string}
export interface EngineWebhookScope{organizationId:string;channelId:string;instanceId:string;upstreamKey:string}
export class EvolutionEngine{
 readonly destinationFingerprint:string;
 readonly #baseUrl:string;
 readonly #apiKey:string;
 readonly #signingKey:string|undefined;
 constructor(readonly id:string,readonly generation:number,readonly sessionBudget:number|null,baseUrl:string,apiKey:string,signingKey:string|undefined,readonly state:'ACTIVE'|'DRAINING'|'DISABLED'='ACTIVE',readonly operationBudget=8){
  this.#baseUrl=baseUrl;this.#apiKey=apiKey;this.#signingKey=signingKey;
  this.destinationFingerprint=createHash('sha256').update(JSON.stringify(['evolution-engine:v1',id,generation,baseUrl])).digest('hex');
 }
 /** Only internal provider constructors receive credentials; diagnostic output
  * always uses metadata/toJSON, never the private request options. */
 providerOptions(){return {baseUrl:this.#baseUrl,apiKey:this.#apiKey};}
 metadata(){return {id:this.id,generation:this.generation,destinationFingerprint:this.destinationFingerprint,sessionBudget:this.sessionBudget};}
 toJSON(){return this.metadata();}
 webhookToken(scope:EngineWebhookScope){
  if(!this.#signingKey)throw new EvolutionFleetError('EVOLUTION_ENGINE_CONFIGURATION_INVALID');
  // Existing callbacks keep their historical signed scope. Persisted binding
  // checks still precede admission; a new engine uses a separate namespace.
  const body=this.id==='legacy'?`qr-webhook\0${scope.organizationId}\0${scope.channelId}`:
   JSON.stringify(['qr-engine-webhook:v1',this.id,this.generation,this.destinationFingerprint,scope.organizationId,scope.channelId,scope.instanceId,scope.upstreamKey]);
  return createHmac('sha256',this.#signingKey).update(body).digest('base64url');
 }
}
const invalid=():never=>{throw new EvolutionFleetError('EVOLUTION_ENGINE_CONFIGURATION_INVALID');};
function endpoint(raw:unknown){
 try{
  if(typeof raw!=='string'||raw.length>2048)return invalid();
  const u=new URL(raw);
  if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.search||u.hash||u.pathname!=='/')return invalid();
  return u.origin;
 }catch{return invalid();}
}
function secret(environment:Record<string,string|undefined>,reference:string){
 const value=environment[reference];
 if(typeof value!=='string'||value.length<8||value.length>4096||/[\r\n\0]/.test(value))return invalid();
 return value;
}
/** Private operator input only. No HTTP, browser or webhook data is accepted. */
export function loadEvolutionFleet(environment:Record<string,string|undefined>):ReadonlyMap<string,EvolutionEngine>{
 try{
  const legacyBudget=environment.EVOLUTION_LEGACY_SESSION_BUDGET===undefined?null:z.coerce.number().int().positive().max(100_000).parse(environment.EVOLUTION_LEGACY_SESSION_BUDGET);
  const legacyState=z.enum(['ACTIVE','DRAINING','DISABLED']).parse(environment.EVOLUTION_LEGACY_STATE??(environment.EVOLUTION_ENGINES_JSON&&legacyBudget===null?'DRAINING':'ACTIVE'));
  const legacyOperations=z.coerce.number().int().min(1).max(256).parse(environment.EVOLUTION_LEGACY_OPERATION_BUDGET??8);
  const fleet=new Map<string,EvolutionEngine>([['legacy',new EvolutionEngine('legacy',1,legacyBudget,endpoint(environment.EVOLUTION_BASE_URL),
   secret(environment,'EVOLUTION_API_KEY'),environment.QR_WEBHOOK_SIGNING_KEY===undefined?undefined:secret(environment,'QR_WEBHOOK_SIGNING_KEY'),legacyState,legacyOperations)]]);
  const raw=environment.EVOLUTION_ENGINES_JSON;
  if(raw===undefined||raw==='')return fleet;
  if(Buffer.byteLength(raw,'utf8')>65_536)return invalid();
  const parsed=document.parse(JSON.parse(raw));
  for(const [engineId,value] of Object.entries(parsed)){
   if(['EVOLUTION_BASE_URL','EVOLUTION_ENGINES_JSON','EVOLUTION_LEGACY_SESSION_BUDGET'].includes(value.apiKeyEnv)
    ||['EVOLUTION_BASE_URL','EVOLUTION_ENGINES_JSON','EVOLUTION_LEGACY_SESSION_BUDGET'].includes(value.signingKeyEnv))return invalid();
   fleet.set(engineId,new EvolutionEngine(engineId,value.generation,value.sessionBudget,endpoint(value.baseUrl),
    secret(environment,value.apiKeyEnv),secret(environment,value.signingKeyEnv),value.state,value.operationBudget));
  }
  return fleet;
 }catch{return invalid();}
}
export function resolveBoundEngine(fleet:ReadonlyMap<string,EvolutionEngine>,binding:EngineBinding){
 const engine=fleet.get(binding.engineId);
 if(!engine)throw new EvolutionFleetError('EVOLUTION_ENGINE_UNAVAILABLE');
 if(engine.generation!==binding.generation||engine.destinationFingerprint!==binding.destinationFingerprint)
  throw new EvolutionFleetError('EVOLUTION_ENGINE_BINDING_CHANGED');
 return engine;
}
