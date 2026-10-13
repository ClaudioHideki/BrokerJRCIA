import {z} from 'zod';import type {TenantTransaction,OrganizationTransaction} from '../../../db/tenant-transaction.js';
import {lockOwnershipMutations} from '../../attendance/transition.js';
const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),external=revision;
export const NativeReopenProofRequestSchema=z.strictObject({credentialId:z.uuid(),credentialRevision:revision,registrationId:z.uuid(),registrationRevision:revision,integrationId:z.uuid(),accountId:external,inboxId:external,destinationRevision:revision,accountCredentialVersion:revision,cutoverRevision:revision,expectedCurrentOwnerRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),nonce:z.uuid()});
export const NativeReopenProofResponseSchema=z.strictObject({organizationId:z.uuid(),cutoverId:z.uuid(),cutoverRevision:revision,integrationId:z.uuid(),accountId:external,inboxId:external,nonce:z.uuid(),ownerRevision:z.number().int().nonnegative(),brokerDrained:z.literal(true),proofValidUntil:z.iso.datetime()});
type Access={organizationId:string;token:string};type Authority={origin:string;tuple:{credentialId:string;credentialRevision:number;destinationRevision:number;accountCredentialVersion:number;accountId:number;targets:{integrationId:string;channelId:string;inboxId:number}[]}};
type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;authorize(tx:TenantTransaction,access:Access,credentialId:string,ids:string[]):Promise<Authority>};
function fail():never{throw Object.assign(new Error('FLOW_REOPEN_PROOF_REQUIRED'),{code:'FLOW_REOPEN_PROOF_REQUIRED',statusCode:409});}
export function createNativeReopenProof(options:Options){return{observe:async(access:Access,id:string,raw:unknown)=>{
 const input=NativeReopenProofRequestSchema.parse(raw);z.uuid().parse(id);z.uuid().parse(access.organizationId);
 return options.transact(access.organizationId,async tx=>{
  await lockOwnershipMutations(tx,access.organizationId);
  const authority=await options.authorize(tx,access,input.credentialId,[input.integrationId]),target=authority.tuple.targets.find(t=>t.integrationId===input.integrationId);if(!target)fail();
  const tuple=authority.tuple;if(tuple.credentialRevision!==input.credentialRevision||tuple.accountId!==input.accountId||target.inboxId!==input.inboxId||tuple.destinationRevision!==input.destinationRevision||tuple.accountCredentialVersion!==input.accountCredentialVersion)fail();
  await tx.query('SELECT id FROM messaging_channels WHERE organization_id=$1 AND id=$2 AND deleting_at IS NULL FOR UPDATE',[access.organizationId,target.channelId]);
  const registration=(await tx.query<{revision:number;credential_id:string;credential_revision:number;live:boolean}>(`SELECT revision,credential_id,credential_revision,revoked_at IS NULL AND expires_at>clock_timestamp() AS live FROM flow_native_registrations WHERE organization_id=$1 AND id=$2 FOR SHARE`,[access.organizationId,input.registrationId])).rows[0];
  if(!registration?.live||registration.revision!==input.registrationRevision||registration.credential_id!==input.credentialId||registration.credential_revision!==input.credentialRevision)fail();
  const cutover=(await tx.query<{id:string;channel_id:string;integration_id:string;revision:number;account_id:string;inbox_id:string;destination_revision:number;account_credential_version:number;binding_id:string|null;phase:string}>('SELECT * FROM flow_executor_cutovers WHERE organization_id=$1 AND id=$2 FOR UPDATE',[access.organizationId,id])).rows[0];
  if(!cutover||cutover.channel_id!==target.channelId||cutover.integration_id!==input.integrationId||cutover.revision!==input.cutoverRevision||Number(cutover.account_id)!==input.accountId||Number(cutover.inbox_id)!==input.inboxId||cutover.destination_revision!==input.destinationRevision||cutover.account_credential_version!==input.accountCredentialVersion||!['ACTIVATED','DRAINED','ROLLED_BACK','ROLLBACK_DRAINING'].includes(cutover.phase))fail();
  const owner=(await tx.query<{revision:number;executor:string}>('SELECT revision,executor FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE',[access.organizationId,target.channelId])).rows[0];
  if(!owner||owner.executor!=='NONE'||owner.revision!==input.expectedCurrentOwnerRevision)fail();
  const blocked=(await tx.query<{blocked:boolean}>(`SELECT (
    EXISTS(SELECT 1 FROM automation_bindings WHERE organization_id=$1 AND channel_id=$2 AND status<>'DISABLED') OR
    EXISTS(SELECT 1 FROM automation_executions WHERE organization_id=$1 AND channel_id=$2 AND status IN('QUEUED','RUNNING','WAITING','UNKNOWN')) OR
    EXISTS(SELECT 1 FROM automation_outbox o JOIN automation_executions e ON e.organization_id=o.organization_id AND e.id=o.execution_id WHERE e.organization_id=$1 AND e.channel_id=$2 AND o.status IN('PENDING','SENDING','UNKNOWN')) OR
    EXISTS(SELECT 1 FROM automation_ai_reservations r JOIN automation_outbox o ON o.organization_id=r.organization_id AND o.id=r.outbox_id JOIN automation_executions e ON e.organization_id=o.organization_id AND e.id=o.execution_id WHERE e.organization_id=$1 AND e.channel_id=$2 AND r.status='UNKNOWN') OR
    EXISTS(SELECT 1 FROM automation_waits w JOIN automation_executions e ON e.organization_id=w.organization_id AND e.id=w.execution_id WHERE e.organization_id=$1 AND e.channel_id=$2 AND w.status='WAITING') OR
    EXISTS(SELECT 1 FROM messaging_bot_jobs j JOIN messaging_conversations c ON c.organization_id=j.organization_id AND c.id=j.conversation_id WHERE c.organization_id=$1 AND c.channel_id=$2 AND j.status IN('PENDING','RUNNING','UNKNOWN')) OR
    EXISTS(SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND channel_id=$2 AND direction='OUTGOING' AND source='AUTOMATION' AND state IN('ACCEPTED','SENDING','UNKNOWN')) OR
    EXISTS(SELECT 1 FROM flow_chatwoot_bindings b JOIN chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id WHERE c.organization_id=$1 AND c.channel_id=$2 AND (b.status<>'DISABLED' OR b.operation_state<>'IDLE' OR b.bot_id IS NOT NULL))
   ) AS blocked`,[access.organizationId,target.channelId])).rows[0];if(!blocked||blocked.blocked)fail();
  const final=await options.authorize(tx,access,input.credentialId,[input.integrationId]);if(JSON.stringify(final)!==JSON.stringify(authority))fail();
  const clock=(await tx.query<{proof_valid_until:Date}>(`SELECT LEAST(clock_timestamp()+interval '10 seconds',r.expires_at,c.expires_at) AS proof_valid_until
    FROM flow_native_registrations r JOIN flow_delegation_credentials c ON c.organization_id=r.organization_id AND c.id=r.credential_id
    WHERE r.organization_id=$1 AND r.id=$2 AND r.revision=$3 AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()
     AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND 'flow:bind'=ANY(c.scopes)`,[access.organizationId,input.registrationId,input.registrationRevision])).rows[0];if(!clock)fail();
  return NativeReopenProofResponseSchema.parse({organizationId:access.organizationId,cutoverId:id,cutoverRevision:input.cutoverRevision,integrationId:input.integrationId,accountId:input.accountId,inboxId:input.inboxId,nonce:input.nonce,ownerRevision:owner.revision,brokerDrained:true,proofValidUntil:clock.proof_valid_until.toISOString()});
 });
}};}
