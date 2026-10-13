import type {PoolClient} from 'pg';
import {z} from 'zod';
import {normalizeChatwootOrigin} from '../../integrations/chatwoot-destination.js';
import {PlatformError} from '../../platform/service.js';
export interface VerifiedNativeDeployment {kind:'JRC_NATIVE';provenance:'AUTHENTICATED_JRC_BFF'|'VERIFIED_DEPLOYMENT';hostSourceSha:string;hostImageDigest:string;fenceProtocolVersion:number}
export interface FlowDestinationApproval {kind:'STOCK';expectedOriginRevision:number}
export interface OriginApprovalContext {organizationId:string;origin:string;actorId:string;reason:string;declaration?:FlowDestinationApproval}
export interface FlowOriginStatus {kind:'STOCK'|'JRC_NATIVE'|null;revision:number;status:'READY'|'DECLARATION_REQUIRED'|'NATIVE_EVIDENCE_REQUIRED'|'REVOKED'}
const declarationSchema=z.strictObject({kind:z.literal('STOCK'),expectedOriginRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
const nativeSchema=z.strictObject({kind:z.literal('JRC_NATIVE'),provenance:z.enum(['AUTHENTICATED_JRC_BFF','VERIFIED_DEPLOYMENT']),hostSourceSha:z.string().regex(/^[a-f0-9]{40}$/),hostImageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),fenceProtocolVersion:z.number().int().positive()});
export function createFlowOriginApproval(options:{nativeDeployments?:ReadonlyMap<string,VerifiedNativeDeployment>;knownNativeOrigins?:ReadonlySet<string>}={}){
 const nativeDeployments=new Map([...options.nativeDeployments??[]].map(([origin,value])=>[normalizeChatwootOrigin(origin),nativeSchema.parse(value)]));
 const knownNativeOrigins=new Set([...options.knownNativeOrigins??[],...nativeDeployments.keys()].map(normalizeChatwootOrigin));
 const status=async(tx:PoolClient,value:string):Promise<FlowOriginStatus>=>{
  const origin=normalizeChatwootOrigin(value),row=(await tx.query<{kind:'STOCK'|'JRC_NATIVE';revision:number;revoked_at:Date|null}>('SELECT kind,revision,revoked_at FROM flow_executor_origins WHERE base_url=$1 FOR SHARE',[origin])).rows[0];
  if(knownNativeOrigins.has(origin)&&(!row||row.kind!=='JRC_NATIVE'||row.revoked_at))return {kind:'JRC_NATIVE',revision:row?.revision??0,status:'NATIVE_EVIDENCE_REQUIRED'};
  return row&&!row.revoked_at?{kind:row.kind,revision:row.revision,status:'READY'}:{kind:row?.kind??null,revision:row?.revision??0,status:row?'REVOKED':'DECLARATION_REQUIRED'};
 };
 const approve=async(tx:PoolClient,context:OriginApprovalContext):Promise<{kind:'STOCK'|'JRC_NATIVE';revision:number;status?:'NATIVE_EVIDENCE_REQUIRED'}>=>{
  const origin=normalizeChatwootOrigin(context.origin),declaration=context.declaration===undefined?undefined:declarationSchema.parse(context.declaration);
  const actor=(await tx.query('SELECT active,role FROM platform_users WHERE id=$1 FOR SHARE',[context.actorId])).rows[0];
  if(!actor?.active||actor.role!=='SUPER_ADMIN')throw new PlatformError(403,'PLATFORM_FORBIDDEN');
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('flow-origin:'||$1,0))",[origin]);
  const old=(await tx.query<{kind:'STOCK'|'JRC_NATIVE';revision:number;revoked_at:Date|null;host_source_sha:string|null;host_image_digest:string|null;fence_protocol_version:number|null}>('SELECT * FROM flow_executor_origins WHERE base_url=$1 FOR UPDATE',[origin])).rows[0];
  const native=nativeDeployments.get(origin);
  if(knownNativeOrigins.has(origin)&&!native&&(old?.kind!=='JRC_NATIVE'||old.revoked_at)){
   if(declaration)throw new PlatformError(409,'FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED');
   // Destination approval permits Account/token onboarding; it is not an
   // installed native executor proof and does not fabricate a registry row.
   return {kind:'JRC_NATIVE',revision:old?.revision??0,status:'NATIVE_EVIDENCE_REQUIRED'};
  }
  if(native){
   if(old?.kind==='JRC_NATIVE'&&!old.revoked_at&&old.host_source_sha===native.hostSourceSha&&old.host_image_digest===native.hostImageDigest&&old.fence_protocol_version===native.fenceProtocolVersion)return {kind:old.kind,revision:old.revision};
  }else if(old&&!old.revoked_at){
   if(declaration&&declaration.expectedOriginRevision!==old.revision)throw new PlatformError(409,'FLOW_ORIGIN_REVISION_CHANGED');
   return {kind:old.kind,revision:old.revision};
  }else{
   if(old?.kind==='JRC_NATIVE')throw new PlatformError(409,'FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED');
   if(!declaration)throw new PlatformError(409,'FLOW_ORIGIN_DECLARATION_REQUIRED');
   if(declaration.expectedOriginRevision!==(old?.revision??0))throw new PlatformError(409,'FLOW_ORIGIN_REVISION_CHANGED');
  }
  // A global origin must not retain a reference to the first tenant's audit,
  // which is legitimately removed by that tenant's lifecycle purge.
  const audit=(await tx.query("INSERT INTO platform_audit_logs(actor_id,organization_id,action,reason) VALUES($1,NULL,'flow-origin-approve','Verified Flow executor origin declaration') RETURNING id",[context.actorId])).rows[0]!.id;
  const row=(await tx.query<{kind:'STOCK'|'JRC_NATIVE';revision:number}>(`INSERT INTO flow_executor_origins(base_url,kind,provenance,approval_audit_id,host_source_sha,host_image_digest,fence_protocol_version)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(base_url) DO UPDATE SET kind=excluded.kind,provenance=excluded.provenance,revision=flow_executor_origins.revision+1,approval_audit_id=excluded.approval_audit_id,host_source_sha=excluded.host_source_sha,host_image_digest=excluded.host_image_digest,fence_protocol_version=excluded.fence_protocol_version,verified_at=clock_timestamp(),revoked_at=NULL RETURNING kind,revision`,[origin,native?'JRC_NATIVE':'STOCK',native?.provenance??'PLATFORM_DESTINATION_APPROVAL',audit,native?.hostSourceSha??null,native?.hostImageDigest??null,native?.fenceProtocolVersion??null])).rows[0]!;
  return row;
 };
 return Object.assign(approve,{status});
}
