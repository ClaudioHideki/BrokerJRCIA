import {AUTOMATION_ORIGIN,ChannelOperationProfileSchema,type ChannelOperationBlocker,type ChannelOperationProfile} from '@jrc/contracts';
import type {OrganizationTransaction} from '../../db/tenant-transaction.js';
import {requireActiveOrganization} from '../tenancy/operational-limits.js';
import {accountCompatibility} from '../integrations/chatwoot-compatibility.js';
import {normalizeChatwootOrigin} from '../integrations/chatwoot-destination.js';
import {AttendanceError} from '../attendance/types.js';
interface Snapshot{
 id:string;channel_id:string|null;connected:boolean;inactive:boolean;provider:'QR'|'META';
 central_configured:boolean;legacy_executor:boolean;
 integration_id:string|null;connection_status:string|null;inbox_id:string|null;
 account_id:string|null;account_origin:string|null;account_status:string|null;has_credential:boolean|null;
 credential_version:number|null;capabilities:unknown;destination_origin:string|null;destination_mode:'MANAGED'|'EXTERNAL'|null;
 approval_status:'PENDING'|'APPROVED'|'REVOKED'|null;destination_revision:number|null;identity_blocked:boolean;
 observed_at:Date;
 callback_verified_at:Date|null;callback_destination_revision:number|null;callback_credential_version:number|null;
}
const positive=(value:string|null)=>value!==null&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
export function createChannelOperationProfile(options:{
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;managedOrigin?:string;externalDestinationsEnabled?:boolean;
}){
 return {get:(org:string,id:string)=>options.transact(org,async tx=>{
  await requireActiveOrganization(tx,org);
  const native=(await tx.query<{integration_id:string;origin:string;account_id:string;inbox_id:string;destination_revision:number;credential_version:number;
   status:string;connection_status:string;account_status:string;approval_status:string;mode:'MANAGED'|'EXTERNAL';current_origin:string;current_account:string;current_credential:number;current_destination:number;has_token:boolean;
   inactive:boolean;bot_id:string|null;capabilities_observed_at:Date|null;callback_verified_at:Date|null;callback_credential_version:number|null;callback_destination_revision:number|null;observed_at:Date}>(`SELECT b.*,b.integration_id,c.status AS connection_status,
   a.status AS account_status,a.base_url AS current_origin,a.account_id AS current_account,a.credential_version AS current_credential,a.encrypted_token IS NOT NULL AS has_token,
   d.revision AS current_destination,d.approval_status,d.mode,m.deleting_at IS NOT NULL AS inactive,statement_timestamp() AS observed_at
   FROM central_transport_bindings b JOIN messaging_channels m ON m.organization_id=b.organization_id AND m.id=b.channel_id
   JOIN chatwoot_connections c ON c.organization_id=b.organization_id AND c.id=b.integration_id
   JOIN chatwoot_accounts a ON a.organization_id=b.organization_id JOIN chatwoot_destinations d ON d.organization_id=b.organization_id
   WHERE b.organization_id=$1 AND b.channel_id=$2`,[org,id])).rows[0];
  if(native){
   const r=native,blockers:ChannelOperationBlocker[]=[];
   const matched=r.origin===r.current_origin&&Number(r.account_id)===Number(r.current_account)&&r.credential_version===r.current_credential&&r.destination_revision===r.current_destination
    &&(r.mode==='EXTERNAL'||r.origin===options.managedOrigin);
   if(!matched)blockers.push('CENTRAL_SCOPE_UNVERIFIED');
   if(r.inactive)blockers.push('CHANNEL_INACTIVE');
   if(r.approval_status!=='APPROVED')blockers.push('DESTINATION_NOT_APPROVED');
   if(r.account_status!=='READY'||!r.has_token)blockers.push('ACCOUNT_NOT_READY');
   if(r.status!=='READY'||r.connection_status!=='READY')blockers.push('CONNECTION_NOT_READY');
   if(r.mode==='EXTERNAL'&&!options.externalDestinationsEnabled)blockers.push('CENTRAL_INTEGRATION_DISABLED');
   const capabilitiesObservedAt=matched&&r.bot_id&&r.capabilities_observed_at&&r.capabilities_observed_at<=r.observed_at?r.capabilities_observed_at.toISOString():null;
   if(!capabilitiesObservedAt)blockers.push('CAPABILITIES_UNVERIFIED');
   const callbackObservedAt=matched&&r.callback_credential_version===r.current_credential&&r.callback_destination_revision===r.current_destination&&r.callback_verified_at&&r.callback_verified_at<=r.observed_at?r.callback_verified_at.toISOString():null;
   if(!callbackObservedAt)blockers.push('CALLBACK_UNVERIFIED');
   return ChannelOperationProfileSchema.parse({schemaVersion:1,organizationId:org,channelId:id,messagingChannelId:id,observedAt:r.observed_at.toISOString(),
    mode:matched?(r.mode==='MANAGED'?'JRC_MANAGED':'CHATWOOT_EXTERNAL'):null,transport:matched?'CENTRAL_TRANSPORT':null,readiness:blockers.length?'BLOCKED':'READY',blockers,
    central:matched?{origin:r.origin,accountId:Number(r.account_id),inboxId:Number(r.inbox_id),integrationId:r.integration_id,destinationRevision:r.destination_revision,credentialVersion:r.credential_version}:null,
    deliveryVerified:false,capabilitiesObservedAt,callbackObservedAt});
  }
  // One statement snapshot includes raw configuration and residual authority. A failed
  // account/destination JOIN must never erase the configured central.
  const rows=(await tx.query<Snapshot>(`WITH source AS (
   SELECT i.id,c.id AS channel_id,'QR'::text AS provider,i.status='CONNECTED' AS connected,
    i.archived_at IS NOT NULL OR c.deleting_at IS NOT NULL AS inactive,c.bot_public_id,c.bot_origin_reference
   FROM instances i JOIN provider_accounts p ON p.organization_id=i.organization_id AND p.id=i.provider_account_id AND p.provider='BAILEYS'
   LEFT JOIN messaging_channels c ON c.organization_id=i.organization_id AND c.instance_id=i.id
   WHERE i.organization_id=$1 AND i.id=$2
   UNION ALL SELECT m.id,c.id,'META',m.status='READY',c.deleting_at IS NOT NULL,c.bot_public_id,c.bot_origin_reference
   FROM meta_connections m JOIN messaging_channels c ON c.organization_id=m.organization_id AND c.id=m.channel_id AND c.provider='META'
   WHERE m.organization_id=$1 AND m.id=$2
  ) SELECT s.*,cw.id AS integration_id,cw.status AS connection_status,cw.inbox_id::text,
   a.account_id::text,a.base_url AS account_origin,a.status AS account_status,a.encrypted_token IS NOT NULL AS has_credential,
   a.credential_version,a.capabilities,d.base_url AS destination_origin,d.mode AS destination_mode,
   d.approval_status,d.revision AS destination_revision,
   (cw.id IS NOT NULL OR o.integration_id IS NOT NULL OR o.remote_binding_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM chatwoot_attendance_controls x WHERE x.organization_id=$1 AND x.channel_id=s.channel_id)
    OR EXISTS(SELECT 1 FROM attendance_sessions x WHERE x.organization_id=$1 AND x.channel_id=s.channel_id AND x.state<>'RESOLVED' AND x.integration_id IS NOT NULL)) AS central_configured,
   (o.remote_binding_id IS NOT NULL OR o.executor='EXTERNAL' OR (s.bot_public_id IS NOT NULL AND s.bot_origin_reference IS DISTINCT FROM $3)) AS legacy_executor,
   coalesce(h.identity_enforced AND (h.approved_fingerprint IS NULL OR h.observed_fingerprint IS DISTINCT FROM h.approved_fingerprint OR NOT h.observed_connected OR h.identity_error IS NOT NULL OR h.access_error IS NOT NULL),false) AS identity_blocked,
   h.callback_verified_at,h.callback_destination_revision,h.callback_credential_version,statement_timestamp() AS observed_at
   FROM source s LEFT JOIN chatwoot_connections cw ON cw.organization_id=$1 AND cw.channel_id=s.channel_id
   LEFT JOIN attendance_owners o ON o.organization_id=$1 AND o.channel_id=s.channel_id
   LEFT JOIN chatwoot_accounts a ON a.organization_id=$1
   LEFT JOIN chatwoot_destinations d ON d.organization_id=$1
   LEFT JOIN chatwoot_connection_health h ON h.organization_id=$1 AND h.integration_id=cw.id AND h.channel_id=s.channel_id`,[org,id,AUTOMATION_ORIGIN])).rows;
  if(rows.length!==1)throw new AttendanceError('CHANNEL_NOT_FOUND',404);
  const r=rows[0]!,blockers:ChannelOperationBlocker[]=[];
  let mode:ChannelOperationProfile['mode']=null,transport:ChannelOperationProfile['transport']=null,central:ChannelOperationProfile['central']=null;
  let capabilitiesObservedAt:string|null=null;
  let callbackObservedAt:string|null=null;
  if(!r.channel_id)blockers.push('CHANNEL_NOT_ACTIVATED');
  if(r.inactive)blockers.push('CHANNEL_INACTIVE');
  if(!r.connected)blockers.push('TRANSPORT_NOT_CONNECTED');
  if(r.legacy_executor)blockers.push('LEGACY_EXECUTOR_PRESENT');
  if(!r.central_configured){mode='STANDALONE';if(!r.legacy_executor)transport='BROKER_TRANSPORT';}
  else {
   const accountId=positive(r.account_id),inboxId=positive(r.inbox_id);
   let origin:string|null=null;
   try{if(r.destination_origin&&normalizeChatwootOrigin(r.destination_origin)===r.destination_origin)origin=r.destination_origin;}catch{/* Invalid stored origin stays unverified. */}
   const matched=Boolean(origin&&origin===r.account_origin&&r.integration_id&&accountId&&inboxId&&r.destination_revision&&r.credential_version
    &&(r.destination_mode==='EXTERNAL'||r.destination_mode==='MANAGED'&&origin===options.managedOrigin));
   if(!matched)blockers.push('CENTRAL_SCOPE_UNVERIFIED');
   else {
    mode=r.destination_mode==='MANAGED'?'JRC_MANAGED':'CHATWOOT_EXTERNAL';
    if(r.destination_mode==='EXTERNAL'&&!options.externalDestinationsEnabled)blockers.push('CENTRAL_INTEGRATION_DISABLED');
    if(!r.legacy_executor)transport='BROKER_TRANSPORT';
    central={origin:origin!,accountId:accountId!,inboxId:inboxId!,integrationId:r.integration_id!,destinationRevision:r.destination_revision!,credentialVersion:r.credential_version!};
    const c=accountCompatibility({organization_id:org,base_url:origin!,account_id:r.account_id,encrypted_token:null,
     status:'READY',last_error:null,credential_version:r.credential_version!,capabilities:r.capabilities,
     destination:{organizationId:org,baseUrl:origin!,mode:r.destination_mode!,approvalStatus:r.approval_status!,mediaOrigins:[],revision:r.destination_revision!}});
    const saved=r.capabilities as {credentialVersion?:unknown;destinationRevision?:unknown;observedAt?:unknown}|null;
    if(saved?.credentialVersion===r.credential_version&&saved?.destinationRevision===r.destination_revision&&typeof saved.observedAt==='string'){
     const time=Date.parse(saved.observedAt);if(Number.isFinite(time)&&time<=r.observed_at.getTime())capabilitiesObservedAt=new Date(time).toISOString();
    }
    if(c.state!=='READY'||!capabilitiesObservedAt)blockers.push(c.state==='UNSUPPORTED'?'CAPABILITIES_UNSUPPORTED':'CAPABILITIES_UNVERIFIED');
    if(r.callback_destination_revision===r.destination_revision&&r.callback_credential_version===r.credential_version
     &&r.callback_verified_at&&Number.isFinite(r.callback_verified_at.getTime())&&r.callback_verified_at<=r.observed_at)callbackObservedAt=r.callback_verified_at.toISOString();
    if(!callbackObservedAt)blockers.push('CALLBACK_UNVERIFIED');
   }
   if(r.approval_status!=='APPROVED')blockers.push('DESTINATION_NOT_APPROVED');
   if(r.account_status!=='READY'||!r.has_credential)blockers.push('ACCOUNT_NOT_READY');
   if(r.connection_status!=='READY')blockers.push('CONNECTION_NOT_READY');
   if(r.identity_blocked)blockers.push('IDENTITY_UNVERIFIED');
  }
  return ChannelOperationProfileSchema.parse({schemaVersion:1,organizationId:org,channelId:id,messagingChannelId:r.channel_id,
   observedAt:r.observed_at.toISOString(),mode,transport,readiness:blockers.length?'BLOCKED':'READY',blockers,central,deliveryVerified:false,capabilitiesObservedAt,callbackObservedAt});
 })};
}
