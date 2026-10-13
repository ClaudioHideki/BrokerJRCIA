import {createHmac,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {reconcileWhatsAppGroupParticipation} from '../../src/modules/whatsapp-groups/events.js';
import {createGroupAutomationRuntime,type GroupRuntimeOptions,type GroupControlInput} from '../../src/modules/whatsapp-groups/automation-runtime.js';
import {normalizeQrEvent} from '../../src/modules/messaging/qr-events.js';
import {createChatwootService,chatwootEnvironment,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
const key=Buffer.alloc(32,13).toString('base64'),configurationScope='synthetic-g3-scope',phone='5511999990999',group='120363999000001@g.us',author='5511999990001@s.whatsapp.net',other='5511999990002@s.whatsapp.net';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph={nodes:[node('start','start'),node('hello','message',{text:'Bem-vindo ao grupo'}),node('menu','menu',{text:'Escolha',variable:'opcao',options:[{value:'1',label:'Resposta'}]}),node('answer','message',{text:'Resposta do fluxo'}),node('end','end')],
  edges:[{id:'a',source:'start',target:'hello',port:'next'},{id:'b',source:'hello',target:'menu',port:'next'},{id:'c',source:'menu',target:'answer',port:'option-1'},{id:'d',source:'answer',target:'end',port:'next'}]};
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});
afterAll(async()=>{await db?.dispose();});
async function fixture(overrides:Partial<GroupRuntimeOptions>={}) {
  const t=await seedAttendanceTenant(db.database,false),instance=randomUUID();
  const actor=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0]!.user_id as string;
  const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
  await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1::uuid,$2,$3,'Synthetic group',$1::text,'CONNECTED')",[instance,t.org,provider]);
  await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
  await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[t.org]);
  await db.database.pool.query("UPDATE automation_definitions SET lifecycle_status='PUBLISHED',active_version=1 WHERE organization_id=$1 AND id=$2",[t.org,t.automation]);
  await db.database.pool.query('UPDATE automation_versions SET graph=$3,runtime_state_version=2 WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation,JSON.stringify(graph)]);
  await createAutomationService({transact:db.transact}).bind(t.org,t.automation,{channelId:t.channel});
  const binding=(await db.database.pool.query('SELECT id,revision FROM automation_bindings WHERE organization_id=$1 AND channel_id=$2',[t.org,t.channel])).rows[0]!;
  const owner=(await db.database.pool.query('SELECT revision FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',[t.org,t.channel])).rows[0]!;
  const fingerprint=createHmac('sha256',Buffer.from(key,'base64')).update(`whatsapp-group-identity:v1:${t.org}:${t.channel}:${phone}`).digest('hex');
  const snapshot=randomUUID();
  await db.database.pool.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id,identity_revision,identity_fingerprint,catalog_revision,snapshot_id,observed_at,valid_until)
    VALUES($1,$2,1,$3,1,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[t.org,t.channel,fingerprint,snapshot]);
  await db.database.pool.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count,announce,is_community,is_community_announce,selected)
    VALUES($1,$2,$3,'Synthetic group',2,false,false,false,true)`,[t.org,t.channel,group]);
  await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
  await db.database.pool.query(`INSERT INTO whatsapp_group_webhook_operations(organization_id,channel_id,instance_id,actor_id,binding_fingerprint,expected_identity_revision,catalog_revision,identity_revision,identity_fingerprint,phase,observed_at)
    VALUES($1,$2,$3,$4,$5,1,1,1,$6,'CONFIRMED',clock_timestamp())`,[t.org,t.channel,instance,actor,
      createHmac('sha256',Buffer.from(key,'base64')).update('whatsapp-group-webhook-binding:v2\0').update(JSON.stringify([configurationScope,t.org,t.channel,instance,instance])).digest('hex'),fingerprint]);
  const sends:Array<{groupJid:string;text:string}>=[];
  const options:GroupRuntimeOptions={transact:db.transact,encryptionKey:key,configurationScope,requestTimeoutMs:30000,
    readIdentity:async()=>({connected:true,phone,groupsIgnore:false}),sendText:async(_ctx,_instance,recipient,text)=>{sends.push({groupJid:recipient.groupJid,text});return{upstreamMessageId:'provider-'+sends.length};},...overrides};
  const runtime=createGroupAutomationRuntime(options),principal={organizationId:t.org,actorId:actor};
  const input:GroupControlInput={groupJid:group,triggerText:'/iniciar',expectedOwnerRevision:owner.revision,expectedBindingId:binding.id,
    expectedBindingRevision:binding.revision,expectedIdentityRevision:1,expectedIdentityFingerprint:fingerprint};
  const event=(text:string,id:string=randomUUID(),participant=author,fromMe=false)=>normalizeQrEvent({instance:instance,event:'messages.upsert',data:{key:{id,remoteJid:group,fromMe,participant},message:{conversation:text},messageTimestamp:Math.floor(Date.now()/1000)}},instance)[0]!;
  const ingest=(text:string,id?:string,participant?:string,fromMe?:boolean)=>db.transact(t.org,tx=>runtime.ingestWithinTransaction(tx,t.org,t.channel,event(text,id,participant,fromMe) as never));
  return{...t,actor,instance,principal,input,runtime,options,sends,ingest,event};
}
async function drain(t:Awaited<ReturnType<typeof fixture>>) {
  for(let i=0;i<10;i++){const result=await t.runtime.enqueueEffectsOnce(t.org);if(!result.processed)break;}
  for(let i=0;i<10;i++){const result=await t.runtime.dispatchOnce(t.org);if(!result.processed)break;}
}

async function central(t:Awaited<ReturnType<typeof fixture>>,unknown=false){
 const calls:Array<{path:string;method:string;body:any}>=[];let remoteId=100;
 const options:ChatwootOptions={baseUrl:'https://'+t.org+'.example.test',publicOrigin:'https://broker.example.test',encryptionKey:key,transact:db.transact,groupPolicy:t.options,
  resolveIntegration:async id=>id===t.integration?t.org:undefined,fetch:async(input,init)=>{
   const path=new URL(String(input)).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;calls.push({path,method,body});
   let data:unknown;
   if(path.endsWith('/contacts/search'))data={payload:[]};
   else if(path.endsWith('/contacts')&&method==='POST')data={payload:{contact:{id:41}}};
   else if(path.endsWith('/contact_inboxes'))data={source_id:body.source_id};
   else if(path.endsWith('/inboxes/9'))data={id:9,channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:false};
   else if(path.endsWith('/agent_bot'))data={};
   else if(path.endsWith('/conversations')&&method==='POST')data={id:51};
   else if(path.endsWith('/conversations/51'))data={id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100,meta:{assignee:null,assignee_type:null,team:null}};
   else if(path.endsWith('/messages')&&method==='POST'){if(unknown)throw Error('synthetic lost receipt');data={id:++remoteId};}
   else if(method==='PATCH')data={};
   else throw Error('Unexpected synthetic endpoint '+method+' '+path);
   return Response.json(data);
  }};
 const vault=chatwootEnvironment(options).vault,secret='synthetic-group-callback';
 await db.database.pool.query('INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status,encrypted_token) VALUES($1,$2,7,\'READY\',$3)',[t.org,options.baseUrl,vault.encrypt(t.org+':chatwoot-account','synthetic-token')]);
 await db.database.pool.query('INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,$3,9,\'Group central\',\'READY\',$4)',[t.integration,t.org,t.channel,vault.encrypt(t.org+':chatwoot-webhook:'+t.integration,secret)]);
 const worker=createChatwootWorker(options),service=createChatwootService(options);
 const receive=(patch:Record<string,unknown>={})=>{const raw=Buffer.from(JSON.stringify({event:'message_created',id:901,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},message_type:'outgoing',private:false,sender:{id:12,type:'user'},content:'Resposta humana no grupo',...patch})),timestamp=String(Math.floor(Date.now()/1000));return service.ingest(t.integration,raw,timestamp,'sha256='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex'));};
 const run=async()=>{for(let i=0;i<20;i++){if(!(await db.database.pool.query("SELECT 1 FROM integration_jobs WHERE organization_id=$1 AND status='PENDING' AND available_at<=now()",[t.org])).rowCount)break;await worker.runOnce(t.org);}
  return(await db.database.pool.query('SELECT kind,status,last_error FROM integration_jobs WHERE organization_id=$1 ORDER BY created_at,id',[t.org])).rows;};
 return{calls,receive,run};
}
it('mirrors a selected group without an individual contact and returns an authenticated human reply to the same group',async()=>{
 const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);const c=await central(t);
 await t.ingest('/iniciar');expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'SUCCEEDED'})]));
 const contact=c.calls.find(x=>x.path.endsWith('/contacts')&&x.method==='POST')!.body;
 expect(contact.phone_number).toBeUndefined();expect(contact.email).toBeUndefined();expect(contact.additional_attributes.jrc_broker_recipient_kind).toBe('GROUP');
 expect(await t.runtime.executeOnce(t.org)).toMatchObject({status:'WAITING'});await drain(t);expect(t.sends.length).toBe(3);await c.run();
 await c.receive();await c.receive();expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'SUCCEEDED'})]));
 expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({status:'SENT'});expect(t.sends.at(-1)).toEqual({groupJid:group,text:'Resposta humana no grupo'});
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_group_replies WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_contacts WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
 await c.receive({id:902,private:true,content:'PRIVATE NEVER SEND'});await c.run();expect(await t.runtime.dispatchOnce(t.org)).toEqual({processed:false});
 const otherTenant=await fixture();expect((await db.transact(otherTenant.org,tx=>tx.query('SELECT scope_key FROM chatwoot_group_scopes'))).rows).toEqual([]);
});
it('keeps a group mirror with an unknown receipt durable across worker restarts without another POST',async()=>{
 const t=await fixture();const c=await central(t,true);await t.ingest('observed only');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'UNKNOWN'})]));
 const posts=c.calls.filter(x=>x.path.endsWith('/messages')&&x.method==='POST').length;expect(posts).toBe(1);await c.run();expect(c.calls.filter(x=>x.path.endsWith('/messages')&&x.method==='POST')).toHaveLength(posts);
});
it('does not dispatch a queued human group reply after destination authorization is revoked',async()=>{
 const t=await fixture();const c=await central(t);await t.ingest('observed only');await c.run();await c.receive();await c.run();
 await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[t.org]);
 expect(await t.runtime.dispatchOnce(t.org)).toEqual({processed:false});expect(t.sends).toEqual([]);
});
