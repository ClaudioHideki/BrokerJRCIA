import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import {createPostgresObservabilityRepository} from '../observability/service.js';

export type AutomationAvailabilityReason='ORGANIZATION_NOT_ACTIVE'|'AUTOMATION_MODULE_DISABLED'|'AUTOMATION_RUNTIME_DISABLED'|'AUTOMATION_PERMISSION_REQUIRED'|'AUTOMATION_DEPENDENCY_UNAVAILABLE';
export interface AutomationAccess {status:string;moduleEnabled:boolean}

/** Read at each write boundary: changing the plan or disabling a company must take effect immediately. */
export async function readAutomationAccess(tx:TenantTransaction,org:string):Promise<AutomationAccess|null>{
 // The context-bound function holds the existing organization SHARE lock through
 // commit. A commercial downgrade must wait for an already admitted draft/import.
 // Read the module in a subsequent statement so a preceding downgrade is visible.
 await tx.query('SELECT tenant_is_active($1::uuid) AS active',[org]);
 const result=await tx.query<AutomationAccess>(`select o.status,coalesce(f.enabled,false) as "moduleEnabled"
  from organizations o left join flow_features f on f.organization_id=o.id where o.id=$1`,[org]);
 return result.rows[0]??null;
}
export function automationAvailability(access:AutomationAccess|null,enabled:boolean,role:string,dependenciesReady=true){
 const reasons:AutomationAvailabilityReason[]=[];
 if(access?.status!=='ACTIVE')reasons.push('ORGANIZATION_NOT_ACTIVE');
 if(!access?.moduleEnabled)reasons.push('AUTOMATION_MODULE_DISABLED');
 if(!['OWNER','ADMIN'].includes(role))reasons.push('AUTOMATION_PERMISSION_REQUIRED');
 const canEdit=reasons.length===0;
 if(!enabled)reasons.push('AUTOMATION_RUNTIME_DISABLED');
 if(enabled&&!dependenciesReady)reasons.push('AUTOMATION_DEPENDENCY_UNAVAILABLE');
 return {schemaVersion:1,engine:'AUTOMATION_RUNTIME_V2' as const,enabled,canRead:access!==null,
  canEdit,canSimulate:canEdit,canPublish:canEdit&&enabled&&dependenciesReady,reasons};
}
/** Production defaults to paused, matching API configuration. Never coerce the string "false" to true. */
export function automationRuntimeEnabled(environment:NodeJS.ProcessEnv):boolean{
 const value=environment.AUTOMATION_RUNTIME_V2_ENABLED??'false';
 if(value!=='true'&&value!=='false')throw new Error('AUTOMATION_RUNTIME_V2_ENABLED_INVALID');
 return value==='true';
}

export function createAutomationRuntimeReadiness(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;schemaCurrent():Promise<boolean>;probeRedis():Promise<boolean>;now?:()=>Date}){
 const repository=createPostgresObservabilityRepository(),now=options.now??(()=>new Date());
 return async(org:string):Promise<boolean>=>{
  let timer:ReturnType<typeof setTimeout>|undefined,timedOut=false;
  const check=async()=>{try{
   // Dependency probes run before the tenant transaction; do not hold a DB connection across network I/O.
   const [schema,redis]=await Promise.all([options.schemaCurrent(),options.probeRedis()]);
   if(timedOut||!schema||!redis)return false;
   const heartbeats=await options.transact(org,tx=>repository.heartbeats(tx,org));
   return ['MESSAGING_WORKER','AUTOMATION_WORKER','AUTOMATION_IO_WORKER','SCHEDULER'].every(component=>{
    const beat=heartbeats.find(item=>item.component===component),age=beat?now().getTime()-new Date(beat.observedAt).getTime():Infinity;
    return beat?.status==='UP'&&age>=-5000&&age<=45000;
   });
  }catch{return false;}};
  try{return await Promise.race([check(),new Promise<boolean>(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve(false);},2000);})]);}
  finally{clearTimeout(timer);}
 };
}

export async function recordAutomationHeartbeat(tx:TenantTransaction,org:string,component:'AUTOMATION_WORKER'|'AUTOMATION_IO_WORKER'|'SCHEDULER',instanceId:string,enabled:boolean){
 await tx.query('select record_operational_heartbeat($1,$2,$3,$4,$5)',[org,component,instanceId,enabled?'UP':'DEGRADED',enabled?null:'AUTOMATION_RUNTIME_DISABLED']);
}
