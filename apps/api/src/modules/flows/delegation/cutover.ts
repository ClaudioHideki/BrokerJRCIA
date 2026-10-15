import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {TenantTransaction,OrganizationTransaction} from '../../../db/tenant-transaction.js';
import {readOwnerRevision} from '../../attendance/transition.js';
import {readCentralTransportContext} from '../../messaging/central-transport.js';
import {readChatwootHealth} from '../../integrations/chatwoot-health.js';
import type {ChatwootHealth} from '../../integrations/chatwoot-health.js';
import {FlowCutoverProofSchema} from '@jrc/contracts';
import {FlowDelegationError,readFlowOriginCapability,type FlowOriginCapability,type Authority,type FlowAccess,type Mapping,type FlowDelegationOptions} from './service.js';
import {remoteDeadline} from './remote.js';
import {AutomationError} from '../../automations/service.js';
import {TenantOperationalError} from '../../tenancy/operational-limits.js';
function fail(code='FLOW_CUTOVER_CHANGED',status=409):never{throw new FlowDelegationError(code,status);}
interface Row {id:string;integration_id:string;channel_id:string;host_kind:'STOCK'|'JRC_NATIVE';profile_revision:number;origin_capability_revision:number;revision:number;expected_owner_revision:number;
 phase:string;account_id:string;inbox_id:string;destination_revision:number;account_credential_version:number;live:boolean;lease_expires_at:Date|null;fence_dispatched_at:Date|null;
 qr_identity_revision:number|null;qr_identity_fingerprint:string|null;remote_bot_id:string|null;remote_bot_callback:string|null;lease_token:string|null;lease_live:boolean}
interface Context {state:Authority;target:Mapping;origin:FlowOriginCapability;profile:{revision:number;host_kind:'STOCK'|'JRC_NATIVE'};identityRevision:number|null;identityFingerprint:string|null;botId:number|null;botCallback:string|null}
export interface CutoverRequest {integrationId:string;cutoverId:string;expectedOwnerRevision:number;version:number}
export interface NativeBindReceipt {
 organizationId:string;integrationId:string;cutoverId:string;cutoverRevision:number;expectedOwnerRevision:number;
 leaseToken:string;leaseExpiresAt:string;
}
type Options<D>={
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
 decision(access:FlowAccess):Promise<D|undefined>;
 authorize(tx:TenantTransaction,access:FlowAccess,decision:D|undefined,action?:'flow:read'|'flow:bind'):Promise<Authority>;
 client:FlowDelegationOptions['client'];identity:ChatwootHealth|undefined;nativeAdapter:FlowDelegationOptions['nativeAdapter'];
 remoteTimeoutMs:number;
 knownNativeOrigins?:ReadonlySet<string>|undefined;
};
/** This ledger consumes observed server proof only. An editor cannot submit a
 * drain proof or classify an EXTERNAL destination as stock implicitly. */
