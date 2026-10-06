import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createChannelOperationProfile} from '../../src/modules/channels/operation-profile.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},120000);
afterAll(async()=>{await db?.dispose();});
async function fixture(remote=false,mode='EXTERNAL'){
 const t=await seedAttendanceTenant(db.database,false),id=randomUUID(),origin=`https://${t.org}.example.test`;
 await db.database.pool.query("insert into meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,encrypted_token,graph_version,status) values($1,$2,$3,'test',$4,'synthetic-secret','v24','READY')",[id,t.org,t.channel,`asset-${id}`]);
 if(remote){
  await db.database.pool.query("insert into chatwoot_destinations(organization_id,base_url,mode,approval_status) values($1,$2,$3,'APPROVED')",[t.org,origin,mode]);
  await db.database.pool.query("insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,$2,7,'READY')",[t.org,origin]);
  await db.database.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,9,'test','READY')",[t.integration,t.org,t.channel]);
  await db.database.pool.query("update chatwoot_accounts set encrypted_token='never-project-this',capabilities=jsonb_set($2::jsonb,'{observedAt}',to_jsonb(clock_timestamp())) where organization_id=$1",[t.org,JSON.stringify({credentialVersion:1,destinationRevision:1,observations:{adminAccount:true,apiAccess:true,apiInbox:true,webhookSecret:true,signedCallback:true}})]);
  await db.database.pool.query("insert into chatwoot_connection_health(organization_id,integration_id,channel_id,callback_verified_at,callback_destination_revision,callback_credential_version) values($1,$2,$3,clock_timestamp(),1,1)",[t.org,t.integration,t.channel]);
 }
 return {...t,id,origin};
}
const service=(managedOrigin?:string)=>createChannelOperationProfile({transact:db.transact,externalDestinationsEnabled:true,...(managedOrigin?{managedOrigin}:{})});
it('observes a standalone box without requiring a central or declaring delivery',async()=>{
 const t=await fixture();
 expect(await service().get(t.org,t.id)).toMatchObject({channelId:t.id,messagingChannelId:t.channel,mode:'STANDALONE',transport:'BROKER_TRANSPORT',readiness:'READY',blockers:[],central:null,deliveryVerified:false});
});
it.each(['FAILED','DISABLED','UNKNOWN','PENDING'])('retains central mode and blocks a %s connection',async status=>{
 const t=await fixture(true);await db.database.pool.query('update chatwoot_connections set status=$2 where organization_id=$1',[t.org,status]);
 expect(await service().get(t.org,t.id)).toMatchObject({mode:'CHATWOOT_EXTERNAL',readiness:'BLOCKED',blockers:expect.arrayContaining(['CONNECTION_NOT_READY'])});
});
it('blocks a configured central without an approved matching scope',async()=>{
 const t=await fixture();
 await db.database.pool.query("insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,$2,7,'READY')",[t.org,t.origin]);
 await db.database.pool.query("insert into chatwoot_connections(organization_id,channel_id,inbox_id,name,status) values($1,$2,9,'test','FAILED')",[t.org,t.channel]);
 expect(await service().get(t.org,t.id)).toMatchObject({mode:null,transport:null,readiness:'BLOCKED',blockers:expect.arrayContaining(['CENTRAL_SCOPE_UNVERIFIED'])});
});
it('checks the managed origin against the configured server origin',async()=>{
 const t=await fixture(true,'MANAGED');
 expect(await service(t.origin).get(t.org,t.id)).toMatchObject({mode:'JRC_MANAGED',readiness:'READY',blockers:[]});
 expect(await service('https://other.example.test').get(t.org,t.id)).toMatchObject({mode:null,readiness:'BLOCKED',blockers:expect.arrayContaining(['CENTRAL_SCOPE_UNVERIFIED'])});
});
it('scopes equal account/inbox numbers to distinct origins and organizations',async()=>{
 const a=await fixture(true),b=await fixture(true);
 const pa=await service().get(a.org,a.id),pb=await service().get(b.org,b.id);
 expect(pa.central).toMatchObject({origin:a.origin,accountId:7,inboxId:9,integrationId:a.integration});
 expect(pb.central).toMatchObject({origin:b.origin,accountId:7,inboxId:9,integrationId:b.integration});
 await expect(service().get(a.org,b.id)).rejects.toThrow('CHANNEL_NOT_FOUND');
 expect(JSON.stringify(pa)).not.toMatch(/never-project-this|synthetic-secret|encrypted_token|password/);
});
it('does not reuse capability observations from a prior credential',async()=>{
 const t=await fixture(true);await db.database.pool.query('update chatwoot_accounts set credential_version=2 where organization_id=$1',[t.org]);
 expect(await service().get(t.org,t.id)).toMatchObject({readiness:'BLOCKED',blockers:expect.arrayContaining(['CAPABILITIES_UNVERIFIED']),central:{credentialVersion:2}});
});
it('blocks a revoked destination and disabled account without local fallback',async()=>{
 const t=await fixture(true);await db.database.pool.query("update chatwoot_destinations set approval_status='REVOKED' where organization_id=$1",[t.org]);
 expect(await service().get(t.org,t.id)).toMatchObject({mode:'CHATWOOT_EXTERNAL',readiness:'BLOCKED',blockers:expect.arrayContaining(['DESTINATION_NOT_APPROVED'])});
 await db.database.pool.query("update chatwoot_accounts set status='DISABLED' where organization_id=$1",[t.org]);
 expect((await service().get(t.org,t.id)).blockers).toContain('ACCOUNT_NOT_READY');
});
it('rejects a suspended organization',async()=>{
 const t=await fixture();await db.database.pool.query("update organizations set status='SUSPENDED' where id=$1",[t.org]);
 await expect(service().get(t.org,t.id)).rejects.toThrow('ORGANIZATION_NOT_ACTIVE');
});
it('resolves the public QR instance separately from its messaging channel and does not activate it on read',async()=>{
 const t=await fixture(),instance=randomUUID(),channel=randomUUID();
 const provider=(await db.database.pool.query("insert into provider_accounts(organization_id,provider,name) values($1,'BAILEYS','baileys') returning id",[t.org])).rows[0].id;
 await db.database.pool.query("insert into instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) values($1,$2,$3,'test',$4,'CONNECTED')",[instance,t.org,provider,`synthetic-${instance}`]);
 expect(await service().get(t.org,instance)).toMatchObject({channelId:instance,messagingChannelId:null,mode:'STANDALONE',readiness:'BLOCKED',blockers:['CHANNEL_NOT_ACTIVATED']});
 expect((await db.database.pool.query('select id from messaging_channels where organization_id=$1 and instance_id=$2',[t.org,instance])).rows).toEqual([]);
 await db.database.pool.query("insert into messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference) values($1,$2,$3,'BAILEYS',$4,'qr-engine')",[channel,t.org,provider,instance]);
 expect(await service().get(t.org,instance)).toMatchObject({channelId:instance,messagingChannelId:channel,mode:'STANDALONE',readiness:'READY'});
 await db.database.pool.query("update instances set status='DISCONNECTED',archived_at=now() where id=$1",[instance]);
 expect((await service().get(t.org,instance)).blockers).toEqual(expect.arrayContaining(['CHANNEL_INACTIVE','TRANSPORT_NOT_CONNECTED']));
});
it('does not advertise a legacy executor as current central transport',async()=>{
 const t=await fixture(true);await db.database.pool.query("update messaging_channels set bot_public_id='legacy',bot_origin_reference='jrc-flows-native' where id=$1",[t.channel]);
 expect(await service().get(t.org,t.id)).toMatchObject({mode:'CHATWOOT_EXTERNAL',transport:null,readiness:'BLOCKED',blockers:expect.arrayContaining(['LEGACY_EXECUTOR_PRESENT'])});
});
it('does not bypass a disabled external integration flag',async()=>{
 const t=await fixture(true);
 const disabled=createChannelOperationProfile({transact:db.transact,externalDestinationsEnabled:false});
 expect(await disabled.get(t.org,t.id)).toMatchObject({mode:'CHATWOOT_EXTERNAL',readiness:'BLOCKED',blockers:expect.arrayContaining(['CENTRAL_INTEGRATION_DISABLED'])});
});
it.each(['ABSENT','OLD_CREDENTIAL','OLD_DESTINATION','RESET'])('does not borrow aggregate account callback evidence for a second box: %s',async state=>{
 const t=await fixture(true),channel=randomUUID(),id=randomUUID(),integration=randomUUID();
 const p=(await db.database.pool.query('select provider_account_id from messaging_channels where id=$1',[t.channel])).rows[0].provider_account_id;
 await db.database.pool.query("insert into messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference) values($1,$2,$3,$4,'test','vault://test')",[channel,t.org,p,`asset-${channel}`]);
 await db.database.pool.query("insert into meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,encrypted_token,graph_version,status) values($1,$2,$3,'test',$4,'synthetic-secret','v24','READY')",[id,t.org,channel,`meta-${channel}`]);
 await db.database.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,10,'second','READY')",[integration,t.org,channel]);
 if(state!=='ABSENT')await db.database.pool.query("insert into chatwoot_connection_health(organization_id,integration_id,channel_id,callback_verified_at,callback_destination_revision,callback_credential_version) values($1,$2,$3,case when $4='RESET' then null else clock_timestamp() end,case when $4='OLD_DESTINATION' then 2 else 1 end,case when $4='OLD_CREDENTIAL' then 2 else 1 end)",[t.org,integration,channel,state]);
 expect(await service().get(t.org,t.id)).toMatchObject({readiness:'READY',blockers:[]});
 expect(await service().get(t.org,id)).toMatchObject({mode:'CHATWOOT_EXTERNAL',readiness:'BLOCKED',blockers:expect.arrayContaining(['CALLBACK_UNVERIFIED'])});
});
