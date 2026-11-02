import { hostname } from 'node:os';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';

export type HealthState='UP'|'DEGRADED'|'DOWN'|'UNKNOWN';
export interface HealthComponent {key:string;label:string;state:HealthState;code:string;observedAt:string|null;metric?:number;unit?:string;source?:string;scope?:string;metricScope?:string;metricSource?:string;timeWindow?:'CURRENT_STATE'|'ALL_RETAINED_HISTORY';bindingCounts?:{active:number|undefined;degraded:number;unobserved:number|undefined}}
interface SnapshotRow {
  queueDepth:number;oldestOutboxSeconds:number|null;failedExecutions:number;unknownExecutions:number;
  metaReady:number;evolutionReady:number;chatwootReady:number;chatwootDegraded:number;
  integrationFailures:number;integrationUnknown:number;
  chatwootActiveBindings?:number;chatwootUnobserved?:number;chatwootDisabled?:number;chatwootDisabledDegraded?:number;
  disabledIntegrationPending?:number;disabledIntegrationFailures?:number;disabledIntegrationUnknown?:number;
  identityPending?:number;
}
interface HeartbeatRow {component:string;status:'UP'|'DEGRADED';observedAt:Date;detailCode?:string|null}
export interface ObservabilityRepository {
 snapshot(tx:TenantTransaction,org:string):Promise<SnapshotRow>;
 heartbeats(tx:TenantTransaction,org:string):Promise<HeartbeatRow[]>;
}
export const workerInstanceId=()=>`${hostname()}:${process.pid}`.slice(0,120);
export async function recordHeartbeat(tx:TenantTransaction,org:string,component:'MESSAGING_WORKER'|'AUTOMATION_WORKER'|'AUTOMATION_IO_WORKER'|'SCHEDULER',instanceId=workerInstanceId()){
 await tx.query('select record_operational_heartbeat($1,$2,$3)',[org,component,instanceId]);
}
export function createPostgresObservabilityRepository():ObservabilityRepository{return {
 async snapshot(tx,org){return (await tx.query<SnapshotRow>(`with binding_health as (
  select c.status,h.integration_id,h.observed_at,h.observed_connected,h.identity_error,h.access_error
  from chatwoot_connections c left join chatwoot_connection_health h
   on h.organization_id=c.organization_id and h.integration_id=c.id
  where c.organization_id=$1
 ), disabled_jobs as (
  select j.status from integration_jobs j join chatwoot_connections c
   on c.organization_id=j.organization_id and c.id=j.integration_id
  where j.organization_id=$1 and c.status='DISABLED'
 ) select
  ((select count(*) from messaging_outbox where organization_id=$1)+(select count(*) from automation_outbox where organization_id=$1 and status='PENDING'))::int as "queueDepth",
  greatest((select extract(epoch from now()-min(created_at))::int from messaging_outbox where organization_id=$1),(select extract(epoch from now()-min(created_at))::int from automation_outbox where organization_id=$1 and status in ('PENDING','UNKNOWN'))) as "oldestOutboxSeconds",
  (select count(*)::int from automation_executions where organization_id=$1 and status='FAILED') as "failedExecutions",
  (select count(*)::int from automation_executions where organization_id=$1 and status='UNKNOWN') as "unknownExecutions",
  (select count(*)::int from integration_jobs where organization_id=$1 and status='FAILED') as "integrationFailures",
  (select count(*)::int from integration_jobs where organization_id=$1 and status='UNKNOWN') as "integrationUnknown",
  (select count(*)::int from qr_identity_pending_events where organization_id=$1 and status IN ('WAITING','CONFLICT','STALE')) as "identityPending",
  (select count(*)::int from meta_connections where organization_id=$1 and status='READY') as "metaReady",
  (select count(*)::int from instances where organization_id=$1 and status='CONNECTED') as "evolutionReady",
  (select count(*)::int from chatwoot_destinations where organization_id=$1 and approval_status='APPROVED') as "chatwootReady",
  (select count(*)::int from binding_health where status='READY') as "chatwootActiveBindings",
  (select count(*)::int from binding_health where status='READY' and (identity_error is not null or access_error is not null or (observed_at is not null and not observed_connected))) as "chatwootDegraded",
  (select count(*)::int from binding_health where status='READY' and (integration_id is null or observed_at is null)) as "chatwootUnobserved",
  (select count(*)::int from binding_health where status='DISABLED') as "chatwootDisabled",
  (select count(*)::int from binding_health where status='DISABLED' and (identity_error is not null or access_error is not null or (observed_at is not null and not observed_connected))) as "chatwootDisabledDegraded",
  (select count(*)::int from disabled_jobs where status in ('PENDING','RUNNING')) as "disabledIntegrationPending",
  (select count(*)::int from disabled_jobs where status='FAILED') as "disabledIntegrationFailures",
  (select count(*)::int from disabled_jobs where status='UNKNOWN') as "disabledIntegrationUnknown"`,[org])).rows[0]!;},
 async heartbeats(tx,org){return (await tx.query<HeartbeatRow>(`select distinct on(component) component,status,observed_at as "observedAt",detail_code as "detailCode" from operational_heartbeats where organization_id=$1 order by component,observed_at desc`,[org])).rows;},
};}
export interface ObservabilityOptions {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;repository?:ObservabilityRepository;probeRedis?():Promise<boolean>;schemaCurrent?():Promise<boolean>;now?:()=>Date;heartbeatMaxAgeMs?:number}
export function createObservabilityService(options:ObservabilityOptions){const repo=options.repository??createPostgresObservabilityRepository(),now=options.now??(()=>new Date()),maxAge=options.heartbeatMaxAgeMs??45_000;
 const component=(key:string,label:string,state:HealthState,code:string,observedAt:string|null,metric?:number,unit?:string):HealthComponent=>({key,label,state,code,observedAt,...(metric===undefined?{}:{metric}),...(unit?{unit}:{})});
 return {health:async(org:string)=>{const observedAt=now().toISOString();let redis=false,schema=false;
   try{redis=await (options.probeRedis?.()??Promise.resolve(false));}catch{}
   try{schema=await (options.schemaCurrent?.()??Promise.resolve(true));}catch{}
   const {snapshot,heartbeats}=await options.transact(org,async tx=>({snapshot:await repo.snapshot(tx,org),heartbeats:await repo.heartbeats(tx,org)}));
   const beats=new Map(heartbeats.map(item=>[item.component,item]));
   const scoped=(value:HealthComponent,source:string,scope:string,timeWindow:NonNullable<HealthComponent['timeWindow']>):HealthComponent=>({...value,source,scope,timeWindow});
   const disabledMetric=(key:string,label:string,value:number|undefined,code:string,emptyCode:string,history=false,diagnostic=false)=>scoped(
    component(key,label,value===undefined?'UNKNOWN':value&&!diagnostic?'DEGRADED':'UP',value===undefined?'DISABLED_BINDING_METRIC_UNAVAILABLE':value?code:emptyCode,observedAt,value,key.startsWith('CHATWOOT_')?'bindings':'items'),
    history?'integration_jobs+chatwoot_connections':'chatwoot_connections+chatwoot_connection_health','DISABLED_BINDINGS',history?'ALL_RETAINED_HISTORY':'CURRENT_STATE');
   const chatwootUnobserved=snapshot.chatwootUnobserved===undefined||snapshot.chatwootUnobserved>0;
   const chatwootNoActiveBindings=!snapshot.chatwootActiveBindings;
   const worker=(key:string,label:string)=>{const beat=beats.get(key),age=beat?now().getTime()-new Date(beat.observedAt).getTime():Infinity;
     const code=!beat?'WORKER_NEVER_OBSERVED':age>maxAge?'WORKER_HEARTBEAT_STALE':beat.status==='DEGRADED'?(beat.detailCode==='AUTOMATION_RUNTIME_DISABLED'?beat.detailCode:'WORKER_DEGRADED'):'WORKER_HEALTHY';
     return component(key,label,!beat?'UNKNOWN':age>maxAge?'DOWN':beat.status,code,beat?new Date(beat.observedAt).toISOString():null,Number.isFinite(age)?Math.round(age/1000):undefined,'seconds');};
   const components=[component('API','API','UP','API_RESPONDING',observedAt),component('DATABASE','Banco de dados','UP','DATABASE_QUERY_OK',observedAt),component('SCHEMA','Schema',schema?'UP':'DOWN',schema?'SCHEMA_REQUIRED_OBJECTS_PRESENT':'SCHEMA_INCOMPATIBLE',observedAt),component('REDIS','Redis',redis?'UP':'DOWN',redis?'REDIS_PING_OK':'REDIS_UNAVAILABLE',observedAt),
    worker('MESSAGING_WORKER','Worker de mensagens'),worker('AUTOMATION_WORKER','Worker de automação'),worker('AUTOMATION_IO_WORKER','Worker de integrações'),worker('SCHEDULER','Scheduler'),
    component('EVOLUTION','Evolution',snapshot.evolutionReady?'UP':'UNKNOWN',snapshot.evolutionReady?'EVOLUTION_CHANNEL_READY':'EVOLUTION_NOT_OBSERVED',observedAt,snapshot.evolutionReady,'channels'),
    component('META','Meta',snapshot.metaReady?'UP':'UNKNOWN',snapshot.metaReady?'META_CHANNEL_READY':'META_NOT_OBSERVED',observedAt,snapshot.metaReady,'channels'),
    {...scoped(component('CHATWOOT','Destino Chatwoot',snapshot.chatwootDegraded?'DEGRADED':chatwootNoActiveBindings||chatwootUnobserved?'UNKNOWN':snapshot.chatwootReady?'UP':'UNKNOWN',snapshot.chatwootDegraded?'CHATWOOT_DESTINATION_DEGRADED':chatwootNoActiveBindings?'CHATWOOT_NO_ACTIVE_BINDINGS':chatwootUnobserved?'CHATWOOT_BINDING_NOT_OBSERVED':snapshot.chatwootReady?'CHATWOOT_DESTINATION_READY':'CHATWOOT_NOT_CONFIGURED',observedAt,snapshot.chatwootReady,'destinations'),'chatwoot_connections+chatwoot_connection_health','READY_BINDINGS','CURRENT_STATE'),metricScope:'APPROVED_DESTINATIONS',metricSource:'chatwoot_destinations',bindingCounts:{active:snapshot.chatwootActiveBindings,degraded:snapshot.chatwootDegraded,unobserved:snapshot.chatwootUnobserved}},
    disabledMetric('CHATWOOT_DISABLED_BINDINGS','Vínculos Chatwoot desativados',snapshot.chatwootDisabled,'CHATWOOT_DISABLED_BINDINGS_PRESENT','NO_DISABLED_CHATWOOT_BINDINGS',false,true),
    disabledMetric('CHATWOOT_DISABLED_HEALTH','Falhas registradas em vínculos desativados',snapshot.chatwootDisabledDegraded,'DISABLED_CHATWOOT_BINDING_ERRORS','NO_DISABLED_CHATWOOT_BINDING_ERRORS'),
    disabledMetric('DISABLED_INTEGRATION_BACKLOG','Pendências de vínculos desativados',snapshot.disabledIntegrationPending,'DISABLED_INTEGRATION_BACKLOG_PRESENT','NO_DISABLED_INTEGRATION_BACKLOG',true),
    disabledMetric('DISABLED_INTEGRATION_FAILURES','Falhas de vínculos desativados',snapshot.disabledIntegrationFailures,'DISABLED_INTEGRATION_JOBS_FAILED','NO_DISABLED_INTEGRATION_FAILURES',true),
    disabledMetric('DISABLED_INTEGRATION_UNCERTAINTY','Entregas incertas de vínculos desativados',snapshot.disabledIntegrationUnknown,'DISABLED_INTEGRATION_OUTCOME_UNKNOWN','NO_DISABLED_INTEGRATION_UNCERTAINTY',true),
    component('QUEUE','Fila',snapshot.queueDepth>1000?'DEGRADED':'UP',snapshot.queueDepth>1000?'QUEUE_DEPTH_HIGH':'QUEUE_DEPTH_NORMAL',observedAt,snapshot.queueDepth,'items'),
    component('OUTBOX_AGE','Idade da outbox',(snapshot.oldestOutboxSeconds??0)>300?'DEGRADED':'UP',(snapshot.oldestOutboxSeconds??0)>300?'OUTBOX_AGED':'OUTBOX_FRESH',observedAt,snapshot.oldestOutboxSeconds??0,'seconds'),
    component('FAILED_EXECUTIONS','Execuções com falha',snapshot.failedExecutions?'DEGRADED':'UP',snapshot.failedExecutions?'EXECUTIONS_FAILED':'NO_FAILED_EXECUTIONS',observedAt,snapshot.failedExecutions,'executions'),
    scoped(component('INTEGRATION_FAILURES','Entregas à central com falha',snapshot.integrationFailures?'DEGRADED':'UP',snapshot.integrationFailures?'INTEGRATION_JOBS_FAILED':'NO_FAILED_INTEGRATION_JOBS',observedAt,snapshot.integrationFailures,'items'),'integration_jobs','ALL_BINDINGS','ALL_RETAINED_HISTORY'),
    scoped(component('INTEGRATION_UNCERTAINTY','Entregas à central incertas',snapshot.integrationUnknown?'DEGRADED':'UP',snapshot.integrationUnknown?'INTEGRATION_OUTCOME_UNKNOWN':'NO_UNKNOWN_INTEGRATION_JOBS',observedAt,snapshot.integrationUnknown,'items'),'integration_jobs','ALL_BINDINGS','ALL_RETAINED_HISTORY'),
    component('QR_IDENTITY_PENDING','Mensagens aguardando identificação',snapshot.identityPending?'DEGRADED':'UP',snapshot.identityPending?'QR_IDENTITY_RECONCILIATION_REQUIRED':'NO_QR_IDENTITY_PENDING',observedAt,snapshot.identityPending??0,'items'),
    component('UNKNOWN_EXECUTIONS','Execuções incertas',snapshot.unknownExecutions?'DEGRADED':'UP',snapshot.unknownExecutions?'UNKNOWN_GROWTH':'NO_UNKNOWN_EXECUTIONS',observedAt,snapshot.unknownExecutions,'executions')];
   return {schemaVersion:1,observedAt,overall:components.some(c=>c.state==='DOWN')?'DOWN':components.some(c=>c.state==='DEGRADED'||c.state==='UNKNOWN')?'DEGRADED':'UP',components,alerts:components.filter(c=>c.state!=='UP').map(c=>({code:c.code,component:c.key,state:c.state}))};
 }};
}
export type ObservabilityService=ReturnType<typeof createObservabilityService>;