export function createDelegatedCutovers<D>(options:Options<D>){
 async function context(tx:TenantTransaction,access:FlowAccess,integrationId:string,decision:D|undefined):Promise<Context>{
  const state=await options.authorize(tx,access,decision),target=state.grants.find(g=>g.integration_id===integrationId&&g.scopes.includes('flow:bind'));
  if(!target)fail('FLOW_ACCESS_DENIED',403);
  const origin=await readFlowOriginCapability(tx,state.account,options.knownNativeOrigins);
  const p=(await tx.query<{revision:number;host_kind:'STOCK'|'JRC_NATIVE';origin_capability_revision:number;destination_origin:string;account_id:string;inbox_id:string;destination_revision:number;account_credential_version:number}>('SELECT * FROM flow_executor_profiles WHERE organization_id=$1 AND integration_id=$2 FOR SHARE',[access.organizationId,integrationId])).rows[0];
  if(!p||p.destination_origin!==state.account.base_url||p.host_kind!==origin.kind||p.origin_capability_revision!==origin.revision||Number(p.account_id)!==Number(target.account_id)||Number(p.inbox_id)!==Number(target.inbox_id)||p.destination_revision!==target.destination_revision||p.account_credential_version!==state.account.credential_version)fail('FLOW_CONTEXT_CHANGED');
  if(p.host_kind==='JRC_NATIVE'&&!options.nativeAdapter)fail('FLOW_HOST_ADAPTER_REQUIRED');
  let identityRevision:number|null=null,identityFingerprint:string|null=null,botId:number|null=null,botCallback:string|null=null;
  if(target.transport==='CENTRAL_TRANSPORT'){
   const central=await readCentralTransportContext(tx,access.organizationId,integrationId);
   const completed=(await tx.query('SELECT id FROM central_cutover_operations WHERE organization_id=$1 AND integration_id=$2 AND channel_id=$3 AND status=\'COMPLETE\' AND credential_version=$4 AND destination_revision=$5',[access.organizationId,integrationId,target.channel_id,state.account.credential_version,target.destination_revision])).rowCount;
   if(!completed||central.botId===null||!central.botCallback)fail('FLOW_CENTRAL_CUTOVER_REQUIRED');
   const callback=(await tx.query('SELECT 1 FROM central_transport_bindings WHERE organization_id=$1 AND integration_id=$2 AND callback_verified_at IS NOT NULL AND callback_credential_version=credential_version AND callback_destination_revision=destination_revision',[access.organizationId,integrationId])).rowCount;
   if(!callback)fail('CENTRAL_CALLBACK_TEST_REQUIRED');
   botId=central.botId;botCallback=central.botCallback;
  }else{
   if(target.provider!=='BAILEYS'||target.transport!=='BROKER_TRANSPORT')fail('FLOW_TRANSPORT_UNSUPPORTED');
   await tx.query('SELECT integration_id FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2 FOR SHARE',[access.organizationId,integrationId]);
   const health=await readChatwootHealth(tx,access.organizationId,integrationId);
   if(!health?.identity_enforced||!health.approved_fingerprint||health.approved_fingerprint!==health.observed_fingerprint||!health.observed_connected||health.identity_error)fail('FLOW_QR_IDENTITY_UNVERIFIED');
   identityRevision=health.identity_revision;identityFingerprint=health.approved_fingerprint;
  }
  return {state,target,origin,profile:p,identityRevision,identityFingerprint,botId,botCallback};
 }
 const same=(a:Context,b:Context)=>a.origin.revision===b.origin.revision&&a.profile.revision===b.profile.revision&&a.profile.host_kind===b.profile.host_kind&&a.state.account.base_url===b.state.account.base_url&&a.state.account.credential_version===b.state.account.credential_version&&a.target.channel_id===b.target.channel_id&&a.target.account_id===b.target.account_id&&a.target.inbox_id===b.target.inbox_id&&a.target.destination_revision===b.target.destination_revision&&a.identityRevision===b.identityRevision&&a.identityFingerprint===b.identityFingerprint&&a.botId===b.botId&&a.botCallback===b.botCallback;
 async function observed(c:Context){
  if(!options.client)fail('FLOW_ACCOUNT_CLIENT_REQUIRED');
  if(c.identityRevision!==null){if(!options.identity)fail('FLOW_QR_PROBE_REQUIRED');await options.identity.assertReady(c.state.account.organization_id,c.target.channel_id);}
  const client=options.client(c.state.account),accountId=Number(c.target.account_id),inboxId=Number(c.target.inbox_id);
  await client.verifyAccount(accountId);
  const inbox=await client.attendanceInbox(accountId,inboxId),bot=await client.inboxFlowBot(accountId,inboxId);
  if(inbox.id!==inboxId||(c.identityRevision!==null?inbox.channel_type!=='Channel::Api':!['Channel::Api','Channel::Whatsapp'].includes(inbox.channel_type)))fail('FLOW_INBOX_CHANGED');
  if(inbox.greeting_enabled!==false||inbox.enable_auto_assignment!==false)fail('FLOW_INBOX_POLICY_UNSAFE');
  if((bot?.id??null)!==c.botId||(bot?.outgoing_url??null)!==c.botCallback)fail('FLOW_COMPETING_EXECUTOR');
 }
 function hostRequest(access:FlowAccess,c:Context,row:Row){return {organizationId:access.organizationId,origin:c.state.account.base_url,accountId:Number(c.target.account_id),inboxId:Number(c.target.inbox_id),destinationRevision:c.target.destination_revision,accountCredentialVersion:c.state.account.credential_version,integrationId:c.target.integration_id,cutoverId:row.id,cutoverRevision:row.revision,expectedOwnerRevision:row.expected_owner_revision,originCapabilityRevision:c.origin.revision,expectedAgentBotId:c.botId,expectedAgentBotCallback:c.botCallback,expectedHostSourceSha:c.origin.host_source_sha,expectedHostImageDigest:c.origin.host_image_digest,nonce:c.state.session.nonce,externalActorId:c.state.session.external_actor_id,brokerActorId:c.state.session.user_id,leaseToken:row.lease_token,leaseExpiresAt:row.lease_expires_at?.toISOString()??null};}
 function proof(raw:unknown,request:ReturnType<typeof hostRequest>){
  const parsed=FlowCutoverProofSchema.safeParse(raw);if(!parsed.success)fail('FLOW_CUTOVER_PROOF_INVALID');
  for(const key of ['organizationId','accountId','inboxId','integrationId','cutoverId','cutoverRevision','expectedOwnerRevision'] as const)if(parsed.data[key]!==request[key])fail('FLOW_CUTOVER_PROOF_INVALID');
  if(parsed.data.hostSourceSha!==request.expectedHostSourceSha||parsed.data.hostImageDigest!==request.expectedHostImageDigest)fail('FLOW_CUTOVER_PROOF_INVALID');
  return parsed.data;
 }
 async function read(tx:TenantTransaction,org:string,id:string){
  const row=(await tx.query<Row>('SELECT * FROM flow_executor_cutovers WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,id])).rows[0];if(!row)fail();
  const valid=(await tx.query<{live:boolean;lease_live:boolean}>('SELECT proof_valid_until>clock_timestamp() AS live,lease_expires_at>clock_timestamp() AS lease_live FROM flow_executor_cutovers WHERE organization_id=$1 AND id=$2',[org,id])).rows[0]!;
  return {...row,...valid};
 }
 function checkAborted(signal:AbortSignal){if(signal.aborted)fail('FLOW_CUTOVER_TIMEOUT',503);}
 function sanitized(error:unknown):never{
  if(error instanceof FlowDelegationError)throw error;
  if(error instanceof TenantOperationalError)fail(error.code,403);
  if(error instanceof AutomationError&&['ORGANIZATION_NOT_ACTIVE','AUTOMATION_MODULE_DISABLED'].includes(error.code))fail(error.code,error.statusCode);
  fail('FLOW_CUTOVER_OBSERVATION_FAILED',503);
 }
 async function cleanup(access:FlowAccess,id:string,token:string){
  await options.transact(access.organizationId,tx=>tx.query("UPDATE flow_executor_cutovers SET phase=CASE WHEN fence_dispatched_at IS NULL THEN 'ROLLED_BACK' ELSE 'UNKNOWN' END,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND lease_token=$3",[access.organizationId,id,token]));
 }
 async function settle(tx:TenantTransaction,access:FlowAccess,snapshot:{c:Context;row:Row},token:string,phase:string,decision:D|undefined,host:ReturnType<typeof proof>|null){
  const current=await context(tx,access,snapshot.row.integration_id,decision),row=await read(tx,access.organizationId,snapshot.row.id);
  if(!same(current,snapshot.c)||row.lease_token!==token||!row.lease_live||row.phase!==phase||await readOwnerRevision(tx,access.organizationId,current.target.channel_id)!==snapshot.row.expected_owner_revision)fail();
  const result=await tx.query(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now) UPDATE flow_executor_cutovers f SET phase='DRAINED',admission_closed=true,lease_token=NULL,lease_expires_at=NULL,
   proof_observed_at=moment.now,proof_valid_until=moment.now+interval '30 seconds',qr_identity_revision=$3,qr_identity_fingerprint=$4,remote_bot_id=$5,remote_bot_callback=$6,
   host_fence_revision=$7,live_runs=$8,legacy_jobs=$8,uncertain_effects=$8,guarded_paths=$9,host_source_sha=$10,host_image_digest=$11,updated_at=moment.now FROM moment WHERE f.organization_id=$1 AND f.id=$2 AND f.lease_token=$12 AND f.lease_expires_at>clock_timestamp()`,[access.organizationId,row.id,current.identityRevision,current.identityFingerprint,current.botId,current.botCallback,host?.hostFenceRevision??null,host?0:null,host?.guardedPaths??[],host?.hostSourceSha??null,host?.hostImageDigest??null,token]);
  if(result.rowCount!==1)fail();return {id:row.id,revision:row.revision,phase:'DRAINED' as const};
 }
 async function verify(tx:TenantTransaction,access:FlowAccess,request:CutoverRequest,decision:D|undefined,ownerAfter?:number){
  const c=await context(tx,access,request.integrationId,decision),row=await read(tx,access.organizationId,request.cutoverId);
  if(row.integration_id!==request.integrationId||row.channel_id!==c.target.channel_id||row.phase!=='DRAINED'||!row.live||row.host_kind!==c.profile.host_kind||row.profile_revision!==c.profile.revision||row.origin_capability_revision!==c.origin.revision||row.expected_owner_revision!==request.expectedOwnerRevision||row.account_id!==c.target.account_id||row.inbox_id!==c.target.inbox_id||row.destination_revision!==c.target.destination_revision||row.account_credential_version!==c.state.account.credential_version||row.qr_identity_revision!==c.identityRevision||row.qr_identity_fingerprint!==c.identityFingerprint||Number(row.remote_bot_id??0)!==(c.botId??0)||row.remote_bot_callback!==c.botCallback)fail();
  if(await readOwnerRevision(tx,access.organizationId,c.target.channel_id)!==(ownerAfter??request.expectedOwnerRevision))fail('FLOW_OWNER_CHANGED');
  return {c,row};
 }
 async function verifyBinding(tx:TenantTransaction,access:FlowAccess,request:CutoverRequest,decision:D|undefined,receipt:NativeBindReceipt|null,ownerAfter?:number){
  const current=await verify(tx,access,request,decision,ownerAfter);
  if(current.c.profile.host_kind==='JRC_NATIVE'){
   const {row}=current;
   if(!receipt||receipt.organizationId!==access.organizationId||receipt.integrationId!==request.integrationId||receipt.cutoverId!==request.cutoverId||receipt.cutoverRevision!==row.revision||receipt.expectedOwnerRevision!==request.expectedOwnerRevision||receipt.leaseToken!==row.lease_token||!row.lease_live)fail();
   const live=(await tx.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[receipt.leaseExpiresAt])).rows[0]?.live;
   if(!live)fail();
  }
  return current;
 }
 async function releaseBinding(access:FlowAccess,request:CutoverRequest,receipt:NativeBindReceipt|null){
  if(!receipt)return;
  if(receipt.organizationId!==access.organizationId||receipt.integrationId!==request.integrationId||receipt.cutoverId!==request.cutoverId||receipt.expectedOwnerRevision!==request.expectedOwnerRevision)fail();
  // Reduction is allowed after revocation; only this exact live or expired
  // nomination is retired. An activated or replacement attempt is untouched.
  await options.transact(access.organizationId,tx=>tx.query(`UPDATE flow_executor_cutovers SET phase='UNKNOWN',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
   WHERE organization_id=$1 AND id=$2 AND integration_id=$3 AND revision=$4 AND lease_token=$5 AND phase='DRAINED'`,
   [access.organizationId,request.cutoverId,request.integrationId,receipt.cutoverRevision,receipt.leaseToken]));
 }
 return {
  async prepare(access:FlowAccess,integrationId:string,raw:unknown){
   z.uuid().parse(integrationId);const input=z.strictObject({expectedOwnerRevision:z.number().int().nonnegative()}).parse(raw),token=randomUUID();
   const decision=await options.decision(access);
   const snapshot=await options.transact(access.organizationId,async tx=>{
    const c=await context(tx,access,integrationId,decision);
    if(await readOwnerRevision(tx,access.organizationId,c.target.channel_id)!==input.expectedOwnerRevision)fail('FLOW_OWNER_CHANGED');
    const old=(await tx.query<Row>('SELECT * FROM flow_executor_cutovers WHERE organization_id=$1 AND integration_id=$2 FOR UPDATE',[access.organizationId,integrationId])).rows[0];
    if(old&&['REQUESTED','FENCED','UNKNOWN','ROLLBACK_DRAINING'].includes(old.phase))fail('FLOW_CUTOVER_RECONCILIATION_REQUIRED');
    const row=(await tx.query<Row>(`INSERT INTO flow_executor_cutovers(organization_id,id,integration_id,channel_id,host_kind,profile_revision,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,revision,expected_owner_revision,phase,lease_token,lease_expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$14,$7,$8,$9,$10,$11,$12,'REQUESTED',$13,clock_timestamp()+interval '10 seconds')
     ON CONFLICT(organization_id,integration_id) DO UPDATE SET id=excluded.id,channel_id=excluded.channel_id,host_kind=excluded.host_kind,profile_revision=excluded.profile_revision,origin_capability_revision=excluded.origin_capability_revision,account_id=excluded.account_id,inbox_id=excluded.inbox_id,destination_revision=excluded.destination_revision,account_credential_version=excluded.account_credential_version,revision=excluded.revision,expected_owner_revision=excluded.expected_owner_revision,phase='REQUESTED',lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,
      admission_closed=false,fence_dispatched_at=NULL,host_fence_revision=NULL,live_runs=NULL,legacy_jobs=NULL,uncertain_effects=NULL,guarded_paths='{}',proof_observed_at=NULL,proof_valid_until=NULL,host_source_sha=NULL,host_image_digest=NULL,qr_identity_revision=NULL,qr_identity_fingerprint=NULL,remote_bot_id=NULL,remote_bot_callback=NULL,activated_owner_revision=NULL,binding_id=NULL,automation_id=NULL RETURNING *`,[access.organizationId,randomUUID(),integrationId,c.target.channel_id,c.profile.host_kind,c.profile.revision,c.target.account_id,c.target.inbox_id,c.target.destination_revision,c.state.account.credential_version,(old?.revision??0)+1,input.expectedOwnerRevision,token,c.origin.revision])).rows[0]!;
    return {c,row};
   });
   try{
    const remote=await remoteDeadline(options.remoteTimeoutMs,'FLOW_CUTOVER_TIMEOUT',async signal=>{
     await observed(snapshot.c);checkAborted(signal);let host:ReturnType<typeof proof>|null=null;
     if(snapshot.c.profile.host_kind==='JRC_NATIVE'){
      const before=await options.decision(access);checkAborted(signal);
      await options.transact(access.organizationId,async tx=>{
       const current=await context(tx,access,integrationId,before),row=await read(tx,access.organizationId,snapshot.row.id);
       if(!same(current,snapshot.c)||row.lease_token!==token||!row.lease_live||row.phase!=='REQUESTED'||await readOwnerRevision(tx,access.organizationId,current.target.channel_id)!==input.expectedOwnerRevision)fail();
       const dispatched=await tx.query("UPDATE flow_executor_cutovers SET phase='FENCED',fence_dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND phase='REQUESTED' AND revision=$4 AND lease_expires_at>clock_timestamp()",[access.organizationId,row.id,token,row.revision]);
       if(dispatched.rowCount!==1)fail();
      });checkAborted(signal);
      host=proof(await options.nativeAdapter!.fenceAndDrain(hostRequest(access,snapshot.c,snapshot.row),signal),hostRequest(access,snapshot.c,snapshot.row));checkAborted(signal);
     }
     const currentDecision=await options.decision(access);checkAborted(signal);return {host,currentDecision};
    });
    return await options.transact(access.organizationId,tx=>settle(tx,access,snapshot,token,snapshot.c.profile.host_kind==='JRC_NATIVE'?'FENCED':'REQUESTED',remote.currentDecision,remote.host));
   }catch(error){
    await cleanup(access,snapshot.row.id,token);sanitized(error);
   }
  },
  verify:verifyBinding,
  releaseBinding,
  async get(access:FlowAccess,integrationId:string){
   z.uuid().parse(integrationId);const decision=await options.decision(access);
   return options.transact(access.organizationId,async tx=>{
    const state=await options.authorize(tx,access,decision,'flow:read');if(!state.grants.some(g=>g.integration_id===integrationId&&g.scopes.includes('flow:read')))fail('FLOW_ACCESS_DENIED',403);
    const row=(await tx.query<{id:string;phase:string;revision:number;expected_owner_revision:number;updated_at:Date;proof_valid_until:Date|null;ready:boolean}>("SELECT id,phase,revision,expected_owner_revision,updated_at,proof_valid_until,phase='DRAINED' AND proof_valid_until>clock_timestamp() AS ready FROM flow_executor_cutovers WHERE organization_id=$1 AND integration_id=$2",[access.organizationId,integrationId])).rows[0];
    if(!row)fail('FLOW_CUTOVER_NOT_FOUND',404);
    return {id:row.id,integrationId,phase:row.phase,revision:row.revision,expectedOwnerRevision:row.expected_owner_revision,updatedAt:row.updated_at.toISOString(),proofValidUntil:row.proof_valid_until?.toISOString()??null,ready:row.ready===true};
   });
  },
  async reconcile(access:FlowAccess,integrationId:string,raw:unknown){
   z.uuid().parse(integrationId);const input=z.strictObject({cutoverId:z.uuid(),expectedCutoverRevision:z.number().int().positive(),expectedOwnerRevision:z.number().int().nonnegative()}).parse(raw),token=randomUUID(),decision=await options.decision(access);
   const snapshot=await options.transact(access.organizationId,async tx=>{
    const c=await context(tx,access,integrationId,decision),row=await read(tx,access.organizationId,input.cutoverId);
    if(row.integration_id!==integrationId||row.revision!==input.expectedCutoverRevision||row.expected_owner_revision!==input.expectedOwnerRevision||!['UNKNOWN','DRAINED','REQUESTED','FENCED'].includes(row.phase)||row.lease_live||await readOwnerRevision(tx,access.organizationId,c.target.channel_id)!==input.expectedOwnerRevision)fail();
    if(c.profile.host_kind==='JRC_NATIVE'&&!row.fence_dispatched_at){
     await tx.query("UPDATE flow_executor_cutovers SET phase='ROLLED_BACK',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",[access.organizationId,row.id]);
     return {c,row,retired:true as const};
    }
    if(row.origin_capability_revision!==c.origin.revision||row.profile_revision!==c.profile.revision||row.host_kind!==c.profile.host_kind||row.channel_id!==c.target.channel_id||row.account_id!==c.target.account_id||row.inbox_id!==c.target.inbox_id||row.destination_revision!==c.target.destination_revision||row.account_credential_version!==c.state.account.credential_version)fail();
    const leased=(await tx.query<Row>("UPDATE flow_executor_cutovers SET lease_token=$3,lease_expires_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND revision=$4 AND phase=$5 RETURNING *,proof_valid_until>clock_timestamp() AS live,lease_expires_at>clock_timestamp() AS lease_live",[access.organizationId,row.id,token,row.revision,row.phase])).rows[0];
    if(!leased)fail();
    return {c,row:leased,retired:false as const};
   });
   if(snapshot.retired)return {id:snapshot.row.id,revision:snapshot.row.revision,phase:'ROLLED_BACK' as const};
   try{
    const remote=await remoteDeadline(options.remoteTimeoutMs,'FLOW_CUTOVER_TIMEOUT',async signal=>{
     await observed(snapshot.c);checkAborted(signal);
     const host=snapshot.c.profile.host_kind==='JRC_NATIVE'?proof(await options.nativeAdapter!.observeFence(hostRequest(access,snapshot.c,snapshot.row),signal),hostRequest(access,snapshot.c,snapshot.row)):null;checkAborted(signal);
     const currentDecision=await options.decision(access);checkAborted(signal);return {host,currentDecision};
    });
    return await options.transact(access.organizationId,tx=>settle(tx,access,snapshot,token,snapshot.row.phase,remote.currentDecision,remote.host));
   }catch(error){await cleanup(access,snapshot.row.id,token);sanitized(error);}
  },
  async beforeTransaction(access:FlowAccess,request:CutoverRequest,decision:D|undefined):Promise<NativeBindReceipt|null>{
   const token=randomUUID(),snapshot=await options.transact(access.organizationId,async tx=>{
    const current=await verify(tx,access,request,decision);
    if(current.c.profile.host_kind!=='JRC_NATIVE')return current;
    if(current.row.lease_live)fail();
    const row=(await tx.query<Row>(`UPDATE flow_executor_cutovers SET lease_token=$3,lease_expires_at=LEAST(clock_timestamp()+interval '10 seconds',proof_valid_until),updated_at=clock_timestamp()
     WHERE organization_id=$1 AND id=$2 AND revision=$4 AND phase='DRAINED' AND proof_valid_until>clock_timestamp()
      AND (lease_token IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *`,[access.organizationId,request.cutoverId,token,current.row.revision])).rows[0];
    if(!row)fail();return {c:current.c,row};
   });
   const receipt:NativeBindReceipt|null=snapshot.c.profile.host_kind==='JRC_NATIVE'?{organizationId:access.organizationId,integrationId:request.integrationId,cutoverId:request.cutoverId,cutoverRevision:snapshot.row.revision,expectedOwnerRevision:request.expectedOwnerRevision,leaseToken:token,leaseExpiresAt:snapshot.row.lease_expires_at!.toISOString()}:null;
   try{
    await remoteDeadline(options.remoteTimeoutMs,'FLOW_CUTOVER_TIMEOUT',async signal=>{
     await observed(snapshot.c);checkAborted(signal);
     if(receipt){
      proof(await options.nativeAdapter!.observeFence(hostRequest(access,snapshot.c,snapshot.row),signal),hostRequest(access,snapshot.c,snapshot.row));checkAborted(signal);
      const currentDecision=await options.decision(access);checkAborted(signal);
      await options.transact(access.organizationId,async tx=>{
       const current=await verifyBinding(tx,access,request,currentDecision,receipt);checkAborted(signal);
       if(!same(current.c,snapshot.c))fail();
      });checkAborted(signal);
     }
    });
    return receipt;
   }catch(error){await releaseBinding(access,request,receipt);sanitized(error);}
  },
  async activate(tx:TenantTransaction,access:FlowAccess,request:CutoverRequest,decision:D|undefined,result:{ownerRevision:number;id:string;automationId:string},receipt:NativeBindReceipt|null){
   const {row,c}=await verifyBinding(tx,access,request,decision,receipt,result.ownerRevision);
   const updated=await tx.query(`UPDATE flow_executor_cutovers SET phase='ACTIVATED',activated_owner_revision=$3,binding_id=$4,automation_id=$5,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE organization_id=$1 AND id=$2 AND phase='DRAINED' AND revision=$6 AND proof_valid_until>clock_timestamp()
     AND ($7::boolean OR (lease_token=$8 AND lease_expires_at>clock_timestamp() AND $9::timestamptz>clock_timestamp()))`,[access.organizationId,row.id,result.ownerRevision,result.id,result.automationId,row.revision,c.profile.host_kind==='STOCK',receipt?.leaseToken??null,receipt?.leaseExpiresAt??null]);
   if(updated.rowCount!==1)fail();
  },
 };
}
