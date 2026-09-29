import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type QueryClient = Pick<PoolClient,'query'>;
export type LifecycleTransaction = <T>(work:(tx:QueryClient)=>Promise<T>)=>Promise<T>;
export type DeletionStatus = 'REQUESTED'|'BLOCKING'|'CLEANING_EXTERNAL'|'REMOVING_DATA'|'COMPLETED'|'ACTION_REQUIRED';
export type DeletionPreview = {resourceId:string;resourceName:string;kind:'CHANNEL'|'ORGANIZATION';canDelete:boolean;
  blockers:string[];counts:Record<string,number>;externalEffects:string[];operationId:string|null;operationStatus:DeletionStatus|null};
export type DeletionOperation = {operationId:string;status:DeletionStatus;errorCode:string|null;updatedAt:string};
type WorkRow = {id:string;organization_id:string;kind:'CHANNEL'|'ORGANIZATION';resource_id:string;lease_token:string};
type CleanupRow = {instance_id:string;upstream_key:string;status:string};

export class LifecycleError extends Error {
  constructor(readonly code:string,readonly status:number){super(code);this.name='LifecycleError';}
}

async function withLifecycleTransaction<T>(pool:Pool,expectedRole:'jrc_platform'|'jrc_lifecycle',work:(tx:QueryClient)=>Promise<T>):Promise<T>{
  const client=await pool.connect();let open=false;let releaseError:Error|undefined;
  try{
    await client.query('BEGIN');open=true;
    const identity=await client.query<{currentUser:string;sessionUser:string;rolsuper:boolean;rolbypassrls:boolean}>(
      'SELECT current_user AS "currentUser",session_user AS "sessionUser",rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    const row=identity.rows[0];
    if(row?.currentUser!==expectedRole||row.sessionUser!==expectedRole||row.rolsuper||row.rolbypassrls)
      throw new Error('LIFECYCLE_ROLE_CONNECTION_REQUIRED');
    const result=await work(client);await client.query('COMMIT');open=false;return result;
  }catch(error){
    if(open){try{await client.query('ROLLBACK');}
      catch(rollbackError){releaseError=rollbackError instanceof Error?rollbackError:new Error(String(rollbackError));
        throw new AggregateError([error,rollbackError],'Lifecycle transaction rollback failed');}}
    throw error;
  }finally{client.release(releaseError);}
}
export const withLifecyclePlatformTransaction=<T>(pool:Pool,work:(tx:QueryClient)=>Promise<T>)=>
  withLifecycleTransaction(pool,'jrc_platform',work);
export const withLifecycleWorkerTransaction=<T>(pool:Pool,work:(tx:QueryClient)=>Promise<T>)=>
  withLifecycleTransaction(pool,'jrc_lifecycle',work);

export function createLifecycleService(options:{transact:LifecycleTransaction;
  deprovision:(organizationId:string,upstreamKey:string)=>Promise<void>;uuid?:()=>string}){
  const uuid=options.uuid??randomUUID;
  const translateError=(error:unknown):LifecycleError=>{
    if(error instanceof LifecycleError)return error;
    const candidate=error as {code?:string;constraint?:string};
    if(candidate?.code==='P0002')return new LifecycleError('LIFECYCLE_RESOURCE_NOT_FOUND',404);
    if(candidate?.code==='42501')return new LifecycleError('LIFECYCLE_FORBIDDEN',403);
    if(candidate?.constraint==='lifecycle_pending_work')return new LifecycleError('LIFECYCLE_PENDING_WORK',409);
    if(candidate?.constraint==='lifecycle_conflict')return new LifecycleError('LIFECYCLE_CONFLICT',409);
    if(candidate?.constraint==='channel_deletion_in_progress')return new LifecycleError('CHANNEL_DELETION_IN_PROGRESS',409);
    return new LifecycleError('LIFECYCLE_UNAVAILABLE',503);
  };
  const secure=<T>(run:()=>Promise<T>)=>run().catch(error=>{throw translateError(error);});
  const previewChannel=(org:string,id:string)=>secure(async()=>options.transact(async tx=>{
    const value=await tx.query<{preview:DeletionPreview}>('SELECT public.lifecycle_preview_channel($1,$2) AS preview',[org,id]);
    if(!value.rows[0]?.preview)throw new LifecycleError('LIFECYCLE_RESOURCE_NOT_FOUND',404);
    return value.rows[0].preview;
  }));
  const previewOrganization=(org:string)=>secure(async()=>options.transact(async tx=>{
    const value=await tx.query<{preview:DeletionPreview}>('SELECT public.lifecycle_preview_organization($1) AS preview',[org]);
    if(!value.rows[0]?.preview)throw new LifecycleError('LIFECYCLE_RESOURCE_NOT_FOUND',404);
    return value.rows[0].preview;
  }));
  const requestChannel=(org:string,id:string,name:string,reason:string,actorKind:'TENANT'|'PLATFORM',actorId:string)=>secure(async()=>options.transact(async tx=>{
    const result=await tx.query<{id:string}>('SELECT public.lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id',
      [org,id,name,reason,actorKind,actorId]);
    const current=await tx.query<{status:DeletionStatus}>('SELECT status FROM lifecycle_deletions WHERE id=$1',[result.rows[0]!.id]);
    return {operationId:result.rows[0]!.id,status:current.rows[0]!.status};
  }));
  const requestOrganization=(org:string,name:string,reason:string,actorId:string)=>secure(async()=>options.transact(async tx=>{
    const result=await tx.query<{id:string}>('SELECT public.lifecycle_request_organization($1,$2,$3,$4) AS id',
      [org,name,reason,actorId]);
    const current=await tx.query<{status:DeletionStatus}>('SELECT status FROM lifecycle_deletions WHERE id=$1',[result.rows[0]!.id]);
    return {operationId:result.rows[0]!.id,status:current.rows[0]!.status};
  }));
  const status=(org:string,resource:string,operationId:string)=>secure(async()=>options.transact(async tx=>{
    const result=await tx.query<{id:string;status:DeletionStatus;error_code:string|null;updated_at:Date}>(
      'SELECT id,status,error_code,updated_at FROM lifecycle_deletions WHERE organization_id=$1 AND resource_id=$2 AND id=$3',
      [org,resource,operationId]);
    const row=result.rows[0];if(!row)throw new LifecycleError('LIFECYCLE_RESOURCE_NOT_FOUND',404);
    return {operationId:row.id,status:row.status,errorCode:row.error_code,updatedAt:new Date(row.updated_at).toISOString()};
  }));
  async function processOne():Promise<boolean>{
    const lease=uuid();
    const claimed=await options.transact(async tx=>{
      const result=await tx.query<WorkRow>(`UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL',lease_token=$1,
       lease_expires_at=now()+interval '10 minutes',updated_at=now(),error_code=NULL
       WHERE id=(SELECT id FROM lifecycle_deletions WHERE status='REQUESTED'
         OR (status IN ('BLOCKING','CLEANING_EXTERNAL','REMOVING_DATA') AND lease_expires_at<now())
         ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,organization_id,kind,resource_id,lease_token`,[lease]);
      return result.rows[0];
    });
    if(!claimed)return false;
    try{
      const actorAuthorized=async (tx:QueryClient)=>{
        const result=await tx.query<{authorized:boolean}>(`SELECT CASE WHEN d.actor_kind='PLATFORM'
          THEN EXISTS(SELECT 1 FROM platform_users u WHERE u.id=d.actor_id AND u.role='SUPER_ADMIN' AND u.active)
          ELSE EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
            WHERE m.organization_id=d.organization_id AND m.user_id=d.actor_id AND m.status='ACTIVE'
              AND u.status='ACTIVE' AND m.role IN ('OWNER','ADMIN')) END AS authorized
          FROM lifecycle_deletions d WHERE d.id=$1 AND d.lease_token=$2 AND d.lease_expires_at>now()`,[claimed.id,lease]);
        return result.rows[0]?.authorized===true;
      };
      const authorized=await options.transact(actorAuthorized);
      if(!authorized){
        await options.transact(tx=>tx.query("UPDATE lifecycle_deletions SET status='ACTION_REQUIRED',error_code='LIFECYCLE_ACTOR_REVOKED',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[claimed.id,lease]).then(()=>undefined));
        return true;
      }
      const items=await options.transact(async tx=>(await tx.query<CleanupRow>(
        'SELECT instance_id,upstream_key,status FROM lifecycle_cleanup_items WHERE deletion_id=$1 ORDER BY instance_id',[claimed.id])).rows);
      for(const item of items){
        if(item.status==='DONE')continue;
        const mayDeprovision=await options.transact(async tx=>{
          const refreshed=await tx.query('UPDATE lifecycle_deletions SET lease_expires_at=now()+interval \'10 minutes\',updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() RETURNING id',[claimed.id,lease]);
          if(!refreshed.rowCount)throw new LifecycleError('LIFECYCLE_LEASE_LOST',409);
          if(await actorAuthorized(tx))return true;
          await tx.query("UPDATE lifecycle_deletions SET status='ACTION_REQUIRED',error_code='LIFECYCLE_ACTOR_REVOKED',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[claimed.id,lease]);
          return false;
        });
        if(!mayDeprovision)return true;
        try{await options.deprovision(claimed.organization_id,item.upstream_key);}
        catch{
          await options.transact(async tx=>{
            await tx.query("UPDATE lifecycle_cleanup_items SET status='ACTION_REQUIRED',attempts=attempts+1,last_error_code='EVOLUTION_CLEANUP_UNVERIFIED',updated_at=now() WHERE deletion_id=$1 AND instance_id=$2",[claimed.id,item.instance_id]);
            await tx.query("UPDATE lifecycle_deletions SET status='ACTION_REQUIRED',error_code='EVOLUTION_CLEANUP_UNVERIFIED',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[claimed.id,lease]);
          });
          return true;
        }
        await options.transact(async tx=>{
          const active=await tx.query('SELECT id FROM lifecycle_deletions WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE',[claimed.id,lease]);
          if(!active.rowCount)throw new LifecycleError('LIFECYCLE_LEASE_LOST',409);
          await tx.query("UPDATE lifecycle_cleanup_items SET status='DONE',attempts=attempts+1,last_error_code=NULL,updated_at=now() WHERE deletion_id=$1 AND instance_id=$2",[claimed.id,item.instance_id]);
        });
      }
      await options.transact(async tx=>{
        const ready=await tx.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA',updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() RETURNING id",[claimed.id,lease]);
        if(!ready.rowCount)throw new LifecycleError('LIFECYCLE_LEASE_LOST',409);
        const purge=claimed.kind==='CHANNEL'?'lifecycle_purge_channel':'lifecycle_purge_organization';
        await tx.query(`SELECT public.${purge}($1,$2)`,[claimed.id,lease]);
      });
    }catch{
      await options.transact(tx=>tx.query("UPDATE lifecycle_deletions SET status='ACTION_REQUIRED',error_code='LIFECYCLE_PURGE_FAILED',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[claimed.id,lease]).then(()=>undefined));
    }
    return true;
  }
  return {previewChannel,previewOrganization,requestChannel,requestOrganization,status,processOne,translateError};
}
export type LifecycleService=ReturnType<typeof createLifecycleService>;
