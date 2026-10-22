import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartnerTextSender } from '../../src/modules/messaging/partner-text.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createApiKeyService } from '../../src/modules/api-keys/service.js';
import { createPostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { lockAttendanceChannelRead } from '../../src/modules/attendance/repository.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
const repository = createPostgresMessagingRepository();
const phoneNumber = '+12025550123'; // Reserved fictional test number.
async function tenant() {
  const t = await seedAttendanceTenant(db.database, false);
  const provider = (await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
  await addChannel(t.org,provider,t.channel);
  const key=randomUUID();
  await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes)
    VALUES($1,$2,'Synthetic partner',$3,$4,ARRAY['messaging:read','messaging:send'])`,[key,t.org,randomUUID(),'a'.repeat(64)]);
  return {...t,provider,key};
}
async function addChannel(org:string,provider:string,existing?:string) {
  const instance=randomUUID(),channel=existing??randomUUID();
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
    VALUES($1,$2,$3,$4,$4,'CONNECTED')`,[instance,org,provider,randomUUID()]);
  if(existing)await db.database.pool.query(`UPDATE messaging_channels SET provider='BAILEYS',instance_id=$3,
    phone_number_id=NULL,waba_id=NULL WHERE organization_id=$1 AND id=$2`,[org,channel,instance]);
  else await db.database.pool.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference)
    VALUES($1,$2,$3,'BAILEYS',$4,'qr-engine')`,[channel,org,provider,instance]);
  return channel;
}
const send = (...args: Parameters<ReturnType<typeof createPartnerTextSender>>) =>
  createPartnerTextSender({repository,transact:db.transact})(...args);

beforeAll(async()=>{db=await attendanceDatabase();},60_000);
afterAll(async()=>{await db?.dispose();});

describe('partner messaging PostgreSQL admission and queue',()=>{
 it('activates the same tenant instance idempotently without a remote account binding',async()=>{
  const t=await tenant(),foreign=await tenant();
  const instance=(await db.database.pool.query('SELECT instance_id FROM messaging_channels WHERE organization_id=$1 AND id=$2',[t.org,t.channel])).rows[0]!.instance_id;
  const first=await db.transact(t.org,tx=>ensureQrChannel(tx,t.org,instance));
  const replay=await db.transact(t.org,tx=>ensureQrChannel(tx,t.org,instance));
  expect(first.id).toBe(t.channel);expect(replay.id).toBe(first.id);expect(first.instanceId).toBe(instance);
  await expect(db.transact(foreign.org,tx=>ensureQrChannel(tx,foreign.org,instance))).rejects.toMatchObject({code:'QR_INSTANCE_NOT_FOUND'});
 });
 it('bounds new partner scope delegation by current issuing key authority inside the transaction',async()=>{
  const t=await tenant();
  const service=createApiKeyService({repository:createPostgresApiKeyRepository(),hmacSecret:'synthetic-partner-delegation-hmac-key-32-bytes',runInOrganizationTransaction:db.transact,writeAudit:writeTenantAudit});
  const context={organizationId:t.org,credentialKind:'API_KEY' as const,actorId:null,apiKeyId:t.key,requestId:randomUUID()};
  const input={name:'Scoped delegation',scopes:['messaging:send'] as const,expiresAt:null};
  await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['api_keys:manage','messaging:send'] WHERE id=$1",[t.key]);
  const created=await service.issueApiKey(context,{...input,scopes:[...input.scopes]});
  expect(created.scopes).toEqual(['messaging:send']);
  await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['api_keys:manage'] WHERE id=$1",[t.key]);
  await expect(service.issueApiKey(context,{...input,name:'Forbidden delegation',scopes:[...input.scopes]})).rejects.toMatchObject({code:'PARTNER_SCOPE_DELEGATION_FORBIDDEN'});
  await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:send'] WHERE id=$1",[t.key]);
  await expect(service.issueApiKey(context,{...input,name:'Forbidden manager bypass',scopes:[...input.scopes]})).rejects.toMatchObject({code:'PARTNER_SCOPE_DELEGATION_FORBIDDEN'});
  const count=(await db.database.pool.query('SELECT count(*)::int AS count FROM api_keys WHERE organization_id=$1',[t.org])).rows[0]!.count;
  expect(count).toBe(2);
 });
 it('orders initial contact admission after the inbound channel lock without a deadlock',async()=>{
  const t=await tenant();
  let channelHeld!:()=>void,allowContact!:()=>void,partnerAttempted!:()=>void;
  const held=new Promise<void>(resolve=>{channelHeld=resolve;});
  const contactPermission=new Promise<void>(resolve=>{allowContact=resolve;});
  const attempted=new Promise<void>(resolve=>{partnerAttempted=resolve;});
  await db.transact(t.org,tx=>repository.upsertContact(tx,{id:randomUUID(),organizationId:t.org,externalId:phoneNumber.slice(1),displayName:null,consentStatus:'UNKNOWN',consentUpdatedAt:null}));
  const inbound=db.transact(t.org,async tx=>{
   await lockAttendanceChannelRead(tx,t.org,t.channel);channelHeld();
   await contactPermission;
   await repository.upsertContact(tx,{id:randomUUID(),organizationId:t.org,externalId:phoneNumber.slice(1),displayName:'Synthetic inbound',consentStatus:'UNKNOWN',consentUpdatedAt:null});
  });
  await held;
  const sender=createPartnerTextSender({repository,transact:(org,work)=>db.transact(org,tx=>work(new Proxy(tx,{get(target,key){
   if(key==='query')return (...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].endsWith('for no key update'))partnerAttempted();return Reflect.apply(target.query,target,args);};
   return Reflect.get(target,key);
  }})))});
  const partner=sender(t.org,t.channel,{phoneNumber,text:'Synthetic concurrent send'},'concurrent-inbound',t.key);
  try{await attempted;allowContact();const [,accepted]=await Promise.all([inbound,partner]);expect(accepted.state).toBe('ACCEPTED');}
  finally{allowContact();await Promise.allSettled([inbound,partner]);}
 });
 it('accepts initial text with canonical conversation, manual takeover and private outbox; replay has no additional send',async()=>{
  const t=await tenant(), input={phoneNumber,text:'Synthetic greeting'};
  const first=await send(t.org,t.channel,input,'initial-acceptance',t.key);
  const replay=await send(t.org,t.channel,input,'initial-acceptance',t.key);
  expect(replay).toEqual(first);
  const stored=(await db.database.pool.query(`SELECT m.authorizing_api_key_id,c.mode,c.bot_public_id,
    (SELECT count(*)::int FROM messaging_outbox WHERE message_id=m.id) AS queued
    FROM messaging_messages m JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
    WHERE m.id=$1`,[first.id])).rows[0]!;
  expect(stored).toMatchObject({authorizing_api_key_id:t.key,mode:'HUMAN',queued:1});
  await expect(send(t.org,t.channel,{...input,text:'Changed'},'initial-acceptance',t.key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it.each(['revoke','expire','drop-scope','delete'] as const)('blocks an accepted queued send and replay after key %s',async change=>{
  const t=await tenant(),input={phoneNumber,text:'Synthetic greeting'};
  const accepted=await send(t.org,t.channel,input,`queued-${change}`,t.key);
  const claims=await db.transact(t.org,tx=>repository.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:120_000,limit:1}));
  expect(claims).toHaveLength(1);expect(claims[0]!.message.id).toBe(accepted.id);
  const mutation=change==='revoke'?'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
    :change==='expire'?"UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
    :change==='drop-scope'?"UPDATE api_keys SET scopes=ARRAY['messaging:read'] WHERE id=$1"
    :'DELETE FROM api_keys WHERE id=$1';
  await db.database.pool.query(mutation,[t.key]);
  await expect(send(t.org,t.channel,input,`queued-${change}`,t.key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
  await expect(db.transact(t.org,tx=>repository.validateClaim(tx,{organizationId:t.org,messageId:accepted.id,leaseToken:claims[0]!.leaseToken})))
    .resolves.toEqual({eligible:false,reason:'PARTNER_CREDENTIAL_REVOKED'});
  const stored=(await db.database.pool.query('SELECT state,canonical_error_code,authorizing_api_key_id FROM messaging_messages WHERE id=$1',[accepted.id])).rows[0]!;
  expect(stored).toMatchObject({state:'FAILED',canonical_error_code:'PARTNER_CREDENTIAL_REVOKED',authorizing_api_key_id:t.key});
 });
 it('scopes the same E164 phone to separate channel conversations and tenant contacts',async()=>{
  const a=await tenant(),b=await tenant(),secondChannel=await addChannel(a.org,a.provider);
  const input={phoneNumber,text:'Synthetic greeting'};
  const [first,second,foreign]=await Promise.all([
    send(a.org,a.channel,input,'phone-scope',a.key),send(a.org,secondChannel,input,'phone-scope',a.key),send(b.org,b.channel,input,'phone-scope',b.key),
  ]);
  expect(new Set([first.conversationId,second.conversationId,foreign.conversationId]).size).toBe(3);
  const rows=(await db.database.pool.query('SELECT id,organization_id,contact_id,channel_id FROM messaging_conversations WHERE id=ANY($1::uuid[])',[[first.conversationId,second.conversationId,foreign.conversationId]])).rows;
  const contact=(id:string)=>rows.find(row=>row.id===id)!.contact_id;
  expect(contact(first.conversationId)).toBe(contact(second.conversationId));
  expect(contact(first.conversationId)).not.toBe(contact(foreign.conversationId));
  await expect(send(a.org,a.channel,{conversationId:foreign.conversationId,text:'Synthetic'},'foreign-conversation',a.key)).rejects.toMatchObject({code:'CONVERSATION_NOT_FOUND'});
  await expect(send(a.org,b.channel,input,'foreign-channel',a.key)).rejects.toMatchObject({code:'CHANNEL_NOT_FOUND'});
  await expect(send(a.org,a.channel,input,'foreign-key',b.key)).rejects.toMatchObject({code:'PARTNER_CREDENTIAL_REVOKED'});
 });
});
