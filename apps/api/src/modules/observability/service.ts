import { hostname } from 'node:os';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';

export type HealthState='UP'|'DEGRADED'|'DOWN'|'UNKNOWN';
export interface HealthComponent {key:string;label:string;state:HealthState;code:string;observedAt:string|null;metric?:number;unit?:string}
interface SnapshotRow {
  queueDepth:number;oldestOutboxSeconds:number|null;failedExecutions:number;unknownExecutions:number;
  metaReady:number;evolutionReady:number;chatwootReady:number;chatwootDegraded:number;
}
interface HeartbeatRow {component:string;status:'UP'|'DEGRADED';observedAt:Date}
export interface ObservabilityRepository {
 snapshot(tx:TenantTransaction,org:string):Promise<SnapshotRow>;
 heartbeats(tx:TenantTransaction,org:string):Promise<HeartbeatRow[]>;
}
export const workerInstanceId=()=>`${hostname()}:${process.pid}`.slice(0,120);
export async function recordHeartbeat(tx:TenantTransaction,org:string,component:'MESSAGING_WORKER'|'AUTOMATION_WORKER'|'AUTOMATION_IO_WORKER'|'SCHEDULER',instanceId=workerInstanceId()){
 await tx.query('select record_operational_heartbeat($1,$2,$3)',[org,component,instanceId]);
}
export function createPostgresObservabilityRepository():ObservabilityRepository{return {
 async snapshot(tx,org){return (await tx.query<SnapshotRow>(`select
  ((select count(*) from messaging_outbox where organization_id=$1)+(select count(*) from automation_outbox where organization_id=$1 and status='PENDING'))::int as "queueDepth",
  greatest((select extract(epoch from now()-min(created_at))::int from messaging_outbox where organization_id=$1),(select extract(epoch from now()-min(created_at))::int from automation_outbox where organization_id=$1 and status in ('PENDING','UNKNOWN'))) as "oldestOutboxSeconds",
  (select count(*)::int from automation_executions where organization_id=$1 and status='FAILED') as "failedExecutions",
  (select count(*)::int from automation_executions where organization_id=$1 and status='UNKNOWN') as "unknownExecutions",
  (select count(*)::int from meta_connections where organization_id=$1 and status='READY') as "metaReady",
  (select count(*)::int from instances where organization_id=$1 and status='CONNECTED') as "evolutionReady",
  (select count(*)::int from chatwoot_destinations where organization_id=$1 and approval_status='APPROVED') as "chatwootReady",
  (select count(*)::int from chatwoot_connection_health where organization_id=$1 and (identity_error is not null or access_error is not null or not observed_connected)) as "chatwootDegraded"`,[org])).rows[0]!;},
 async heartbeats(tx,org){return (await tx.query<HeartbeatRow>(`select distinct on(component) component,status,observed_at as "observedAt" from operational_heartbeats where organization_id=$1 order by component,observed_at desc`,[org])).rows;},
};}
export interface ObservabilityOptions {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;repository?:ObservabilityRepository;probeRedis?():Promise<boolean>;schemaCurrent?():Promise<boolean>;now?:()=>Date;heartbeatMaxAgeMs?:number}
export function createObservabilityService(options:ObservabilityOptions){const repo=options.repository??createPostgresObservabilityRepository(),now=options.now??(()=>new Date()),maxAge=options.heartbeatMaxAgeMs??45_000;
 const component=(key:string,label:string,state:HealthState,code:string,observedAt:string|null,metric?:number,unit?:string):HealthComponent=>({key,label,state,code,observedAt,...(metric===undefined?{}:{metric}),...(unit?{unit}:{})});
 return {health:async(org:string)=>{const observedAt=now().toISOString();let redis=false,schema=false;
   try{redis=await (options.probeRedis?.()??Promise.resolve(false));}catch{}
   try{schema=await (options.schemaCurrent?.()??Promise.resolve(true));}catch{}
   const {snapshot,heartbeats}=await options.transact(org,async tx=>({snapshot:await repo.snapshot(tx,org),heartbeats:await repo.heartbeats(tx,org)}));
   const beats=new Map(heartbeats.map(item=>[item.component,item]));
   const worker=(key:string,label:string)=>{const beat=beats.get(key),age=beat?now().getTime()-new Date(beat.observedAt).getTime():Infinity;
     return component(key,label,!beat?'UNKNOWN':age>maxAge?'DOWN':beat.status,'WORKER_'+(!beat?'NEVER_OBSERVED':age>maxAge?'HEARTBEAT_STALE':'HEALTHY'),beat?new Date(beat.observedAt).toISOString():null,Number.isFinite(age)?Math.round(age/1000):undefined,'seconds');};
   const components=[component('API','API','UP','API_RESPONDING',observedAt),component('DATABASE','Banco de dados','UP','DATABASE_QUERY_OK',observedAt),component('SCHEMA','Schema',schema?'UP':'DOWN',schema?'SCHEMA_CURRENT':'SCHEMA_INCOMPATIBLE',observedAt),component('REDIS','Redis',redis?'UP':'DOWN',redis?'REDIS_PING_OK':'REDIS_UNAVAILABLE',observedAt),
    worker('MESSAGING_WORKER','Worker de mensagens'),worker('AUTOMATION_WORKER','Worker de automação'),worker('AUTOMATION_IO_WORKER','Worker de integrações'),worker('SCHEDULER','Scheduler'),
    component('EVOLUTION','Evolution',snapshot.evolutionReady?'UP':'UNKNOWN',snapshot.evolutionReady?'EVOLUTION_CHANNEL_READY':'EVOLUTION_NOT_OBSERVED',observedAt,snapshot.evolutionReady,'channels'),
    component('META','Meta',snapshot.metaReady?'UP':'UNKNOWN',snapshot.metaReady?'META_CHANNEL_READY':'META_NOT_OBSERVED',observedAt,snapshot.metaReady,'channels'),
    component('CHATWOOT','Destino Chatwoot',snapshot.chatwootDegraded?'DEGRADED':snapshot.chatwootReady?'UP':'UNKNOWN',snapshot.chatwootDegraded?'CHATWOOT_DESTINATION_DEGRADED':snapshot.chatwootReady?'CHATWOOT_DESTINATION_READY':'CHATWOOT_NOT_CONFIGURED',observedAt,snapshot.chatwootReady,'destinations'),
    component('QUEUE','Fila',snapshot.queueDepth>1000?'DEGRADED':'UP',snapshot.queueDepth>1000?'QUEUE_DEPTH_HIGH':'QUEUE_DEPTH_NORMAL',observedAt,snapshot.queueDepth,'items'),
    component('OUTBOX_AGE','Idade da outbox',(snapshot.oldestOutboxSeconds??0)>300?'DEGRADED':'UP',(snapshot.oldestOutboxSeconds??0)>300?'OUTBOX_AGED':'OUTBOX_FRESH',observedAt,snapshot.oldestOutboxSeconds??0,'seconds'),
    component('FAILED_EXECUTIONS','Execuções com falha',snapshot.failedExecutions?'DEGRADED':'UP',snapshot.failedExecutions?'EXECUTIONS_FAILED':'NO_FAILED_EXECUTIONS',observedAt,snapshot.failedExecutions,'executions'),
    component('UNKNOWN_EXECUTIONS','Execuções incertas',snapshot.unknownExecutions?'DEGRADED':'UP',snapshot.unknownExecutions?'UNKNOWN_GROWTH':'NO_UNKNOWN_EXECUTIONS',observedAt,snapshot.unknownExecutions,'executions')];
   return {schemaVersion:1,observedAt,overall:components.some(c=>c.state==='DOWN')?'DOWN':components.some(c=>c.state==='DEGRADED'||c.state==='UNKNOWN')?'DEGRADED':'UP',components,alerts:components.filter(c=>c.state!=='UP').map(c=>({code:c.code,component:c.key,state:c.state}))};
 }};
}
export type ObservabilityService=ReturnType<typeof createObservabilityService>;
