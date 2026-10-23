import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createChatwootControlAuth} from '../../src/modules/integrations/chatwoot-control-auth.js';
import {createChatwootCampaignService} from '../../src/modules/integrations/chatwoot-campaign-service.js';
import type {ChatwootControlOptions} from '../../src/modules/integrations/chatwoot-control-service.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {recordChatwootAttendanceEvent,initializeChatwootAttendanceMap} from '../../src/modules/integrations/chatwoot-attendance-store.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const encryptionKey=Buffer.alloc(32,7).toString('base64'),vault=createIntegrationSecrets(encryptionKey);
beforeAll(async()=>{db=await attendanceDatabase();},60_000);
afterAll(async()=>{await db?.dispose();});
async function fixture(kind:'text'|'image'|'document'|'video'|'audio'='text'){
 const t=await seedAttendanceTenant(db.database,false),key=randomUUID(),instance=randomUUID(),origin=`https://${t.org}.example.test`;
 await db.database.pool.query("UPDATE messaging_contacts SET external_id='12025550123' WHERE organization_id=$1",[t.org]);
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
 await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,$4,$4,'CONNECTED')`,[instance,t.org,provider,randomUUID()]);
 await db.database.pool.query(`UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1`,[t.channel,instance]);
 await db.database.pool.query(`INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,7,$3,'READY')`,[t.org,origin,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic-token')]);
 await db.database.pool.query(`INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,9,'Synthetic','READY')`,[t.integration,t.org,t.channel]);
 await db.database.pool.query(`INSERT INTO chatwoot_destinations(organization_id,base_url,mode,revision,approval_status) VALUES($1,$2,'MANAGED',1,'APPROVED') ON CONFLICT(organization_id) DO UPDATE SET approval_status='APPROVED'`,[t.org,origin]);
 await db.database.pool.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,identity_enforced,approved_fingerprint,observed_fingerprint,observed_connected,observed_at,identity_revision,observed_last4,callback_verified_at,callback_destination_revision,callback_credential_version)
  VALUES($1,$2,$3,true,$4,$4,true,now(),1,'0100',now(),1,1)`,[t.org,t.integration,t.channel,'a'.repeat(64)]);
 await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'Synthetic campaign',$3,$4,ARRAY['chatwoot:read','chatwoot:manage'])`,[key,t.org,randomUUID(),'b'.repeat(64)]);
 await db.database.pool.query(`INSERT INTO chatwoot_control_bindings(api_key_id,organization_id,account_id,destination_revision) VALUES($1,$2,7,1)`,[key,t.org]);
 // Mapping exists, so the campaign never changes attendance ownership or conversation mode.
 await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,12,'synthetic-source',21)`,[t.org,t.integration,t.conversation]);
 let intentId:string|undefined,policy=true,canonicalText='Synthetic campaign',attachmentId=71,recipientPhone='+12025550123',recipientSource='synthetic-source',recipientContactId=12;
 let canonicalRoute:unknown=undefined,contactLinks:{source_id:string;inbox:{id:number}}[]|undefined,canonicalConversationId=21;
 const conversation=()=>({id:canonicalConversationId,account_id:7,inbox_id:9,meta:{sender:{id:recipientContactId,phone_number:recipientPhone}},
  ...(canonicalRoute===undefined?{}:{contact_inbox:canonicalRoute})});
 const canonical=()=>({id:25,account_id:7,inbox_id:9,conversation_id:21,message_type:'outgoing',private:false,created_at:1700000000,content:canonicalText,sender:{id:17,type:'user'},attachments:kind==='text'?[]:[{id:attachmentId,file_type:kind==='document'?'file':kind}],
  additional_attributes:{jrc_campaign_broker:true,campaign_id:'campaign:12',...(intentId?{jrc_campaign_intent_id:intentId}:{})}});
 const auth=createChatwootControlAuth({enabled:true,hmacSecret:'synthetic-campaign-test-hmac-secret-32',managedOrigin:origin,transact:db.transact,resolveCurrentRole:async()=>null});
 const options={baseUrl:origin,publicOrigin:'https://broker.example.com',encryptionKey,transact:db.transact,resolveIntegration:async()=>t.org,auth,
  fetch:async(url:unknown)=>String(url).endsWith('/conversations/21')?Response.json(conversation()):String(url).includes('/contacts/')?Response.json({payload:{id:recipientContactId,phone_number:recipientPhone,contact_inboxes:contactLinks??[{source_id:recipientSource,inbox:{id:9}}]}}):String(url).includes('/messages?')?Response.json({payload:[canonical()]}):String(url).endsWith('/inboxes/9')?Response.json({id:9,name:'Synthetic',channel_type:'Channel::Api',greeting_enabled:!policy,enable_auto_assignment:false}):Promise.reject(new Error('UNEXPECTED_CANONICAL_REQUEST'))} as unknown as ChatwootControlOptions;
 const service=createChatwootCampaignService(options),worker=createChatwootWorker(options);
 const p=await auth.authorize({kind:'API_KEY',organizationId:t.org,apiKeyId:key,actorId:null,scopes:['chatwoot:read','chatwoot:manage']},'chatwoot:manage',t.integration,'17');
 const input={conversationId:21,messageId:25,campaignId:'campaign:12',kind,text:'Synthetic campaign',destinationRevision:1,identityRevision:1,ownerRevision:0};
 async function reserve(){const r=await service.reserveCampaignIntent(p,t.integration,input,'campaign-delivery-12');intentId=r.intentId;return r;}
 async function callback(){await db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,{organizationId:t.org,integrationId:t.integration,channelId:t.channel,destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9},
  {event:'message_created',...canonical(),account:{id:7},inbox:{id:9},conversation:{id:21,inbox_id:9}}));}
 return {...t,key,instance,p,input,service,worker,reserve,callback,setPolicy:(v:boolean)=>{policy=v;},setCanonicalText:(v:string)=>{canonicalText=v;},setAttachmentId:(v:number)=>{attachmentId=v;},
  setCanonicalRoute:(value:unknown)=>{canonicalRoute=value;},setContactLinks:(value:{source_id:string;inbox:{id:number}}[])=>{contactLinks=value;},setCanonicalConversationId:(value:number)=>{canonicalConversationId=value;},
  setRecipient:()=>{recipientPhone='+12025550124';recipientSource='changed-source';recipientContactId=13;}};
}
const canonicalRoute=(patch:Record<string,unknown>={})=>({id:81,contact_id:12,inbox_id:9,source_id:'synthetic-source',...patch});
const contactLink=(source_id:string,inboxId=9)=>({source_id,inbox:{id:inboxId}});
it.each(['text','image'] as const)('selects the exact canonical conversation route for a %s campaign among three same-inbox links',async kind=>{
 const t=await fixture(kind);t.setCanonicalRoute(canonicalRoute());
 t.setContactLinks([contactLink(`jrc-${randomUUID()}`),contactLink('synthetic-source'),contactLink(randomUUID())]);
 const reserved=await t.reserve();expect(await t.reserve()).toMatchObject({intentId:reserved.intentId,replayed:true});await t.callback();await t.worker.runOnce(t.org);
 const intents=(await db.database.pool.query('SELECT recipient_source_id,recipient_phone FROM chatwoot_campaign_intents WHERE organization_id=$1',[t.org])).rows;
 expect(intents).toEqual([{recipient_source_id:'synthetic-source',recipient_phone:'+12025550123'}]);
 const rows=(await db.database.pool.query('SELECT campaign_intent_id,content FROM messaging_messages WHERE organization_id=$1',[t.org])).rows;
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({campaign_intent_id:reserved.intentId,content:kind==='text'?{type:'TEXT',text:'Synthetic campaign'}:{type:'MEDIA',kind:'image',caption:'Synthetic campaign'}});
});
it('preserves legacy single-link hosts but refuses multiple links without a canonical route',async()=>{
 const legacy=await fixture();expect(await legacy.reserve()).toMatchObject({state:'RESERVED'});
 const ambiguous=await fixture();ambiguous.setContactLinks([contactLink('synthetic-source'),contactLink(randomUUID())]);
 await expect(ambiguous.reserve()).rejects.toMatchObject({code:'CAMPAIGN_RECIPIENT_NOT_PROVEN'});
 expect((await db.database.pool.query('SELECT id FROM chatwoot_campaign_intents WHERE organization_id=$1',[ambiguous.org])).rowCount).toBe(0);
});
it.each([{inbox_id:10},{contact_id:13},{source_id:'foreign-source'},null] as const)('rejects canonical route parent/source mismatch without falling back to its single link: %j',async patch=>{
 const t=await fixture();t.setCanonicalRoute(patch===null?null:canonicalRoute(patch));
 await expect(t.reserve()).rejects.toMatchObject({code:'CAMPAIGN_RECIPIENT_NOT_PROVEN'});
 expect((await db.database.pool.query('SELECT id FROM chatwoot_campaign_intents WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
});
it('does not depend on contact-link order when unrelated links appear after reservation',async()=>{
 const t=await fixture('image');t.setCanonicalRoute(canonicalRoute());await t.reserve();
 t.setContactLinks([contactLink(randomUUID()),contactLink('synthetic-source'),contactLink(`jrc-${randomUUID()}`)]);
 await t.callback();await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(1);
 expect(await t.service.campaignReceipt(t.p,t.integration,21,25)).toMatchObject({status:'queued'});
});
it.each(['source','inbox','contact','conversation','duplicate-source','missing-multiple'] as const)('rejects changed %s route evidence between reservation and worker dispatch',async change=>{
 const t=await fixture();t.setCanonicalRoute(canonicalRoute());await t.reserve();
 if(change==='source'){t.setCanonicalRoute(canonicalRoute({source_id:'changed-source'}));t.setContactLinks([contactLink('synthetic-source'),contactLink('changed-source')]);}
 if(change==='inbox')t.setCanonicalRoute(canonicalRoute({inbox_id:10}));
 if(change==='contact')t.setCanonicalRoute(canonicalRoute({contact_id:13}));
 if(change==='conversation')t.setCanonicalConversationId(22);
 if(change==='duplicate-source')t.setContactLinks([contactLink('synthetic-source'),contactLink('synthetic-source')]);
 if(change==='missing-multiple'){t.setCanonicalRoute(undefined);t.setContactLinks([contactLink('synthetic-source'),contactLink(randomUUID())]);}
 await t.callback();await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 expect(await t.service.campaignReceipt(t.p,t.integration,21,25)).toMatchObject({status:'failed',errorCode:'CAMPAIGN_RECIPIENT_CHANGED'});
});
it('has a complete forced-RLS campaign schema under the actual app role',async()=>{
 await db.transact(randomUUID(),async tx=>{expect(await probeRequiredRuntimeSchema(sql=>tx.query(sql))).toBe(true);});
});
it('reports technical readiness without historical traffic and explicit remote policy failure',async()=>{
 const t=await fixture();expect(await t.service.campaignTransport(t.p,t.integration)).toMatchObject({ready:true,ownerRevision:0,identityRevision:1});
 t.setPolicy(false);expect(await t.service.campaignTransport(t.p,t.integration)).toMatchObject({ready:false,reason:'CAMPAIGN_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION'});
 await expect(t.reserve()).rejects.toMatchObject({code:'CAMPAIGN_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION'});
});
it('reserves exact canonical message once, forwards through the existing queue without takeover, and exposes its receipt',async()=>{
 const t=await fixture(),first=await t.reserve(),replay=await t.reserve();
 expect(first.replayed).toBe(false);expect(replay).toMatchObject({intentId:first.intentId,replayed:true});
 await t.callback();await t.worker.runOnce(t.org);await t.callback();await t.worker.runOnce(t.org);
 const messages=(await db.database.pool.query('SELECT id,campaign_intent_id,state FROM messaging_messages WHERE organization_id=$1',[t.org])).rows;
 expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({campaign_intent_id:first.intentId,state:'ACCEPTED'});
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0]!.mode).toBe('BOT');
 expect((await db.database.pool.query('SELECT * FROM attendance_owners WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 expect(await t.service.campaignReceipt(t.p,t.integration,21,25)).toMatchObject({status:'queued'});
 const repo=createPostgresMessagingRepository(),claims=await db.transact(t.org,tx=>repo.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:120000,limit:1}));
 expect(claims).toHaveLength(1);
 await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[t.key]);
 expect(await db.transact(t.org,tx=>repo.validateClaim(tx,{organizationId:t.org,messageId:messages[0]!.id,leaseToken:claims[0]!.leaseToken}))).toEqual({eligible:false,reason:'CAMPAIGN_AUTHORITY_REVOKED'});
});
it.each(['key','scope','binding','identity','destination','owner','expiry'] as const)('rejects changed %s authority before canonical callback can enqueue',async change=>{
 const t=await fixture();await t.reserve();
 const query=change==='key'?'UPDATE api_keys SET revoked_at=now() WHERE organization_id=$1':change==='scope'?"UPDATE api_keys SET scopes=ARRAY['chatwoot:read'] WHERE organization_id=$1":change==='binding'?'UPDATE chatwoot_control_bindings SET active=false WHERE organization_id=$1':change==='identity'?'UPDATE chatwoot_connection_health SET identity_revision=2 WHERE organization_id=$1':change==='destination'?'UPDATE chatwoot_destinations SET revision=2 WHERE organization_id=$1':change==='owner'?"INSERT INTO attendance_owners(organization_id,channel_id,revision) VALUES($1,$2,1)":"UPDATE chatwoot_campaign_intents SET expires_at=now()-interval '1 second' WHERE organization_id=$1";
 await db.database.pool.query(query,change==='owner'?[t.org,t.channel]:[t.org]);
 if(change==='destination')await expect(t.callback()).rejects.toMatchObject({code:'CHATWOOT_CONTEXT_CHANGED'});else await t.callback();
 await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 await expect(t.reserve()).rejects.toBeDefined();
});
it('rejects an edited canonical message and never trusts a forged callback intent alone',async()=>{
 const t=await fixture();await t.reserve();await t.callback();t.setCanonicalText('Edited after reservation');await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT status,last_error FROM integration_jobs WHERE organization_id=$1',[t.org])).rows[0]).toMatchObject({status:'FAILED',last_error:'CAMPAIGN_MESSAGE_NOT_PROVEN'});
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 expect(await t.service.campaignReceipt(t.p,t.integration,21,25)).toMatchObject({status:'failed',errorCode:'CAMPAIGN_MESSAGE_NOT_PROVEN'});
});
it.each(['image','document','video','audio'] as const)('uses the same private media queue for an authenticated %s campaign',async kind=>{
 const t=await fixture(kind),r=await t.reserve();await t.callback();await t.worker.runOnce(t.org);
 const rows=(await db.database.pool.query('SELECT content,campaign_intent_id FROM messaging_messages WHERE organization_id=$1',[t.org])).rows;
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({campaign_intent_id:r.intentId,content:{type:'MEDIA',kind,caption:'Synthetic campaign'}});
});
it('blocks changed canonical attachment even when callback and new canonical GET agree',async()=>{
 const t=await fixture('image');await t.reserve();t.setAttachmentId(72);await t.callback();await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 expect(await t.service.campaignReceipt(t.p,t.integration,21,25)).toMatchObject({status:'failed',errorCode:'CAMPAIGN_MESSAGE_NOT_PROVEN'});
});
it('rejects reassociated canonical recipient after reservation and leaves the old physical phone untouched',async()=>{
 const t=await fixture();await t.reserve();t.setRecipient();await t.callback();await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 expect(await t.service.campaignReceipt(t.p,t.integration,21,25)).toMatchObject({status:'failed',errorCode:'CAMPAIGN_RECIPIENT_CHANGED'});
 await expect(t.reserve()).rejects.toMatchObject({code:'CAMPAIGN_RECIPIENT_CHANGED'});
});
it('rejects a stale physical map when a new campaign reserves the reassociated remote recipient',async()=>{
 const t=await fixture();t.setRecipient();await t.reserve();await t.callback();await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(0);
 expect(await t.service.campaignReceipt(t.p,t.integration,21,25)).toMatchObject({status:'failed',errorCode:'CAMPAIGN_RECIPIENT_CHANGED'});
});
it('creates an unmapped canonical conversation through the same queue without activating or pausing a bot',async()=>{
 const t=await fixture();await db.database.pool.query('DELETE FROM chatwoot_conversations WHERE organization_id=$1',[t.org]);
 await t.reserve();await t.callback();await t.worker.runOnce(t.org);
 expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[t.org])).rowCount).toBe(1);
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0]!.mode).toBe('BOT');
 await db.database.pool.query("UPDATE chatwoot_campaign_intents SET expires_at=now()-interval '1 second' WHERE organization_id=$1",[t.org]);
 await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,{...t.scope,credentialRevision:1},
  {conversationId:t.conversation,remoteConversationId:21,canonical:{id:21,account_id:7,inbox_id:9,status:'pending',updated_at:10,meta:{assignee:null,team:null}}}));
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0]!.mode).toBe('BOT');
});
it.each(['disconnect','stale','access-error'] as const)('never certifies stale ready evidence after %s',async change=>{
 const t=await fixture();
 await db.database.pool.query(change==='disconnect'?"UPDATE instances SET status='DISCONNECTED' WHERE organization_id=$1":change==='stale'?"UPDATE chatwoot_connection_health SET observed_at=now()-interval '91 seconds' WHERE organization_id=$1":"UPDATE chatwoot_connection_health SET access_error='UNVERIFIED' WHERE organization_id=$1",[t.org]);
 expect(await t.service.campaignTransport(t.p,t.integration)).toMatchObject({ready:false,reason:'CAMPAIGN_IDENTITY_NOT_READY'});
});
it('serializes a revoker-held key lock and rechecks fresh authority before an older worker can dispatch',async()=>{
 const t=await fixture();await t.reserve();await t.callback();await t.worker.runOnce(t.org);
 const revoker=await db.database.pool.connect();let dispatch:Promise<unknown>|undefined;
 try{
  await revoker.query('BEGIN');await revoker.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[t.key]);
  dispatch=db.transact(t.org,tx=>tx.query("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1",[t.org]));
  const outcome=dispatch.then(()=>({allowed:true}),error=>({allowed:false,error}));
  await new Promise(resolve=>setTimeout(resolve,100));await revoker.query('COMMIT');
  expect(await outcome).toMatchObject({allowed:false,error:{code:'42501',message:'CAMPAIGN_AUTHORITY_REVOKED'}});
 }finally{await revoker.query('ROLLBACK');revoker.release();await dispatch?.catch(()=>undefined);}
});
it('fences a changed physical recipient and cannot inspect another tenant intent through the authority function',async()=>{
 const t=await fixture(),reservation=await t.reserve();await t.callback();await t.worker.runOnce(t.org);
 await db.transact(randomUUID(),async tx=>{expect((await tx.query('SELECT campaign_intent_authorized($1,$2,false) allowed',[t.org,reservation.intentId])).rows[0]!.allowed).toBe(false);});
 await db.database.pool.query("UPDATE messaging_contacts SET external_id='12025550124' WHERE organization_id=$1",[t.org]);
 await expect(db.transact(t.org,tx=>tx.query("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1",[t.org]))).rejects.toMatchObject({code:'42501',message:'CAMPAIGN_AUTHORITY_REVOKED'});
});
it.each(['key','scope','binding','identity','owner','expiry'] as const)('protects even older workers at SENDING after %s revocation',async change=>{
 const t=await fixture(),reservation=await t.reserve();await t.callback();await t.worker.runOnce(t.org);
 const query=change==='key'?'UPDATE api_keys SET revoked_at=now() WHERE organization_id=$1':change==='scope'?"UPDATE api_keys SET scopes=ARRAY['chatwoot:read'] WHERE organization_id=$1":change==='binding'?'UPDATE chatwoot_control_bindings SET active=false WHERE organization_id=$1':change==='identity'?'UPDATE chatwoot_connection_health SET identity_revision=2 WHERE organization_id=$1':change==='owner'?"INSERT INTO attendance_owners(organization_id,channel_id,revision) VALUES($1,$2,1)":"UPDATE chatwoot_campaign_intents SET expires_at=now()-interval '1 second' WHERE organization_id=$1";
 await db.database.pool.query(query,change==='owner'?[t.org,t.channel]:[t.org]);
 await expect(db.transact(t.org,tx=>tx.query("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1 AND campaign_intent_id=$2",[t.org,reservation.intentId]))).rejects.toMatchObject({code:'42501',message:'CAMPAIGN_AUTHORITY_REVOKED'});
 await expect(db.transact(t.org,tx=>tx.query('UPDATE messaging_messages SET campaign_intent_id=NULL WHERE organization_id=$1',[t.org]))).rejects.toMatchObject({code:'42501',message:'CAMPAIGN_AUTHORITY_IMMUTABLE'});
});
it.each([
 'ALTER TABLE chatwoot_campaign_intents NO FORCE ROW LEVEL SECURITY',
 'ALTER POLICY campaign_tenant ON chatwoot_campaign_intents USING(true) WITH CHECK(true)',
 'CREATE POLICY campaign_unscoped ON chatwoot_campaign_intents TO jrc_app USING(true) WITH CHECK(true)',
 'GRANT UPDATE ON chatwoot_campaign_intents TO jrc_app',
 'REVOKE INSERT ON chatwoot_campaign_intents FROM jrc_app',
 'GRANT SELECT ON chatwoot_campaign_intents TO jrc_auth',
 'GRANT EXECUTE ON FUNCTION campaign_require_message_authority() TO PUBLIC',
 'ALTER TABLE messaging_messages DISABLE TRIGGER campaign_message_authority',
 "DELETE FROM lifecycle_purge_catalogue WHERE table_name='chatwoot_campaign_intents'",
])('refuses weakened campaign schema: %s',async mutation=>{
 const client=await db.database.pool.connect();try{
  await client.query('BEGIN');await client.query(mutation);await client.query('SET LOCAL ROLE jrc_app');
  expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
 }finally{await client.query('ROLLBACK');client.release();}
});
