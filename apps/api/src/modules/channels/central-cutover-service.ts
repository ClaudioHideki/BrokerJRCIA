import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CreateChannelV1Schema} from '@jrc/contracts';
import type {TenantTransaction,OrganizationTransaction} from '../../db/tenant-transaction.js';
import {readChatwootAccount,type AccountRow} from '../integrations/chatwoot-context.js';
import {ChatwootClient,ChatwootError} from '../integrations/chatwoot-client.js';
import {lockOwnershipMutations,revokeRemoteFlowBinding,readOwnerRevision,transitionChannelOwner} from '../attendance/transition.js';
import {createCentralTransportChannel} from '../messaging/central-transport.js';
import {requireActiveOrganization} from '../tenancy/operational-limits.js';
import {ChannelFacadeError} from './facade.js';
import {decideCentralCutover,type CentralCutoverStep} from './central-cutover-protocol.js';
type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;client(account:AccountRow):ChatwootClient;
 vault:{encrypt(context:string,value:string):string};callback(id:string):string};
interface Row{id:string;organization_id:string;actor_id:string;origin:string;account_id:string;inbox_id:string;name:string;
 credential_version:number;destination_revision:number;idempotency_key:string;request_hash:string;webhook_fingerprint:string;
 previous_bot_id:string|null;previous_bot_fingerprint:string;bot_id:string|null;encrypted_webhook_secret:string|null;integration_id:string;channel_id:string;
 legacy_binding_id:string|null;legacy_revision:number|null;status:'PENDING'|'DISPATCHED'|'UNKNOWN'|'COMPLETE'|'ROLLED_BACK'|'CANCELED';
 step:CentralCutoverStep;revision:number;lease_token:string|null;lease_expires_at:Date|null;rollback_step:'DETACH'|'RESTORE'|'VERIFY'|null;rollback_owner_revision:number|null;}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const numeric=(v:string|null)=>v===null?null:Number(v);
const botFingerprint=(bot:{id:number;outgoing_url?:string|null|undefined}|null)=>hash(bot?{id:bot.id,callback:bot.outgoing_url??null}:null);
function fail(code:string,status:403|404|409=409):never{throw new ChannelFacadeError(code,status);}
const view=(r:Row)=>({id:r.id,channelId:r.status==='COMPLETE'?r.channel_id:null,integrationId:r.integration_id,inboxId:Number(r.inbox_id),
 status:r.status,step:r.step,revision:r.revision,reconciliationRequired:r.status==='UNKNOWN',rollbackStep:r.rollback_step});
