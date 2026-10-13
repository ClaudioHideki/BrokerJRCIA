import {maximumAiCost,type AiNodeConfig} from '@jrc/contracts';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {OutboxRow} from './repository.js';
import {assertAiCredentialPolicy,type AiCredentialMetadata} from './ai-policy.js';
import type {AiSettlement} from './ai-effect.js';
interface BudgetOptions{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;resolveCredential(tx:TenantTransaction,org:string,id:string):Promise<AiCredentialMetadata&{secret:Record<string,unknown>}>}
export function createAiBudgetService(options:BudgetOptions){return {
 begin:(item:OutboxRow,config:AiNodeConfig)=>options.transact(item.organizationId,async tx=>{
  const org=item.organizationId;
  // The canonical outbox is already UNKNOWN. A lease is authority for this single attempt.
  const owned=(await tx.query(`select id from automation_outbox where organization_id=$1 and id=$2 and kind='IO_AI' and status='UNKNOWN' and lease_token=$3 and lease_expires_at>now() for update`,[org,item.id,item.leaseToken])).rows[0];
  if(!owned)throw Error('AUTOMATION_AI_OUTBOX_AUTHORITY_LOST');
  const existing=(await tx.query(`select outbox_id as "outboxId" from automation_ai_reservations where organization_id=$1 and outbox_id=$2`,[org,item.id])).rows[0];
  if(existing)throw Error('AUTOMATION_AI_RESERVATION_EXISTS');
  const current=await options.resolveCredential(tx,org,config.credentialId),{model,policy}=assertAiCredentialPolicy(org,config,current),maximum=maximumAiCost(config,model);
  // UTC accounting month is decided by the database; a replay cannot move reservation to a new month.
  await tx.query(`insert into automation_ai_monthly_budgets(organization_id,month) values($1,date_trunc('month',now() at time zone 'UTC')::date) on conflict do nothing`,[org]);
  const bucket=(await tx.query<{month:string;heldMicros:string;chargedMicros:string}>(`select month::text,held_micros::text as "heldMicros",charged_micros::text as "chargedMicros" from automation_ai_monthly_budgets where organization_id=$1 and month=date_trunc('month',now() at time zone 'UTC')::date for update`,[org])).rows[0];
  if(!bucket)throw Error('AUTOMATION_AI_BUDGET_UNAVAILABLE');
  if(BigInt(bucket.heldMicros)+BigInt(bucket.chargedMicros)+BigInt(maximum)>BigInt(policy.monthlyCostMicros))throw Error('AUTOMATION_AI_MONTHLY_BUDGET_EXCEEDED');
  await tx.query(`insert into automation_ai_reservations(organization_id,outbox_id,month,credential_id,credential_revision,model,input_micros_per_million,output_micros_per_million,reserved_micros,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'UNKNOWN')`,[org,item.id,bucket.month,config.credentialId,config.credentialRevision,config.model,model.inputMicrosPerMillion,model.outputMicrosPerMillion,maximum]);
  await tx.query(`update automation_ai_monthly_budgets set held_micros=held_micros+$3,updated_at=now() where organization_id=$1 and month=$2`,[org,bucket.month,maximum]);
  return {secret:current.secret,model,reservedMicros:maximum};
 }),
 async commit(tx:TenantTransaction,item:OutboxRow,result:AiSettlement){
  const org=item.organizationId;
  const owned=(await tx.query(`select id from automation_outbox where organization_id=$1 and id=$2 and status='UNKNOWN' and lease_token=$3 for update`,[org,item.id,item.leaseToken])).rows[0];if(!owned)throw Error('AUTOMATION_AI_OUTBOX_AUTHORITY_LOST');
  const reservation=(await tx.query<{month:string;reservedMicros:string;status:string}>(`select month::text,reserved_micros::text as "reservedMicros",status from automation_ai_reservations where organization_id=$1 and outbox_id=$2 for update`,[org,item.id])).rows[0];
  if(!reservation||reservation.status!=='UNKNOWN')throw Error('AUTOMATION_AI_RESERVATION_SETTLEMENT_INVALID');
  const observed=result.kind==='OBSERVED'?result.costMicros:0;
  if(!Number.isSafeInteger(observed)||observed<0||BigInt(observed)>BigInt(reservation.reservedMicros))throw Error('AUTOMATION_AI_COST_LIMIT');
  const changed=await tx.query(`update automation_ai_monthly_budgets set held_micros=held_micros-$3,charged_micros=charged_micros+$4,updated_at=now() where organization_id=$1 and month=$2 and held_micros>=$3`,[org,reservation.month,reservation.reservedMicros,observed]);if(changed.rowCount!==1)throw Error('AUTOMATION_AI_BUDGET_SETTLEMENT_INVALID');
  await tx.query(`update automation_ai_reservations set status=$3,observed_micros=$4,input_tokens=$5,output_tokens=$6,updated_at=now() where organization_id=$1 and outbox_id=$2 and status='UNKNOWN'`,[org,item.id,result.kind==='OBSERVED'?'SETTLED':'NOT_DISPATCHED',observed,result.kind==='OBSERVED'?result.inputTokens:null,result.kind==='OBSERVED'?result.outputTokens:null]);
 },
};}
