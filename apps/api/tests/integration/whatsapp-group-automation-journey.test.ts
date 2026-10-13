import {createHmac,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {reconcileWhatsAppGroupParticipation,createWhatsAppGroupEvents} from '../../src/modules/whatsapp-groups/events.js';
import {createGroupAutomationRuntime,type GroupRuntimeOptions,type GroupControlInput} from '../../src/modules/whatsapp-groups/automation-runtime.js';
import {normalizeQrEvent} from '../../src/modules/messaging/qr-events.js';
import {createEvolutionGroupTextSender} from '../../../../packages/providers/src/evolution/group-text.js';
import {Pool} from 'pg';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {createPostgresAutomationRepository} from '../../src/modules/automations/repository.js';
import {createEventRouter,createExecutionService} from '../../src/modules/automations/service.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
const roleUrl=(connection:string,role:'jrc_platform'|'jrc_lifecycle')=>{const url=new URL(connection);url.username=role;return url.toString();};
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

import {createQrMessagingService} from '../../src/modules/messaging/qr-service.js';
import {createMessagingWorker} from '../../src/modules/messaging/worker.js';
import {createWhatsAppGroupCatalog} from '../../src/modules/whatsapp-groups/service.js';
it('authenticates two companies into the existing GROUP engine, opt-in view, outbox and messaging worker without replaying UNKNOWN',async()=>{
  let uncertainPosts=0;
  const a=await fixture(),b=await fixture({sendText:async()=>{uncertainPosts++;throw Object.assign(new Error('QR_SEND_UNKNOWN'),{code:'QR_SEND_UNKNOWN'});}});
  const catalog=createWhatsAppGroupCatalog({...a.options,readGroups:async()=>[]});
  expect((await catalog.page(a.principal,a.channel,{limit:50})).items[0]!.automationEnabled).toBe(false);
  await a.runtime.configure(a.principal,a.channel,a.input);await b.runtime.configure(b.principal,b.channel,b.input);
  // Configured opt-in is separate from catalogue selection and runtime authority.
  expect((await catalog.page(a.principal,a.channel,{limit:50})).items[0]!.automationEnabled).toBe(true);
  const signing='synthetic-g3-integration-signing-at-least-32-bytes';
  const ingress=createQrMessagingService({baseUrl:'https://engine.invalid',apiKey:'synthetic-engine',webhookOrigin:'https://broker.invalid',signingKey:signing,
    transact:db.transact,groupAutomation:{ingestWithinTransaction:a.runtime.ingestWithinTransaction},
    resolveChannel:async id=>id===a.channel?{organizationId:a.org,instanceId:a.instance}:id===b.channel?{organizationId:b.org,instanceId:b.instance}:undefined});
  const authorization=(t:typeof a)=>'Bearer '+createHmac('sha256',signing).update('qr-webhook\0'+t.org+'\0'+t.channel).digest('base64url');
  const payload=(t:typeof a,text:string,id:string,participant=author)=>({instance:t.instance,event:'messages.upsert',data:{key:{id,remoteJid:group,fromMe:false,participant},message:{conversation:text},messageTimestamp:Math.floor(Date.now()/1000)}});
  await expect(ingress.ingest(b.channel,authorization(a),payload(b,'/iniciar','same-provider-id'))).rejects.toMatchObject({code:'QR_WEBHOOK_UNAUTHORIZED'});
  await ingress.ingest(a.channel,authorization(a),payload(a,'/iniciar','same-provider-id'));
  await ingress.ingest(a.channel,authorization(a),payload(a,'/iniciar','same-provider-id'));
  await ingress.ingest(b.channel,authorization(b),payload(b,'/iniciar','same-provider-id'));
  for(const t of [a,b]){
    expect(await t.runtime.executeOnce(t.org)).toMatchObject({status:'WAITING'});
    for(let i=0;i<3;i++)expect(await t.runtime.enqueueEffectsOnce(t.org)).toMatchObject({processed:true});
  }
  const worker=(t:typeof a)=>createMessagingWorker({repository:createPostgresMessagingRepository(),transact:db.transact,groupAutomation:t.runtime,
    resolveMetaClient:async()=>{throw new Error('UNEXPECTED_META');},resolveTypebotClient:async()=>{throw new Error('UNEXPECTED_TYPEBOT');}});
  const wa=worker(a),wb=worker(b);
  for(let i=0;i<3;i++)await wa.runOnce(a.org);
  for(let i=0;i<3;i++)await wb.runOnce(b.org);
  expect(a.sends.map(s=>s.text)).toEqual(['Este atendimento segue somente as respostas de quem iniciou. Outros participantes não avançam o menu.','Bem-vindo ao grupo','Escolha\n1 - Resposta']);
  expect(uncertainPosts).toBe(1);
  const replacement=worker(b);await replacement.runOnce(b.org);expect(uncertainPosts).toBe(1);
  expect((await db.database.pool.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[b.org])).rows).toEqual([{state:'UNKNOWN'}]);
  await ingress.ingest(a.channel,authorization(a),payload(a,'1','other-response',other));expect(await a.runtime.executeOnce(a.org)).toMatchObject({processed:false});
  await ingress.ingest(a.channel,authorization(a),payload(a,'1','author-response'));
  expect(await a.runtime.executeOnce(a.org)).toMatchObject({status:'COMPLETED'});await a.runtime.enqueueEffectsOnce(a.org);await wa.runOnce(a.org);
  expect(a.sends.at(-1)!.text).toBe('Resposta do fluxo');
  for(const t of [a,b]){
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_executions WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_contacts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_bot_jobs WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  }
  expect(await b.runtime.inspect(b.principal,b.channel,group)).toMatchObject({state:'UNKNOWN',nextAction:'RECONCILE_OUTCOME',initiatorJid:author});
});