/** A human-driven durable operation. Every step reloads authority; no remote IO holds SQL locks. */
export function createCentralCutoverService(options:Options){
 async function authorize(tx:TenantTransaction,org:string,actor:string){
  await requireActiveOrganization(tx,org);
  await lockOwnershipMutations(tx,org);
  const member=(await tx.query<{role:string}>('SELECT role FROM lock_local_attendance_member($1)',[actor])).rows[0];
  if(!member||!['OWNER','ADMIN'].includes(member.role))fail('CENTRAL_MANAGEMENT_FORBIDDEN',403);
 }
 async function context(tx:TenantTransaction,org:string,actor:string){
  await authorize(tx,org,actor);
  await tx.query('SELECT a.organization_id FROM chatwoot_accounts a JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url WHERE a.organization_id=$1 FOR SHARE OF a,d',[org]);
  const account=await readChatwootAccount(tx,org);
  if(!account||account.status!=='READY'||!account.encrypted_token||!account.account_id||account.destination?.approvalStatus!=='APPROVED'||account.base_url!==account.destination.baseUrl)fail('CENTRAL_ACCOUNT_NOT_READY');
  return account;
 }
 function assertContext(row:Row,account:AccountRow){
  if(row.origin!==account.base_url||Number(row.account_id)!==Number(account.account_id)||row.credential_version!==account.credential_version||row.destination_revision!==account.destination?.revision)fail('CENTRAL_CONTEXT_CHANGED');
 }
 async function read(tx:TenantTransaction,org:string,id:string,lock=false){
  const r=(await tx.query<Row>(`SELECT * FROM central_cutover_operations WHERE organization_id=$1 AND id=$2 ${lock?'FOR UPDATE':''}`,[org,id])).rows[0];
  return r??fail('CENTRAL_OPERATION_NOT_FOUND',404);
 }
 async function observed(account:AccountRow,inboxId:number){
  const client=options.client(account),accountId=Number(account.account_id);
  await client.centralSender(accountId);
  const inbox=await client.getInbox(accountId,inboxId);
  if(inbox.id!==inboxId||!['Channel::Api','Channel::Whatsapp'].includes(inbox.channel_type))fail('CENTRAL_INBOX_UNSUPPORTED');
  const bot=await client.inboxFlowBot(accountId,inboxId);
  return {client,inbox,bot,webhookFingerprint:hash({type:inbox.channel_type,webhook:inbox.webhook_url??null})};
 }
 async function preview(org:string,actor:string,inboxId:number){
  z.uuid().parse(org);z.uuid().parse(actor);z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(inboxId);
  const account=await options.transact(org,tx=>context(tx,org,actor)),remote=await observed(account,inboxId);
  await options.transact(org,async tx=>{const current=await context(tx,org,actor);if(hash(account)!==hash(current))fail('CENTRAL_CONTEXT_CHANGED');});
  return {expectedCredentialVersion:account.credential_version,expectedDestinationRevision:account.destination!.revision,
   expectedBotId:remote.bot?.id??null,expectedRemoteFingerprint:hash({webhook:remote.webhookFingerprint,botId:remote.bot?.id??null,callback:remote.bot?.outgoing_url??null})};
 }
 async function rollbackAdvance(org:string,actor:string,row:Row,account:AccountRow){
  const remote=await observed(account,Number(row.inbox_id));
  if(remote.webhookFingerprint!==row.webhook_fingerprint)fail('CENTRAL_REMOTE_CHANGED');
  if(row.previous_bot_id){const previous=(await remote.client.listFlowBots(Number(row.account_id))).find(bot=>bot.id===Number(row.previous_bot_id));if(!previous||botFingerprint(previous)!==row.previous_bot_fingerprint)fail('CENTRAL_REMOTE_CHANGED');}
  const current=remote.bot?.id??null,previous=numeric(row.previous_bot_id),own=numeric(row.bot_id);
  if(own!==null&&current===own&&remote.bot?.outgoing_url!==options.callback(row.integration_id))fail('CENTRAL_REMOTE_CHANGED');
  const desired=row.rollback_step==='DETACH'?null:previous;
  const before=row.rollback_step==='DETACH'?own:null;
  if(current!==desired&&current!==before)fail('CENTRAL_REMOTE_CHANGED');
  if(current!==desired&&row.status==='UNKNOWN')return view(row);
  const token=randomUUID();
  await options.transact(org,async tx=>{
   const account=await context(tx,org,actor);assertContext(row,account);await lockOwnershipMutations(tx,org);
   const saved=await read(tx,org,row.id,true);if(saved.revision!==row.revision)fail('CENTRAL_OPERATION_CHANGED');
   if(await readOwnerRevision(tx,org,row.channel_id)!==row.rollback_owner_revision)fail('CENTRAL_CONTEXT_CHANGED');
   await tx.query("UPDATE central_cutover_operations SET status='DISPATCHED',lease_token=$3,lease_expires_at=now()+interval '120 seconds',revision=revision+1 WHERE organization_id=$1 AND id=$2",[org,row.id,token]);
  });
  try{
   if(current!==desired)await remote.client.setInboxFlowBot(Number(row.account_id),Number(row.inbox_id),desired);
   const after=await observed(account,Number(row.inbox_id));
   if(after.webhookFingerprint!==row.webhook_fingerprint||(after.bot?.id??null)!==desired)throw new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true);
   if(after.bot&&desired===previous&&botFingerprint(after.bot)!==row.previous_bot_fingerprint)throw new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true);
   return await options.transact(org,async tx=>{
    const currentAccount=await context(tx,org,actor);assertContext(row,currentAccount);await lockOwnershipMutations(tx,org);const active=await read(tx,org,row.id,true);
    if(active.lease_token!==token||!active.lease_expires_at||active.lease_expires_at<=new Date()||await readOwnerRevision(tx,org,row.channel_id)!==row.rollback_owner_revision)fail('CENTRAL_OPERATION_CHANGED');
    const done=row.rollback_step==='VERIFY',next=row.rollback_step==='DETACH'?'RESTORE':'VERIFY';
    if(done&&row.legacy_binding_id){
     const restored=await tx.query(`UPDATE flow_chatwoot_bindings b SET bot_id=$4,status='READY',updated_at=now()
      WHERE b.organization_id=$1 AND b.id=$2 AND b.operation_revision=$3 AND b.operation_state='IDLE' AND b.status='DISABLED' AND b.encrypted_credentials IS NOT NULL
      AND b.credential_version=$5 AND b.destination_revision=$6 AND EXISTS(SELECT 1 FROM flow_features f WHERE f.organization_id=b.organization_id AND f.enabled AND f.revision=b.feature_revision)`,[org,row.legacy_binding_id,row.legacy_revision,previous,row.credential_version,row.destination_revision]);
     // A rotated credential must never reactivate a stale legacy executor.
     if(restored.rowCount!==1&&row.credential_version===account.credential_version){
      const legacy=(await tx.query<{status:string}>('SELECT status FROM flow_chatwoot_bindings WHERE organization_id=$1 AND id=$2',[org,row.legacy_binding_id])).rows[0];
      if(legacy?.status!=='DISABLED')fail('CENTRAL_LEGACY_CHANGED');
     }
    }
    return view((await tx.query<Row>("UPDATE central_cutover_operations SET status=$3,rollback_step=$4,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",[org,row.id,done?'ROLLED_BACK':'PENDING',next])).rows[0]!);
   });
  }catch(error){
   await options.transact(org,tx=>tx.query("UPDATE central_cutover_operations SET status='UNKNOWN',lease_token=NULL,lease_expires_at=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2 AND lease_token=$3",[org,row.id,token]));
   if(error instanceof ChatwootError)return service.get(org,row.id);throw error;
  }
 }
 const service={preview,async listInboxes(org:string,actor:string){
  const account=await options.transact(org,tx=>context(tx,org,actor)),client=options.client(account);
  await client.centralSender(Number(account.account_id));const inboxes=await client.listInboxes(Number(account.account_id));
  await options.transact(org,async tx=>{if(hash(account)!==hash(await context(tx,org,actor)))fail('CENTRAL_CONTEXT_CHANGED');});
  return {data:inboxes.filter(inbox=>['Channel::Api','Channel::Whatsapp'].includes(inbox.channel_type)).map(inbox=>({id:inbox.id,name:inbox.name,channelType:inbox.channel_type}))};
 },async get(org:string,id:string){z.uuid().parse(org);z.uuid().parse(id);return options.transact(org,async tx=>{await requireActiveOrganization(tx,org);return view(await read(tx,org,id));});},
 async prepare(org:string,actor:string,raw:unknown,key:string){
  const input=CreateChannelV1Schema.parse(raw);if(input.provider!=='CENTRAL')fail('CENTRAL_COMMAND_INVALID');
  z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(key);const requestHash=hash(input);
  const initial=await options.transact(org,async tx=>{const account=await context(tx,org,actor);const prior=(await tx.query<Row>('SELECT * FROM central_cutover_operations WHERE organization_id=$1 AND idempotency_key=$2',[org,key])).rows[0];
   if(prior&&prior.request_hash!==requestHash)fail('CENTRAL_IDEMPOTENCY_CONFLICT');return {account,prior};});
  if(initial.prior){assertContext(initial.prior,initial.account);return view(initial.prior);}
  const remote=await observed(initial.account,input.inboxId);
  if(initial.account.credential_version!==input.expectedCredentialVersion||initial.account.destination!.revision!==input.expectedDestinationRevision||
   input.expectedBotId!==(remote.bot?.id??null)||input.expectedRemoteFingerprint!==hash({webhook:remote.webhookFingerprint,botId:remote.bot?.id??null,callback:remote.bot?.outgoing_url??null}))fail('CENTRAL_PREVIEW_CHANGED');
  if(remote.bot&&!input.replaceExistingBot)fail('CENTRAL_REPLACEMENT_REQUIRED');
  try{return await options.transact(org,async tx=>{
   const account=await context(tx,org,actor);if(hash(initial.account)!==hash(account))fail('CENTRAL_CONTEXT_CHANGED');
   await lockOwnershipMutations(tx,org);
   await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('central-cutover:'||$1||':'||$2||':'||$3,0))",[account.base_url,account.account_id,input.inboxId]);
   const prior=(await tx.query<Row>('SELECT * FROM central_cutover_operations WHERE organization_id=$1 AND idempotency_key=$2',[org,key])).rows[0];
   if(prior){if(prior.request_hash!==requestHash)fail('CENTRAL_IDEMPOTENCY_CONFLICT');return view(prior);}
   // The physical UNIQUE inbox binding retains history even while paused.
   if((await tx.query(`SELECT 1 FROM chatwoot_connections c WHERE c.organization_id=$1 AND c.inbox_id=$2
    AND (c.status<>'DISABLED' OR NOT EXISTS(SELECT 1 FROM central_transport_bindings b WHERE b.organization_id=c.organization_id AND b.integration_id=c.id))`,[org,input.inboxId])).rowCount)fail('CENTRAL_INBOX_ALREADY_CONNECTED');
   const legacy=(await tx.query<{id:string;bot_id:string|null;operation_revision:number;operation_state:string}>('SELECT id,bot_id,operation_revision,operation_state FROM flow_chatwoot_bindings WHERE organization_id=$1 AND inbox_id=$2 AND (status<>\'DISABLED\' OR bot_id IS NOT NULL OR operation_state<>\'IDLE\') FOR UPDATE',[org,input.inboxId])).rows;
   if(legacy.length>1)fail('CENTRAL_LEGACY_AMBIGUOUS');const old=legacy[0];
   if(old){
    if(old.operation_state!=='IDLE'||numeric(old.bot_id)!==(remote.bot?.id??null)||(await tx.query("SELECT 1 FROM flow_chatwoot_outbox WHERE organization_id=$1 AND binding_id=$2 AND status IN ('SENDING','UNKNOWN') LIMIT 1",[org,old.id])).rowCount)fail('CENTRAL_LEGACY_RECONCILIATION_REQUIRED');
    if(!input.replaceExistingBot)fail('CENTRAL_REPLACEMENT_REQUIRED');
   }
   const reusable=(await tx.query<{channel_id:string;integration_id:string}>(`SELECT b.channel_id,b.integration_id FROM central_transport_bindings b
    JOIN chatwoot_connections c ON c.organization_id=b.organization_id AND c.id=b.integration_id
    JOIN messaging_channels m ON m.organization_id=b.organization_id AND m.id=b.channel_id
    LEFT JOIN attendance_owners own ON own.organization_id=b.organization_id AND own.channel_id=b.channel_id
    WHERE b.organization_id=$1 AND b.origin=$2 AND b.account_id=$3 AND b.inbox_id=$4
    AND b.status='DISABLED' AND c.status='DISABLED' AND m.deleting_at IS NULL AND coalesce(own.executor,'NONE')='NONE' FOR UPDATE OF b,c,m`,[org,account.base_url,account.account_id,input.inboxId])).rows[0];
   const id=randomUUID(),integration=reusable?.integration_id??randomUUID(),channel=reusable?.channel_id??randomUUID();
   const operation=(await tx.query<Row>(`INSERT INTO central_cutover_operations(organization_id,id,actor_id,origin,account_id,inbox_id,name,credential_version,destination_revision,
    idempotency_key,request_hash,webhook_fingerprint,previous_bot_id,integration_id,channel_id,legacy_binding_id,legacy_revision,previous_bot_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,[org,id,actor,account.base_url,account.account_id,input.inboxId,input.name,account.credential_version,account.destination!.revision,key,requestHash,remote.webhookFingerprint,remote.bot?.id??null,integration,channel,old?.id??null,old?.operation_revision??null,botFingerprint(remote.bot)])).rows[0]!;
   if(old){const revoked=await revokeRemoteFlowBinding(tx,org,old.id);await tx.query('UPDATE central_cutover_operations SET legacy_revision=$3 WHERE organization_id=$1 AND id=$2',[org,id,revoked.operation_revision]);}
   return view(operation);
  });}catch(error){if((error as {code?:string}).code==='23505')fail('CENTRAL_INBOX_CLAIMED');throw error;}
 },async advance(org:string,actor:string,id:string,expectedRevision:number){
  const snapshot=await options.transact(org,async tx=>{
   const account=await context(tx,org,actor);await lockOwnershipMutations(tx,org);let row=await read(tx,org,id,true);assertContext(row,account);
   if(row.revision!==expectedRevision)fail('CENTRAL_OPERATION_CHANGED');
   if(row.status==='DISPATCHED'){
    if(row.lease_expires_at&&row.lease_expires_at>new Date())fail('CENTRAL_OPERATION_IN_PROGRESS');
    row=(await tx.query<Row>("UPDATE central_cutover_operations SET status='UNKNOWN',lease_token=NULL,lease_expires_at=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING *",[org,id])).rows[0]!;
   }
   return {account,row};
  });
  const {row,account}=snapshot;if(['COMPLETE','ROLLED_BACK','CANCELED'].includes(row.status))return view(row);
  if(row.rollback_step)return rollbackAdvance(org,actor,row,account);
  const remote=await observed(account,Number(row.inbox_id)),bots=await remote.client.listFlowBots(Number(row.account_id));
  if(row.step==='DETACH'&&remote.bot&&botFingerprint(remote.bot)!==row.previous_bot_fingerprint)fail('CENTRAL_REMOTE_CHANGED');
  const decision=decideCentralCutover({step:row.step,state:row.status==='UNKNOWN'?'UNKNOWN':'PENDING',previousBotId:numeric(row.previous_bot_id),botId:numeric(row.bot_id),callback:options.callback(row.integration_id),webhookFingerprint:row.webhook_fingerprint},
   {botId:remote.bot?.id??null,webhookFingerprint:remote.webhookFingerprint,bots});
  if(decision.action==='WAIT')return view(row);
  const token=randomUUID();
  const claimed=await options.transact(org,async tx=>{
   const current=await context(tx,org,actor);assertContext(row,current);await lockOwnershipMutations(tx,org);const saved=await read(tx,org,id,true);
   if(saved.revision!==row.revision||saved.status!==row.status)fail('CENTRAL_OPERATION_CHANGED');
   if(row.legacy_binding_id){const legacy=(await tx.query<{operation_revision:number;status:string}>('SELECT operation_revision,status FROM flow_chatwoot_bindings WHERE organization_id=$1 AND id=$2 FOR SHARE',[org,row.legacy_binding_id])).rows[0];
    if(!legacy||legacy.status!=='DISABLED'||legacy.operation_revision!==row.legacy_revision)fail('CENTRAL_LEGACY_CHANGED');}
   return (await tx.query<Row>("UPDATE central_cutover_operations SET status='DISPATCHED',lease_token=$3,lease_expires_at=now()+interval '120 seconds',revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING *",[org,id,token])).rows[0]!;
  });
  let created:Awaited<ReturnType<ChatwootClient['createFlowBot']>>|undefined;
  try{
   if(decision.action==='DETACH')await remote.client.setInboxFlowBot(Number(row.account_id),Number(row.inbox_id),null);
   if(decision.action==='CREATE')created=await remote.client.createFlowBot(Number(row.account_id),row.name,options.callback(row.integration_id));
   if(decision.action==='ATTACH')await remote.client.setInboxFlowBot(Number(row.account_id),Number(row.inbox_id),Number(row.bot_id));
   // Mutation ACK alone is insufficient. Exact GET determines the next persisted stage.
   const after=await observed(account,Number(row.inbox_id)),afterBots=await remote.client.listFlowBots(Number(row.account_id));
   const final=decideCentralCutover({step:row.step,state:'UNKNOWN',previousBotId:numeric(row.previous_bot_id),botId:created?.id??numeric(row.bot_id),callback:options.callback(row.integration_id),webhookFingerprint:row.webhook_fingerprint},
    {botId:after.bot?.id??null,webhookFingerprint:after.webhookFingerprint,bots:afterBots});
   if(final.action==='WAIT')throw new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true);
   return await options.transact(org,async tx=>{
    const current=await context(tx,org,actor);assertContext(row,current);await lockOwnershipMutations(tx,org);const active=await read(tx,org,id,true);
    if(active.lease_token!==token||active.revision!==claimed.revision||!active.lease_expires_at||active.lease_expires_at<=new Date())fail('CENTRAL_OPERATION_CHANGED');
    const botId=final.action==='ADOPT'?final.botId:created?.id??numeric(row.bot_id),secret=final.action==='ADOPT'?final.secret:created?.secret;
    const encrypted=secret?options.vault.encrypt(`${org}:chatwoot-webhook:${row.integration_id}`,secret):active.encrypted_webhook_secret;
    if(final.action==='READY'){
     if(!botId||!encrypted)fail('CENTRAL_BOT_UNVERIFIED');
     if(row.legacy_binding_id){const cleared=await tx.query("UPDATE flow_chatwoot_bindings SET bot_id=NULL WHERE organization_id=$1 AND id=$2 AND status='DISABLED' AND operation_state='IDLE' AND operation_revision=$3",[org,row.legacy_binding_id,row.legacy_revision]);if(cleared.rowCount!==1)fail('CENTRAL_LEGACY_CHANGED');}
     const existing=(await tx.query('SELECT 1 FROM central_transport_bindings WHERE organization_id=$1 AND channel_id=$2',[org,row.channel_id])).rowCount;
     if(existing){
      const owner=(await tx.query<{executor:string;revision:number}>('SELECT executor,revision FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE',[org,row.channel_id])).rows[0];
      if(owner&&owner.executor!=='NONE')fail('CENTRAL_CONTEXT_CHANGED');
      const restored=await tx.query("UPDATE chatwoot_connections SET status='READY',name=$3,encrypted_webhook_secret=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='DISABLED'",[org,row.integration_id,row.name,encrypted]);
      if(restored.rowCount!==1)fail('CENTRAL_CONTEXT_CHANGED');
      await tx.query("UPDATE central_transport_bindings SET status='READY',credential_version=$3,destination_revision=$4,owner_revision=$5,callback_verified_at=NULL,callback_credential_version=NULL,callback_destination_revision=NULL,updated_at=now() WHERE organization_id=$1 AND channel_id=$2 AND status='DISABLED'",[org,row.channel_id,row.credential_version,row.destination_revision,owner?.revision??0]);
     }else await createCentralTransportChannel(tx,{organizationId:org,channelId:row.channel_id,integrationId:row.integration_id,origin:row.origin,accountId:Number(row.account_id),inboxId:Number(row.inbox_id),credentialVersion:row.credential_version,destinationRevision:row.destination_revision,ownerRevision:0,name:row.name,encryptedWebhookSecret:encrypted});
     await tx.query('UPDATE central_transport_bindings SET bot_id=$3,bot_callback=$4,capabilities_observed_at=now() WHERE organization_id=$1 AND channel_id=$2',[org,row.channel_id,botId,options.callback(row.integration_id)]);
    }
    return view((await tx.query<Row>(`UPDATE central_cutover_operations SET status=$3,step=$4,bot_id=$5,encrypted_webhook_secret=$6,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
     [org,id,final.action==='READY'?'COMPLETE':'PENDING','next' in final?final.next:row.step,botId,encrypted])).rows[0]!);
   });
  }catch(error){
   // Including failed post-IO authority checks: retain uncertainty without settling through stale credentials.
   await options.transact(org,tx=>tx.query("UPDATE central_cutover_operations SET status='UNKNOWN',lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3",[org,id,token]));
   if(error instanceof ChatwootError)return service.get(org,id);
   throw error;
  }
 },async rollback(org:string,actor:string,id:string,expectedRevision:number){
  const check=await options.transact(org,async tx=>({account:await context(tx,org,actor),row:await read(tx,org,id)}));
  // Explicit recovery may use a rotated credential, never another remote identity.
  if(check.row.origin!==check.account.base_url||Number(check.row.account_id)!==Number(check.account.account_id))fail('CENTRAL_CONTEXT_CHANGED');
  if(check.row.status==='ROLLED_BACK')return view(check.row);
  if(check.row.revision!==expectedRevision||check.row.status==='CANCELED'||check.row.status==='DISPATCHED'&&check.row.lease_expires_at!>new Date())fail('CENTRAL_RECONCILE_BEFORE_ROLLBACK');
  if(check.row.rollback_step){
   // An interrupted reversal has the same explicit recovery path. Renew pins
   // only for the same identity; UNKNOWN remains UNKNOWN until GET proves it.
   const remote=await observed(check.account,Number(check.row.inbox_id));
   if(remote.webhookFingerprint!==check.row.webhook_fingerprint)fail('CENTRAL_REMOTE_CHANGED');
   if(check.row.previous_bot_id){const previous=(await remote.client.listFlowBots(Number(check.row.account_id))).find(bot=>bot.id===Number(check.row.previous_bot_id));if(!previous||botFingerprint(previous)!==check.row.previous_bot_fingerprint)fail('CENTRAL_REMOTE_CHANGED');}
   const renewed=await options.transact(org,async tx=>{
    const account=await context(tx,org,actor);if(hash(account)!==hash(check.account))fail('CENTRAL_CONTEXT_CHANGED');const row=await read(tx,org,id,true);
    if(row.revision!==expectedRevision||await readOwnerRevision(tx,org,row.channel_id)!==row.rollback_owner_revision)fail('CENTRAL_OPERATION_CHANGED');
    return view((await tx.query<Row>("UPDATE central_cutover_operations SET credential_version=$3,destination_revision=$4,status=CASE WHEN status='DISPATCHED' THEN 'UNKNOWN' ELSE status END,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",[org,id,account.credential_version,account.destination!.revision])).rows[0]!);
   });
   let operation=await service.advance(org,actor,id,renewed.revision);
   for(let i=0;i<2&&operation.status==='PENDING';i++)operation=await service.advance(org,actor,id,operation.revision);
   return operation;
  }
  const remote=await observed(check.account,Number(check.row.inbox_id));
  const observedBot=remote.bot?.id??null;
  if(remote.webhookFingerprint!==check.row.webhook_fingerprint||![null,numeric(check.row.bot_id),numeric(check.row.previous_bot_id)].includes(observedBot))fail('CENTRAL_REMOTE_CHANGED');
  if(['UNKNOWN','DISPATCHED'].includes(check.row.status)&&((check.row.step==='DETACH'&&observedBot!==null)||(check.row.step==='ATTACH'&&observedBot!==numeric(check.row.bot_id))))fail('CENTRAL_RECONCILE_BEFORE_ROLLBACK');
  if(check.row.bot_id!==null&&observedBot===numeric(check.row.bot_id)&&remote.bot?.outgoing_url!==options.callback(check.row.integration_id))fail('CENTRAL_REMOTE_CHANGED');
  if(check.row.previous_bot_id){const previous=(await remote.client.listFlowBots(Number(check.row.account_id))).find(bot=>bot.id===Number(check.row.previous_bot_id));if(!previous||botFingerprint(previous)!==check.row.previous_bot_fingerprint)fail('CENTRAL_REMOTE_CHANGED');}
  let operation=await options.transact(org,async tx=>{
   const account=await context(tx,org,actor);await lockOwnershipMutations(tx,org);const row=await read(tx,org,id,true);
   if(hash(account)!==hash(check.account))fail('CENTRAL_CONTEXT_CHANGED');
   if(row.revision!==expectedRevision)fail('CENTRAL_OPERATION_CHANGED');
   if(row.status==='ROLLED_BACK')return view(row);
   if(row.rollback_step||row.status==='DISPATCHED'&&row.lease_expires_at!>new Date()||row.status==='CANCELED')fail('CENTRAL_RECONCILE_BEFORE_ROLLBACK');
   const unknown=(await tx.query("SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND channel_id=$2 AND direction='OUTGOING' AND state IN ('SENDING','UNKNOWN') LIMIT 1",[org,row.channel_id])).rowCount;
   if(unknown)fail('CENTRAL_LEGACY_RECONCILIATION_REQUIRED');
   const exists=(await tx.query('SELECT 1 FROM messaging_channels WHERE organization_id=$1 AND id=$2',[org,row.channel_id])).rowCount;
   const owner=exists?await transitionChannelOwner(tx,org,{channelId:row.channel_id,botPublicId:null,botOriginReference:null}):{ownerRevision:0};
   await tx.query("UPDATE central_transport_bindings SET status='DISABLED',updated_at=now() WHERE organization_id=$1 AND channel_id=$2",[org,row.channel_id]);
   await tx.query("UPDATE chatwoot_connections SET status='DISABLED',updated_at=now() WHERE organization_id=$1 AND id=$2",[org,row.integration_id]);
   return view((await tx.query<Row>("UPDATE central_cutover_operations SET status='PENDING',rollback_step=$4,rollback_owner_revision=$3,credential_version=$5,destination_revision=$6,lease_token=NULL,lease_expires_at=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING *",[org,id,owner.ownerRevision,observedBot===numeric(row.previous_bot_id)?'VERIFY':observedBot===null?'RESTORE':'DETACH',account.credential_version,account.destination!.revision])).rows[0]!);
  });
  for(let i=0;i<3&&operation.status==='PENDING';i++)operation=await service.advance(org,actor,id,operation.revision);
  return operation;
 },async cancel(org:string,actor:string,id:string,revision:number){return options.transact(org,async tx=>{
  await authorize(tx,org,actor);const row=await read(tx,org,id,true);
  if(row.status==='CANCELED')return view(row);
  if(row.revision!==revision||row.revision!==1||row.status!=='PENDING'||row.step!=='DETACH'||row.rollback_step)fail('CENTRAL_RECONCILE_BEFORE_ROLLBACK');
  return view((await tx.query<Row>("UPDATE central_cutover_operations SET status='CANCELED',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",[org,id])).rows[0]!);
 });},async byKey(org:string,key:string){z.uuid().parse(org);z.string().min(1).max(128).parse(key);return options.transact(org,async tx=>{await requireActiveOrganization(tx,org);const row=(await tx.query<Row>('SELECT * FROM central_cutover_operations WHERE organization_id=$1 AND idempotency_key=$2',[org,key])).rows[0];return view(row??fail('CENTRAL_OPERATION_NOT_FOUND',404));});},async operationForChannel(org:string,channel:string){z.uuid().parse(org);z.uuid().parse(channel);return options.transact(org,async tx=>{await requireActiveOrganization(tx,org);const row=(await tx.query<Row>('SELECT * FROM central_cutover_operations WHERE organization_id=$1 AND channel_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[org,channel])).rows[0];return view(row??fail('CENTRAL_OPERATION_NOT_FOUND',404));});}};
 return service;
}
