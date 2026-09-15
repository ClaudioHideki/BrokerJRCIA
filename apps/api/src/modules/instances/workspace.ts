import type { InstanceSettings, ProviderWorkspaceSnapshot, ProviderContext } from '@jrc/providers';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import type { Role } from '../../http/plugins/authorization.js';

export interface WorkspaceActor { organizationId:string; actorId:string; role:Role; requestId:string; signal?:AbortSignal; deadline?:Date }
export class WorkspaceError extends Error {
  constructor(readonly status:number,readonly code:string){super(code);}
}
interface InstanceRow { id:string; name:string; status:string; provider:string; upstreamKey:string; organizationStatus:string; createdAt:Date; updatedAt:Date }
interface Dependencies {
  transact<T>(organizationId:string,operation:OrganizationTransaction<T>):Promise<T>;
  provider:{read(context:ProviderContext,key:string):Promise<ProviderWorkspaceSnapshot>;updateSettings(context:ProviderContext,key:string,settings:InstanceSettings):Promise<void>};
}
export class InstanceWorkspaceService {
  constructor(private readonly deps:Dependencies){}
  private context(actor:WorkspaceActor):ProviderContext {
    return {organizationId:actor.organizationId,requestId:actor.requestId,deadline:actor.deadline??new Date(Date.now()+10_000),signal:actor.signal??AbortSignal.timeout(10_000)};
  }
  private async instance(tx:TenantTransaction,actor:WorkspaceActor,id:string):Promise<InstanceRow>{
    const result=await tx.query<InstanceRow>(`SELECT i.id,i.name,i.status,pa.provider,
      i.upstream_instance_key AS "upstreamKey",o.status AS "organizationStatus",
      i.created_at AS "createdAt",i.updated_at AS "updatedAt" FROM instances i
      JOIN provider_accounts pa ON pa.id=i.provider_account_id AND pa.organization_id=i.organization_id
      JOIN organizations o ON o.id=i.organization_id WHERE i.organization_id=$1 AND i.id=$2`,[actor.organizationId,id]);
    const row=result.rows[0];
    if(!row)throw new WorkspaceError(404,'NOT_FOUND');
    if(row.provider!=='BAILEYS')throw new WorkspaceError(409,'UNSUPPORTED_PROVIDER');
    return row;
  }
  async read(actor:WorkspaceActor,id:string){
    const local=await this.deps.transact(actor.organizationId,async tx=>{
      const instance=await this.instance(tx,actor,id);
      const operations=await tx.query<{id:string;type:string;status:string;attempts:number;errorCode:string|null;updatedAt:Date}>(
        `SELECT id,operation_type AS type,status,attempt_count AS attempts,canonical_error_code AS "errorCode",updated_at AS "updatedAt"
         FROM provider_operations WHERE organization_id=$1 AND instance_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 30`,[actor.organizationId,id]);
      return {instance,operations:operations.rows};
    });
    let snapshot:ProviderWorkspaceSnapshot={profile:{name:null,phone:null,state:null},counts:{contacts:null,chats:null,messages:null},settings:null};
    let providerAvailable=false;
    try {snapshot=await this.deps.provider.read(this.context(actor),local.instance.upstreamKey);providerAvailable=true;}catch{/* Return local data without leaking provider errors. */}
    const {instance}=local;
    return {observedAt:new Date().toISOString(),providerAvailable,...snapshot,
      instance:{id:instance.id,name:instance.name,status:instance.status,createdAt:instance.createdAt.toISOString(),updatedAt:instance.updatedAt.toISOString()},
      operations:local.operations.map(row=>({...row,updatedAt:row.updatedAt.toISOString()}))};
  }
  private async audit(tx:TenantTransaction,actor:WorkspaceActor,id:string,outcome:string){
    await tx.query(`INSERT INTO audit_logs (organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
      VALUES ($1,$2,'INSTANCE_SETTINGS_UPDATE','instance',$3,$4,$5,'{}'::jsonb)`,[actor.organizationId,actor.actorId,id,actor.requestId,outcome]);
  }
  async update(actor:WorkspaceActor,id:string,settings:InstanceSettings){
    if(!['OWNER','ADMIN'].includes(actor.role))throw new WorkspaceError(403,'FORBIDDEN');
    const instance=await this.deps.transact(actor.organizationId,async tx=>{
      const row=await this.instance(tx,actor,id);
      if(row.organizationStatus!=='ACTIVE')throw new WorkspaceError(403,'ORGANIZATION_SUSPENDED');
      const membership=await tx.query<{role:Role}>(`SELECT m.role FROM memberships m
        WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'`,[actor.organizationId,actor.actorId]);
      if(!['OWNER','ADMIN'].includes(membership.rows[0]?.role??''))throw new WorkspaceError(403,'FORBIDDEN');
      if(['PROVISIONING','FAILED'].includes(row.status))throw new WorkspaceError(409,'INSTANCE_NOT_READY');
      await this.audit(tx,actor,id,'ATTEMPTED');
      return row;
    });
    try{await this.deps.provider.updateSettings(this.context(actor),instance.upstreamKey,settings);}
    catch{await this.deps.transact(actor.organizationId,tx=>this.audit(tx,actor,id,'UNKNOWN'));throw new WorkspaceError(502,'PROVIDER_SETTINGS_UNCONFIRMED');}
    await this.deps.transact(actor.organizationId,tx=>this.audit(tx,actor,id,'SUCCESS'));
    return {ok:true as const};
  }
}
