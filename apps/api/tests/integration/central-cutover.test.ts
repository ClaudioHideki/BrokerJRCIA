import {createHmac,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase} from './helpers/attendance.js';
import {ChatwootClient,ChatwootError} from '../../src/modules/integrations/chatwoot-client.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {createChannelOperationProfile} from '../../src/modules/channels/operation-profile.js';
import {createChannelFacade} from '../../src/modules/channels/facade.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {createChatwootRuntimeIngress} from '../../src/modules/integrations/chatwoot-runtime-ingress.js';
import {createChatwootService} from '../../src/modules/integrations/chatwoot-service.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const vault=createIntegrationSecrets(Buffer.alloc(32,21).toString('base64'));
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
async function fixture(origin=`https://${randomUUID()}.example.test`){
 const org=randomUUID(),actor=randomUUID();
 const seed=await db.database.pool.connect();
 try{
 await seed.query('BEGIN');
 await seed.query("INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Synthetic cutover',$1::text)",[org]);
 for(const user of [actor,randomUUID()]){
  await seed.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'no-login')",[user,`${user}@example.test`]);
  await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,user]);
 }
 await seed.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status,encrypted_token) VALUES($1,$2,7,'READY',$3)",[org,origin,vault.encrypt(`${org}:chatwoot-account`,'synthetic')]);
 await seed.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[org]);
 await seed.query('COMMIT');
 }catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
 let currentBot:number|null=17,unknown:string|undefined,afterPost:(()=>Promise<void>)|undefined;
 const bots=[{id:17,name:'Previous synthetic',outgoing_url:'https://old.example.test/events',secret:'synthetic-old'}],posts:string[]=[];
 const inbox={id:9,name:'Synthetic inbox',channel_type:'Channel::Whatsapp',webhook_url:'https://unchanged.example.test/events'};
 const client=new ChatwootClient({baseUrl:origin,token:'synthetic',fetch:async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(init?.method==='POST'){
   posts.push(path);
   if(path.endsWith('/set_agent_bot')){currentBot=JSON.parse(String(init.body)).agent_bot;await afterPost?.();if(unknown==='detach'||unknown==='attach')throw new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true);return new Response(null,{status:200});}
   if(path.endsWith('/agent_bots')){const body=JSON.parse(String(init.body)),bot={id:19,name:body.name,outgoing_url:body.outgoing_url,secret:'synthetic-new'};bots.push(bot);await afterPost?.();if(unknown==='create')throw new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true);return Response.json(bot);}
   throw new Error('Unexpected POST');
  }
  if(path.endsWith('/agent_bot'))return Response.json({agent_bot:bots.find(b=>b.id===currentBot)??null});
  if(path.endsWith('/agent_bots'))return Response.json(bots);
  if(path.endsWith('/inboxes/9'))return Response.json(inbox);
  if(path==='/api/v1/profile')return Response.json({id:51,accounts:[{id:7,role:'administrator'}]});
  throw new Error('Unexpected GET');
 }});
 const path='../../src/modules/channels/central-cutover-service.js',module=await import(path).catch(()=>null);
 expect(module,'durable central cutover must exist').not.toBeNull();
 const service=()=>module!.createCentralCutoverService({transact:db.transact,client:()=>client,vault,callback:(id:string)=>`https://broker.example.test/v1/integrations/chatwoot/${id}/events`});
 const command=async()=>({provider:'CENTRAL',name:'Synthetic central',inboxId:9,...await service().preview(org,actor,9),replaceExistingBot:true});
 return {org,actor,origin,service,command,posts,inbox,bots,get currentBot(){return currentBot;},setUnknown:(v:string|undefined)=>{unknown=v;},setAfterPost:(v:()=>Promise<void>)=>{afterPost=v;}};
}
it('persists an idempotent cutover and observes detach before attaching without changing the existing webhook',async()=>{
 const t=await fixture(),command=await t.command(),key=randomUUID();
 let op=await t.service().prepare(t.org,t.actor,command,key);
 expect(await t.service().prepare(t.org,t.actor,command,key)).toMatchObject({id:op.id});
 for(let i=0;i<8&&op.status!=='COMPLETE';i++)op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 expect(op).toMatchObject({status:'COMPLETE',step:'VERIFY'});
 expect(t.currentBot).toBe(19);expect(t.posts).toHaveLength(3);
 expect(t.inbox.webhook_url).toBe('https://unchanged.example.test/events');
 const row=(await db.transact(t.org,tx=>tx.query('SELECT transport,provider,instance_id FROM messaging_channels WHERE id=$1',[op.channelId]))).rows[0];
 expect(row).toEqual({transport:'CENTRAL_TRANSPORT',provider:null,instance_id:null});
 expect(JSON.stringify(op)).not.toContain('synthetic-new');
});
it('rejects callback changes on the previous bot before any remote mutation',async()=>{
 const t=await fixture(),op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 t.bots[0]!.outgoing_url='https://changed.example.test/events';
 await expect(t.service().advance(t.org,t.actor,op.id,op.revision)).rejects.toThrow('CENTRAL_REMOTE_CHANGED');expect(t.posts).toHaveLength(0);
});
it('rejects a disabled physical inbox binding before altering its remote bot',async()=>{
 const t=await fixture();
 const provider=(await db.database.pool.query("INSERT INTO provider_accounts(organization_id,provider,name,credential_reference) VALUES($1,'META','Synthetic','vault://synthetic') RETURNING id",[t.org])).rows[0].id,channel=randomUUID();
 await db.database.pool.query("INSERT INTO messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference) VALUES($1,$2,$3,'synthetic','synthetic','vault://synthetic')",[channel,t.org,provider]);
 await db.database.pool.query("INSERT INTO chatwoot_connections(organization_id,id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,9,'Synthetic paused','DISABLED')",[t.org,randomUUID(),channel]);
 await expect(t.service().prepare(t.org,t.actor,await t.command(),randomUUID())).rejects.toThrow('CENTRAL_INBOX_ALREADY_CONNECTED');expect(t.posts).toHaveLength(0);
});
it('cancels an untouched operation after credential rotation and releases its claim without remote writes',async()=>{
 const t=await fixture(),key=randomUUID(),op=await t.service().prepare(t.org,t.actor,await t.command(),key);
 await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);
 expect(await t.service().byKey(t.org,key)).toMatchObject({id:op.id});
 expect(await t.service().cancel(t.org,t.actor,op.id,op.revision)).toMatchObject({status:'CANCELED'});
 expect(t.posts).toHaveLength(0);
 expect(await t.service().prepare(t.org,t.actor,await t.command(),randomUUID())).toMatchObject({status:'PENDING'});
});
it('reverses a confirmed partial detach using rotated credentials without continuing bot creation',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 op=await t.service().advance(t.org,t.actor,op.id,op.revision);expect(op.step).toBe('CREATE');
 await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);
 expect(await t.service().rollback(t.org,t.actor,op.id,op.revision)).toMatchObject({status:'ROLLED_BACK'});
 expect(t.currentBot).toBe(17);expect(t.posts.filter(p=>p.endsWith('/agent_bots'))).toHaveLength(0);
});
it('reverses a completed operation after credential rotation without reactivating stale runtime pins',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);
 expect(await t.service().rollback(t.org,t.actor,op.id,op.revision)).toMatchObject({status:'ROLLED_BACK'});
 expect(t.currentBot).toBe(17);
 expect((await db.transact(t.org,tx=>tx.query('SELECT status FROM central_transport_bindings'))).rows).toEqual([{status:'DISABLED'}]);
});
it('recovers a reversal interrupted by credential rotation without repeating the uncertain detach',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 let rotated=false;t.setAfterPost(async()=>{if(!rotated){rotated=true;await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);}});
 await expect(t.service().rollback(t.org,t.actor,op.id,op.revision)).rejects.toThrow('CENTRAL_CONTEXT_CHANGED');
 op=await t.service().get(t.org,op.id);expect(op).toMatchObject({status:'UNKNOWN',rollbackStep:'DETACH'});
 const before=t.posts.length;
 expect(await t.service().rollback(t.org,t.actor,op.id,op.revision)).toMatchObject({status:'ROLLED_BACK'});
 expect(t.posts.length-before).toBe(1);expect(t.currentBot).toBe(17);
});
it.each(['detach','create','attach'])('reconciles uncertain %s after service replacement without repeating POST',async stage=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 const target={detach:'DETACH',create:'CREATE',attach:'ATTACH'}[stage];
 while(op.step!==target)op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 t.setUnknown(stage);op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 expect(op.status).toBe('UNKNOWN');const count=t.posts.length;t.setUnknown(undefined);
 op=await t.service().advance(t.org,t.actor,op.id,op.revision);expect(t.posts).toHaveLength(count);
 for(let i=0;i<8&&op.status!=='COMPLETE';i++)op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 expect(op.status).toBe('COMPLETE');expect(t.posts).toHaveLength(3);
});
it('revalidates current tenant role and account revisions after remote IO',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 t.setAfterPost(async()=>{await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);});
 await expect(t.service().advance(t.org,t.actor,op.id,op.revision)).rejects.toThrow('CENTRAL_CONTEXT_CHANGED');
 expect((await db.transact(t.org,tx=>tx.query('SELECT channel_id FROM central_transport_bindings'))).rowCount).toBe(0);
 await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);
 await expect(t.service().advance(t.org,t.actor,op.id,op.revision)).rejects.toThrow('CENTRAL_MANAGEMENT_FORBIDDEN');
});
it('keeps remote claims isolated even when two organizations configure the same numeric IDs',async()=>{
 const a=await fixture(),b=await fixture(),c=await fixture();
 await expect(fixture(a.origin)).rejects.toMatchObject({code:'23505',constraint:'chatwoot_accounts_base_url_account_id_key'});
 const op=await a.service().prepare(a.org,a.actor,await a.command(),randomUUID());
 await expect(a.service().prepare(a.org,a.actor,await a.command(),randomUUID())).rejects.toThrow('CENTRAL_INBOX_CLAIMED');
 expect((await c.service().prepare(c.org,c.actor,await c.command(),randomUUID())).id).not.toBe(op.id);
 await expect(b.service().get(b.org,op.id)).rejects.toThrow('CENTRAL_OPERATION_NOT_FOUND');
});
it('does not revoke any executor without an explicit replacement choice',async()=>{
 const t=await fixture(),command=await t.command();
 await expect(t.service().prepare(t.org,t.actor,{...command,replaceExistingBot:false},randomUUID())).rejects.toThrow('CENTRAL_REPLACEMENT_REQUIRED');
 expect(t.posts).toEqual([]);
});
it('requires an explicit rollback and observes restoration before disabling the central binding',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 const restored=await t.service().rollback(t.org,t.actor,op.id,op.revision);
 expect(restored.status).toBe('ROLLED_BACK');expect(t.currentBot).toBe(17);
 expect((await db.transact(t.org,tx=>tx.query('SELECT status FROM central_transport_bindings WHERE channel_id=$1',[op.channelId]))).rows).toEqual([{status:'DISABLED'}]);
 expect(t.inbox.webhook_url).toBe('https://unchanged.example.test/events');
});
it('can configure the same inbox again after a verified rollback while preserving the original channel',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 const channel=op.channelId;await t.service().rollback(t.org,t.actor,op.id,op.revision);
 let next=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(next.status!=='COMPLETE')next=await t.service().advance(t.org,t.actor,next.id,next.revision);
 expect(next.channelId).toBe(channel);expect(next.id).not.toBe(op.id);
 expect((await db.transact(t.org,tx=>tx.query('SELECT id FROM messaging_channels'))).rowCount).toBe(1);
});
it('counts an unfinished remote cutover before lifecycle deletion can purge its history',async()=>{
 const t=await fixture();await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 const count=(await db.database.pool.query('SELECT lifecycle_pending_count($1,NULL,NULL) AS count',[t.org])).rows[0];
 expect(Number(count.count)).toBeGreaterThan(0);
});
it('refuses rollback when the previous bot callback was changed outside the cutover',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 t.bots[0]!.outgoing_url='https://different.example.test/events';const before=t.posts.length;
 await expect(t.service().rollback(t.org,t.actor,op.id,op.revision)).rejects.toThrow('CENTRAL_REMOTE_CHANGED');
 expect(t.posts).toHaveLength(before);
});
it.each(['IDLE','UNKNOWN'])('preserves legacy sessions during cutover and requires reconciliation of %s',async state=>{
 const t=await fixture(),flow=randomUUID(),binding=randomUUID();
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[t.org]);
 await db.database.pool.query("INSERT INTO flows(organization_id,id,name,graph) VALUES($1,$2,'Synthetic old','{}')",[t.org,flow]);
 await db.database.pool.query(`INSERT INTO flow_chatwoot_bindings(organization_id,id,flow_id,inbox_id,account_id,destination_revision,credential_version,feature_revision,name,channel_type,bot_id,encrypted_credentials,status,operation_state)
 VALUES($1,$2,$3,9,7,1,1,1,'Synthetic old','Channel::Whatsapp',17,'synthetic','READY',$4)`,[t.org,binding,flow,state]);
 await db.database.pool.query('INSERT INTO flow_chatwoot_sessions(organization_id,binding_id,conversation_id,human) VALUES($1,$2,101,true)',[t.org,binding]);
 if(state==='UNKNOWN'){await expect(t.service().prepare(t.org,t.actor,await t.command(),randomUUID())).rejects.toThrow('CENTRAL_LEGACY_RECONCILIATION_REQUIRED');expect(t.posts).toHaveLength(0);return;}
 let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 expect((await db.transact(t.org,tx=>tx.query('SELECT status FROM flow_chatwoot_bindings'))).rows).toEqual([{status:'DISABLED'}]);
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 expect((await db.transact(t.org,tx=>tx.query('SELECT human FROM flow_chatwoot_sessions'))).rows).toEqual([{human:true}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT bot_id FROM flow_chatwoot_bindings'))).rows).toEqual([{bot_id:null}]);
});
it('reports central capabilities and the individual callback separately without assuming Api inbox capability',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 const profile=createChannelOperationProfile({transact:db.transact,managedOrigin:t.origin,externalDestinationsEnabled:true});
 expect(await profile.get(t.org,op.channelId!)).toMatchObject({transport:'CENTRAL_TRANSPORT',readiness:'BLOCKED',blockers:['CALLBACK_UNVERIFIED'],deliveryVerified:false});
 await db.transact(t.org,tx=>tx.query('UPDATE central_transport_bindings SET callback_verified_at=now(),callback_credential_version=1,callback_destination_revision=1 WHERE channel_id=$1',[op.channelId]));
 expect(await profile.get(t.org,op.channelId!)).toMatchObject({transport:'CENTRAL_TRANSPORT',readiness:'READY',blockers:[],deliveryVerified:false});
 await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);
 expect(await profile.get(t.org,op.channelId!)).toMatchObject({readiness:'BLOCKED'});
});
it('creates and publishes one Flow, requires its signed individual callback and binds through the public facade',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[t.org]);
 const automation=createAutomationService({transact:db.transact,enabled:true}),graph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'end',type:'end',label:'End',position:{x:1,y:0},data:{}}],edges:[{id:'next',source:'start',target:'end',port:'next'}]};
 const draft=await automation.create(t.org,{name:'Synthetic publication',graph});await automation.publish(t.org,draft.id,1);
 const facade=createChannelFacade({transact:db.transact,instances:{} as never,meta:{} as never});
 expect(await facade.get(t.org,op.channelId!)).toMatchObject({provider:'CENTRAL',messagingChannelId:op.channelId});
 await expect(facade.bindAutomation(t.org,op.channelId!,{automationId:draft.id,expectedOwnerRevision:0})).rejects.toThrow('CENTRAL_CALLBACK_TEST_REQUIRED');
 const ingress=createChatwootRuntimeIngress({transact:db.transact,secrets:vault,resolveIntegration:async()=>t.org});
 const raw=Buffer.from(JSON.stringify({event:'message_created',id:201,account:{id:7},inbox:{id:9},conversation:{id:101,inbox_id:9,contact_inbox:{contact_id:301}},private:false,message_type:'incoming',content:'Synthetic callback',sender:{id:301,type:'contact'}})),timestamp=String(Math.floor(Date.now()/1000));
 await ingress.receive({integrationId:op.integrationId,raw,timestamp,signature:'sha256='+createHmac('sha256','synthetic-new').update(timestamp+'.').update(raw).digest('hex')});
 expect(await facade.bindAutomation(t.org,op.channelId!,{automationId:draft.id,expectedOwnerRevision:0})).toMatchObject({ownerRevision:1,binding:{status:'ACTIVE',automationId:draft.id}});
 expect((await db.transact(t.org,tx=>tx.query('SELECT owner_revision FROM central_transport_bindings'))).rows).toEqual([{owner_revision:1}]);
});
it('refuses enabling, retrying or reconciling a native central channel through the physical adapter',async()=>{
 const t=await fixture();let op=await t.service().prepare(t.org,t.actor,await t.command(),randomUUID());
 while(op.status!=='COMPLETE')op=await t.service().advance(t.org,t.actor,op.id,op.revision);
 const physical=createChatwootService({transact:db.transact,baseUrl:t.origin,publicOrigin:'https://broker.example.test',encryptionKey:Buffer.alloc(32,21).toString('base64')});
 await expect(physical.setEnabled(t.org,op.integrationId,true)).rejects.toThrow('CENTRAL_INBOX_CLAIMED');
 await expect(physical.retryConnection(t.org,op.integrationId,false)).rejects.toThrow('CENTRAL_INBOX_CLAIMED');
 await expect(physical.reconcileConnection(t.org,op.integrationId)).rejects.toThrow('CENTRAL_INBOX_CLAIMED');
});
