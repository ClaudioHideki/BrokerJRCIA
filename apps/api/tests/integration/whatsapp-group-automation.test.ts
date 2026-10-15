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
import {runtimeAuthorityAllows} from '../../src/modules/attendance/runtime-authority.js';
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
it('keeps scheduler group authority restricted to its policy, tenant, channel and group',async()=>{
  const t=await fixture(),otherTenant=await fixture();
  await t.runtime.configure(t.principal,t.channel,t.input);const started=await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);
  const conversation=(await db.database.pool.query('select conversation_id from automation_executions where organization_id=$1 and id=$2',[t.org,started.executionId])).rows[0]!.conversation_id;
  const input={organizationId:t.org,channelId:t.channel,conversationId:conversation,automationId:t.automation,version:1,executionId:started.executionId!};
  const allowed=(org:string,patch:Partial<typeof input>={},policy?:typeof t.options)=>db.transact(org,tx=>runtimeAuthorityAllows(tx,{...input,...patch},true,policy));
  expect(await allowed(t.org)).toBe(false);
  expect(await allowed(t.org,{},t.options)).toBe(true);
  expect(await allowed(t.org,{channelId:otherTenant.channel},t.options)).toBe(false);
  expect(await allowed(otherTenant.org,{},t.options)).toBe(false);
  await db.database.pool.query('update whatsapp_group_catalog_items set selected=false where organization_id=$1 and channel_id=$2 and group_jid=$3',[t.org,t.channel,group]);
  expect(await allowed(t.org,{},t.options)).toBe(false);
});
it('selection alone creates neither group automation permission nor a second executor job',async()=>{
  const t=await fixture();const result=await t.ingest('/iniciar');
  expect(result.executionId).toBeNull();expect(result.reason).toBe('GROUP_NOT_ENABLED');
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_executions WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_bot_jobs WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
});
it('the canonical individual journey retains its contact and does not acquire the group initiator notice',async()=>{
  const t=await fixture(),repository=createPostgresAutomationRepository(t.options),messaging=createPostgresMessagingRepository();
  const router=createEventRouter({transact:db.transact,repository,messaging,enabled:true});
  const routed=await router.route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:'individual-control',text:'Individual conversation'});
  expect(routed.execution).toBeTruthy();expect(await t.runtime.executeOnce(t.org)).toMatchObject({status:'WAITING'});
  const texts=(await db.database.pool.query(`SELECT payload->>'text' AS text FROM automation_outbox WHERE organization_id=$1 ORDER BY ordinal`,[t.org])).rows.map(row=>row.text);
  expect(texts).toEqual(['Bem-vindo ao grupo','Escolha\n1 - Resposta']);
  expect((await db.database.pool.query('SELECT recipient_kind,contact_id FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0])
    .toMatchObject({recipient_kind:'INDIVIDUAL',contact_id:expect.any(String)});
});
it('the individual messaging claim cannot lease a GROUP destination or map it to a phone',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
  expect(await db.transact(t.org,tx=>createPostgresMessagingRepository().claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:1000,limit:5}))).toEqual([]);
  expect((await db.database.pool.query('SELECT lease_token FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toEqual([{lease_token:null}]);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:true,status:'SENT'});
});
it('the generic automation effect dispatcher cannot lease a GROUP effect while the GROUP wrapper can',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);
  const repository=createPostgresAutomationRepository(t.options);
  expect(await db.transact(t.org,tx=>repository.claimOutbox(tx,t.org,randomUUID(),1000,['SEND_TEXT']))).toBeNull();
  expect(await t.runtime.enqueueEffectsOnce(t.org)).toMatchObject({processed:true});
  expect((await db.database.pool.query("SELECT status FROM automation_outbox WHERE organization_id=$1 ORDER BY ordinal LIMIT 1",[t.org])).rows[0]).toEqual({status:'SENT'});
});
it('runs start/menu/response through canonical engine state and outboxes after worker replacement',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);
  const first=await t.ingest('/iniciar','start-id');expect(first.executionId).toBeTruthy();
  expect(await t.runtime.executeOnce(t.org)).toMatchObject({processed:true,status:'WAITING'});await drain(t);
  expect(t.sends.map(s=>s.text)).toEqual(['Este atendimento segue somente as respostas de quem iniciou. Outros participantes não avançam o menu.','Bem-vindo ao grupo','Escolha\n1 - Resposta']);
  expect(t.sends.every(s=>s.groupJid===group)).toBe(true);
  const replacement=createGroupAutomationRuntime(t.options);
  await db.transact(t.org,tx=>replacement.ingestWithinTransaction(tx,t.org,t.channel,normalizeQrEvent({instance:t.instance,event:'messages.upsert',data:{key:{id:'reply-id',remoteJid:group,fromMe:false,participant:author},message:{conversation:'1'},messageTimestamp:Math.floor(Date.now()/1000)}},t.instance)[0] as never));
  expect(await replacement.executeOnce(t.org)).toMatchObject({status:'COMPLETED'});await drain(t);
  expect(t.sends.at(-1)!.text).toBe('Resposta do fluxo');
  const view=await t.runtime.view(t.principal,t.channel,group);
  expect(view).toMatchObject({recipient:{kind:'GROUP',groupJid:group},contact:null,sessionPolicy:'INITIATOR_ONLY',initiatorJid:author});
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_executions WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_contacts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
});
it('another participant cannot advance the menu or open a competing live group session',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);
  const before=(await db.database.pool.query('SELECT state,input,attempts FROM automation_executions WHERE organization_id=$1',[t.org])).rows[0]!;
  expect(await t.ingest('1','other-reply',other)).toMatchObject({executionId:null,reason:'GROUP_OTHER_PARTICIPANT'});
  expect(await t.ingest('/iniciar','other-start',other)).toMatchObject({executionId:null,reason:'GROUP_OTHER_PARTICIPANT'});
  expect(await t.runtime.executeOnce(t.org)).toMatchObject({processed:false});
  expect((await db.database.pool.query('SELECT state,input,attempts FROM automation_executions WHERE organization_id=$1',[t.org])).rows[0]).toEqual(before);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_transport_facts WHERE organization_id=$1 AND participant_jid=$2',[t.org,other])).rows[0]!.n).toBe(2);
});
it('deduplicates ingress durably before webhook ACK and never schedules a legacy bot job',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);
  const first=await t.ingest('/iniciar','same-id');expect(first.duplicate).toBe(false);
  const duplicate=await t.ingest('/iniciar','same-id');expect(duplicate.duplicate).toBe(true);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_transport_facts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_bot_jobs WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
});
it('diagnoses unsupported GROUP nodes before opt-in, preserving their individual published version',async()=>{
  const t=await fixture();const unsupported={...graph,nodes:graph.nodes.map(n=>n.id==='answer'?node('answer','input',{text:'Nome?',variable:'nome'}):n)};
  await db.database.pool.query('UPDATE automation_versions SET graph=$3 WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation,JSON.stringify(unsupported)]);
  await expect(t.runtime.configure(t.principal,t.channel,t.input)).rejects.toMatchObject({code:'GROUP_NODE_UNSUPPORTED',diagnostics:[{nodeId:'answer',type:'input'}]});
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  expect((await db.database.pool.query('SELECT graph FROM automation_versions WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation])).rows[0]!.graph).toEqual(unsupported);
});
it('marks dispatch before I/O and preserves UNKNOWN after replacement without a second POST',async()=>{
  let sends=0;let t:Awaited<ReturnType<typeof fixture>>;
  t=await fixture({sendText:async()=>{
    sends++;expect((await db.database.pool.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[t.org])).rows[0]!.state).toBe('DISPATCHED');
    throw Object.assign(new Error('QR_SEND_UNKNOWN'),{code:'QR_SEND_UNKNOWN'});
  }});
  await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);
  for(let i=0;i<4;i++)await t.runtime.enqueueEffectsOnce(t.org);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:true,status:'UNKNOWN'});
  const replacement=createGroupAutomationRuntime(t.options);expect(await replacement.dispatchOnce(t.org)).toMatchObject({processed:false});
  expect(sends).toBe(1);
  expect((await db.database.pool.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[t.org])).rows[0]!.state).toBe('UNKNOWN');
  expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_messages WHERE organization_id=$1 AND state='UNKNOWN'",[t.org])).rows[0]!.n).toBe(1);
  expect(await replacement.view(t.principal,t.channel,group)).toMatchObject({automaticResend:false});
});
it('revalidates opt-in after identity I/O, never sending a now-unselected group',async()=>{
  let t:Awaited<ReturnType<typeof fixture>>,revoke=false,sends=0;
  t=await fixture({readIdentity:async()=>{
    if(revoke)await db.database.pool.query('UPDATE whatsapp_group_catalog_items SET selected=false WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3',[t.org,t.channel,group]);
    return{connected:true,phone,groupsIgnore:false};
  },sendText:async()=>{sends++;return{upstreamMessageId:'must-not-send'};}});
  await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
  revoke=true;await t.runtime.dispatchOnce(t.org);expect(sends).toBe(0);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
});
it('pauses an external device fact without claiming a human or creating a send outbox',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);
  const before=t.sends.length;await t.ingest('Resposta no aparelho','device-output',author,true);
  const message=(await db.database.pool.query("SELECT source,state FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id='device-output'",[t.org])).rows[0]!;
  expect(message).toMatchObject({source:'EXTERNAL_OBSERVED',state:'SENT'});
  const view=await t.runtime.view(t.principal,t.channel,group);expect(view).toMatchObject({pauseReason:'EXTERNAL_OBSERVED',pauseActorId:null});
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:false});expect(t.sends).toHaveLength(before);
  expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id WHERE m.organization_id=$1 AND m.upstream_message_id='device-output'",[t.org])).rows[0]!.n).toBe(0);
});
it('an explicit human pause records the current nominative actor and stops the same canonical session',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);
  const initial=await t.runtime.view(t.principal,t.channel,group);await t.runtime.pause(t.principal,t.channel,group,initial.revision);
  expect(await t.runtime.view(t.principal,t.channel,group)).toMatchObject({pauseReason:'HUMAN_ACTION',pauseActorId:t.actor});
  expect(await t.ingest('1')).toMatchObject({executionId:null,reason:'GROUP_PAUSED'});
  expect(await t.runtime.executeOnce(t.org)).toMatchObject({processed:false});
});
it('a canonical administrative cancellation closes its GROUP session without creating another executor or replaying old effects',async()=>{
  const t=await fixture(),enabled=await t.runtime.configure(t.principal,t.channel,t.input),started=await t.ingest('/iniciar');
  await t.runtime.executeOnce(t.org);
  const executor=createExecutionService({transact:db.transact,repository:createPostgresAutomationRepository(t.options),messaging:createPostgresMessagingRepository(),enabled:true});
  await executor.cancel(t.org,started.executionId!);await t.runtime.executeOnce(t.org);
  const next=await t.runtime.configure(t.principal,t.channel,{...t.input,expectedRevision:enabled.revision});
  expect(next.revision).toBe(enabled.revision+1);expect(t.sends).toHaveLength(0);
  expect((await db.database.pool.query('SELECT closed_at FROM whatsapp_group_automation_sessions WHERE organization_id=$1',[t.org])).rows[0]!.closed_at).toBeInstanceOf(Date);
  expect((await db.database.pool.query('SELECT status FROM automation_outbox WHERE organization_id=$1',[t.org])).rows.every(row=>row.status==='CANCELED')).toBe(true);
  expect((await t.ingest('/iniciar','after-explicit-canonical-cancel')).executionId).toBeTruthy();
});
for(const terminal of ['CANCELED','COMPLETED'] as const){
  it(`a new administrative activation cannot dispatch already queued text from the previous ${terminal} session`,async()=>{
    const t=await fixture(),enabled=await t.runtime.configure(t.principal,t.channel,t.input),started=await t.ingest('/iniciar');
    await t.runtime.executeOnce(t.org);
    if(terminal==='COMPLETED'){await drain(t);await t.ingest('1','complete-old-session');await t.runtime.executeOnce(t.org);}
    const old=(await t.runtime.enqueueEffectsOnce(t.org)) as {messageId:string};
    if(terminal==='CANCELED'){
      await createExecutionService({transact:db.transact,repository:createPostgresAutomationRepository(t.options),messaging:createPostgresMessagingRepository(),enabled:true}).cancel(t.org,started.executionId!);
      await t.runtime.executeOnce(t.org);
    }
    await t.runtime.configure(t.principal,t.channel,{...t.input,expectedRevision:enabled.revision});
    const before=t.sends.length;expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:true,status:'FAILED'});expect(t.sends).toHaveLength(before);
    expect((await db.database.pool.query('SELECT state,canonical_error_code FROM messaging_messages WHERE id=$1',[old.messageId])).rows[0])
      .toEqual({state:'FAILED',canonical_error_code:'GROUP_EFFECT_AUTHORITY_REVOKED'});
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1 AND message_id=$2',[t.org,old.messageId])).rows[0]!.n).toBe(0);
    await t.ingest('/iniciar','start-new-activation');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
    expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:true,status:'SENT'});expect(t.sends).toHaveLength(before+1);
  });
}
it('a new activation does not admit or spend quota on still-unmapped effects of the previous completed session',async()=>{
  const t=await fixture(),enabled=await t.runtime.configure(t.principal,t.channel,t.input);
  await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await t.ingest('1');await t.runtime.executeOnce(t.org);
  await t.runtime.configure(t.principal,t.channel,{...t.input,expectedRevision:enabled.revision});
  expect(await t.runtime.enqueueEffectsOnce(t.org)).toMatchObject({processed:false});
  expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_messages WHERE organization_id=$1 AND direction='OUTGOING'",[t.org])).rows[0]!.n).toBe(0);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  expect((await db.database.pool.query('SELECT status FROM automation_outbox WHERE organization_id=$1',[t.org])).rows.every(row=>row.status==='CANCELED')).toBe(true);
  expect(t.sends).toHaveLength(0);
});
it('revalidates the originating session generation after workspace I/O, before dispatching queued text',async()=>{
  let t:Awaited<ReturnType<typeof fixture>>,replace=false,revision=0;
  t=await fixture({readIdentity:async()=>{if(replace){replace=false;await t.runtime.configure(t.principal,t.channel,{...t.input,expectedRevision:revision});}return{connected:true,phone,groupsIgnore:false};}});
  revision=(await t.runtime.configure(t.principal,t.channel,t.input)).revision;
  await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);await t.ingest('1');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
  const count=t.sends.length;replace=true;expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:false});expect(t.sends).toHaveLength(count);
  await db.database.pool.query('UPDATE messaging_outbox SET available_at=clock_timestamp() WHERE organization_id=$1',[t.org]);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:true,status:'FAILED'});expect(t.sends).toHaveLength(count);
});
it('preserves identified pre-activation history without starting or pausing a group session',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);
  for(const fromMe of [false,true]){
    const event={...t.event('/iniciar',`historic-${fromMe}`,author,fromMe),occurredAt:new Date(Date.now()-10000)};
    expect(await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,event as never)))
      .toMatchObject({executionId:null,reason:'GROUP_BEFORE_ACTIVATION'});
  }
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_executions WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_outbound_observations WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_transport_facts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(2);
  expect(await t.runtime.view(t.principal,t.channel,group)).toMatchObject({pauseReason:null});
});
it('a reply provably before the current session watermark cannot advance the numeric menu',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);
  await db.database.pool.query("UPDATE whatsapp_group_automation_controls SET activated_at=clock_timestamp()-interval '1 minute' WHERE organization_id=$1",[t.org]);
  const event={...t.event('1','pre-session-reply'),occurredAt:new Date(Date.now()-10000)};
  expect(await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,event as never))).toMatchObject({executionId:null,reason:'GROUP_BEFORE_SESSION'});
  expect(await t.runtime.executeOnce(t.org)).toMatchObject({processed:false});
});
it('scopes equal provider IDs to the real group conversation, never another group or individual contact',async()=>{
  const t=await fixture();const second='120363999000002@g.us';
  await db.database.pool.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count,announce,is_community,is_community_announce,selected)
    VALUES($1,$2,$3,'Second group',2,false,false,false,true)`,[t.org,t.channel,second]);
  await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
  await t.runtime.configure(t.principal,t.channel,t.input);await t.runtime.configure(t.principal,t.channel,{...t.input,groupJid:second});
  await t.ingest('/iniciar','equal-id');
  const event={...t.event('/iniciar','equal-id'),groupJid:second};
  expect(await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,event as never))).toMatchObject({duplicate:false,executionId:expect.any(String)});
  expect((await db.database.pool.query("SELECT count(DISTINCT conversation_id)::int AS n FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id='equal-id'",[t.org])).rows[0]!.n).toBe(2);
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_contacts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
});
it('reapplies scoped READ received before a fromMe observation materializes the external group fact',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);
  await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,{kind:'group-status',groupJid:group,upstreamMessageId:'early-read',state:'READ'}));
  await t.ingest('Device reply','early-read',author,true);
  expect((await db.database.pool.query("SELECT state,source FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id='early-read'",[t.org])).rows[0]).toMatchObject({state:'READ',source:'EXTERNAL_OBSERVED'});
});
it('a late observed ID from an earlier identity remains reconciliable without inventing a Broker echo or external actor',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);
  await db.database.pool.query('UPDATE whatsapp_group_catalogs SET identity_revision=2 WHERE organization_id=$1',[t.org]);
  await t.ingest('Device fact','provider-1',author,true);
  expect((await db.database.pool.query("SELECT disposition FROM whatsapp_group_transport_facts WHERE organization_id=$1 AND provider_message_id='provider-1'",[t.org])).rows[0]!.disposition).toBe('RECONCILE');
  expect((await db.database.pool.query("SELECT reason FROM qr_outbound_observations WHERE organization_id=$1 AND provider_message_id='provider-1'",[t.org])).rows[0]!.reason).toBe('QR_GROUP_IDENTITY_RECONCILE');
});
it('cannot assign a callback to the new identity when the same group/provider ID is known in an earlier epoch',async()=>{
  const t=await fixture({sendText:async()=>({upstreamMessageId:'same-id-two-epochs'})});
  const oldConversation=(await db.database.pool.query(`INSERT INTO messaging_conversations(organization_id,channel_id,recipient_kind,group_jid,contact_id)
    VALUES($1,$2,'GROUP',$3,NULL) RETURNING id`,[t.org,t.channel,group])).rows[0]!.id;
  await db.transact(t.org,tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id)
    VALUES($1,$2,$3,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic old identity receipt"}','SENT','same-id-two-epochs')`,[t.org,t.channel,oldConversation]));
  await db.database.pool.query('UPDATE whatsapp_group_catalogs SET identity_revision=2 WHERE organization_id=$1',[t.org]);
  await db.database.pool.query('UPDATE whatsapp_group_webhook_operations SET identity_revision=2,expected_identity_revision=2 WHERE organization_id=$1',[t.org]);
  await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
  await t.runtime.configure(t.principal,t.channel,{...t.input,expectedIdentityRevision:2});await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({status:'SENT'});
  const result=await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,{kind:'group-status',groupJid:group,upstreamMessageId:'same-id-two-epochs',state:'READ'}));
  expect(result.reason).toBe('GROUP_STATUS_IDENTITY_AMBIGUOUS');
  expect((await db.database.pool.query("SELECT state FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id='same-id-two-epochs' AND provider_scope=$2",[t.org,`g3:${group}:2`])).rows[0]!.state).toBe('SENT');
  await t.ingest('Synthetic late observed fact','same-id-two-epochs',author,true);
  expect((await db.database.pool.query("SELECT disposition,blocking,reason FROM qr_outbound_observations WHERE organization_id=$1 AND provider_message_id='same-id-two-epochs'",[t.org])).rows[0])
    .toEqual({disposition:'RECONCILE',blocking:false,reason:'QR_GROUP_IDENTITY_RECONCILE'});
  expect(await t.runtime.view(t.principal,t.channel,group)).toMatchObject({pauseReason:null});
});
it('an ambiguous cross-epoch observed ID does not clear a current UNKNOWN attempt or authorize another POST',async()=>{
  let posts=0;const t=await fixture({sendText:async()=>{posts++;throw new Error('QR_SEND_UNKNOWN');}});
  const conv=(await db.database.pool.query(`INSERT INTO messaging_conversations(organization_id,channel_id,recipient_kind,group_jid,contact_id) VALUES($1,$2,'GROUP',$3,NULL) RETURNING id`,[t.org,t.channel,group])).rows[0]!.id;
  await db.transact(t.org,tx=>tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id)
    VALUES($1,$2,$3,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic old identity"}','SENT','ambiguous-old-id')`,[t.org,t.channel,conv]));
  await db.database.pool.query('UPDATE whatsapp_group_catalogs SET identity_revision=2 WHERE organization_id=$1',[t.org]);
  await db.database.pool.query('UPDATE whatsapp_group_webhook_operations SET identity_revision=2,expected_identity_revision=2 WHERE organization_id=$1',[t.org]);
  await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
  await t.runtime.configure(t.principal,t.channel,{...t.input,expectedIdentityRevision:2});await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);for(let n=0;n<3;n++)await t.runtime.enqueueEffectsOnce(t.org);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({status:'UNKNOWN'});await t.ingest('Unproven old identity callback','ambiguous-old-id',author,true);
  expect((await db.database.pool.query("SELECT disposition,blocking,reason FROM qr_outbound_observations WHERE organization_id=$1 AND provider_message_id='ambiguous-old-id'",[t.org])).rows[0])
    .toEqual({disposition:'RECONCILE',blocking:true,reason:'QR_GROUP_IDENTITY_RECONCILE'});
  expect((await db.database.pool.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'UNKNOWN'}]);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:false});expect(posts).toBe(1);
});
for(const mutation of ['OWN_REMOVE','OWNER_HUMAN','VERSION','IDENTITY','RUNTIME_READY','GROUPS_IGNORE','SUSPENDED','INSTANCE_CHANGED'] as const){
  it(`revalidates ${mutation} after workspace I/O and before durable physical dispatch`,async()=>{
    let t:Awaited<ReturnType<typeof fixture>>,revoke=false,ready=true,posts=0;
    t=await fixture({runtimeReady:async()=>ready,readIdentity:async()=>{
      if(revoke){
        if(mutation==='OWN_REMOVE')await db.transact(t.org,tx=>createWhatsAppGroupEvents({encryptionKey:key}).ingest(tx,t.org,t.channel,[{kind:'group-participants',action:'REMOVE',groupJid:group,senderJid:`${phone}@s.whatsapp.net`,authorJid:other,participants:[`${phone}@s.whatsapp.net`],providerEmittedAt:new Date().toISOString(),metadata:{}}] as never));
        if(mutation==='OWNER_HUMAN')await db.database.pool.query("UPDATE attendance_owners SET revision=revision+1,executor='NONE',automation_id=NULL,version=NULL WHERE organization_id=$1 AND channel_id=$2",[t.org,t.channel]);
        if(mutation==='VERSION')await db.database.pool.query("UPDATE automation_definitions SET lifecycle_status='ARCHIVED' WHERE organization_id=$1 AND id=$2",[t.org,t.automation]);
        if(mutation==='IDENTITY')await db.database.pool.query('UPDATE whatsapp_group_catalogs SET identity_revision=identity_revision+1 WHERE organization_id=$1',[t.org]);
        if(mutation==='RUNTIME_READY')ready=false;
        if(mutation==='SUSPENDED')await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[t.org]);
        if(mutation==='INSTANCE_CHANGED')await db.database.pool.query("UPDATE instances SET upstream_instance_key='different-instance' WHERE id=$1",[t.instance]);
      }
      return{connected:true,phone,groupsIgnore:revoke&&mutation==='GROUPS_IGNORE'?true:false};
    },sendText:async()=>{posts++;return{upstreamMessageId:'must-not-send'};}});
    await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
    revoke=true;await t.runtime.dispatchOnce(t.org);expect(posts).toBe(0);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  });
}
it('rejects a confirmed webhook ledger whose server configuration binding is stale before group activation',async()=>{
  const t=await fixture();await db.database.pool.query("UPDATE whatsapp_group_webhook_operations SET binding_fingerprint=$2 WHERE organization_id=$1",[t.org,'b'.repeat(64)]);
  await expect(t.runtime.configure(t.principal,t.channel,t.input)).rejects.toMatchObject({code:'GROUP_WEBHOOK_CHANGED'});
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
});
it('does not activate using a workspace observation whose deadline expired while waiting for the channel lock',async()=>{
  let t:Awaited<ReturnType<typeof fixture>>,locked!:()=>void,release!:()=>void;
  const hasLock=new Promise<void>(resolve=>{locked=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  let blocker:Promise<void>|undefined;
  t=await fixture({requestTimeoutMs:150,readIdentity:async()=>{
    blocker=(async()=>{const conn=await db.database.pool.connect();try{await conn.query('BEGIN');await conn.query('SELECT id FROM messaging_channels WHERE id=$1 FOR UPDATE',[t.channel]);locked();await released;await conn.query('COMMIT');}finally{conn.release();}})();
    await hasLock;return{connected:true,phone,groupsIgnore:false};
  }});
  const configuring=t.runtime.configure(t.principal,t.channel,t.input);const failed=expect(configuring).rejects.toMatchObject({code:'GROUP_RUNTIME_UNAVAILABLE'});
  await hasLock;await new Promise(resolve=>setTimeout(resolve,300));release();await blocker;await failed;
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
});
it('a paused group head cannot starve another authorized selected group in the same channel',async()=>{
  const t=await fixture(),second='120363999000003@g.us';
  await db.database.pool.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count,announce,is_community,is_community_announce,selected)
    VALUES($1,$2,$3,'Fairness group',2,false,false,false,true)`,[t.org,t.channel,second]);
  await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
  await t.runtime.configure(t.principal,t.channel,t.input);await t.runtime.configure(t.principal,t.channel,{...t.input,groupJid:second});
  await t.ingest('/iniciar','head-a');await t.runtime.executeOnce(t.org);for(let n=0;n<3;n++)await t.runtime.enqueueEffectsOnce(t.org);
  await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,{...t.event('/iniciar','head-b'),groupJid:second} as never));
  await t.runtime.executeOnce(t.org);for(let n=0;n<3;n++)await t.runtime.enqueueEffectsOnce(t.org);
  const view=await t.runtime.view(t.principal,t.channel,group);await t.runtime.pause(t.principal,t.channel,group,view.revision);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:true,status:'SENT'});
  expect(t.sends).toHaveLength(1);expect(t.sends[0]!.groupJid).toBe(second);
});
it('explicit current-attempt abandonment keeps UNKNOWN factual and releases only following effects after resume, never the old POST',async()=>{
  let posts=0;const t=await fixture({sendText:async()=>{posts++;throw new Error('QR_SEND_UNKNOWN');}});
  await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);for(let n=0;n<3;n++)await t.runtime.enqueueEffectsOnce(t.org);
  await t.runtime.dispatchOnce(t.org);const view=await t.runtime.view(t.principal,t.channel,group),attempt=view.attempts[0]!;
  await t.runtime.pause(t.principal,t.channel,group,view.revision);
  const paused=await t.runtime.view(t.principal,t.channel,group);
  await expect(t.runtime.resume(t.principal,t.channel,group,paused.revision)).rejects.toMatchObject({code:'GROUP_OUTCOME_UNKNOWN'});
  await t.runtime.abandonAttempt(t.principal,t.channel,group,attempt.id,{expectedRevision:attempt.revision,reason:'Synthetic explicit abandonment; receipt cannot be proven'});
  await t.runtime.resume(t.principal,t.channel,group,paused.revision);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:true,status:'UNKNOWN'});expect(posts).toBe(2);
  expect((await db.database.pool.query('SELECT state FROM messaging_messages WHERE organization_id=$1 AND id=$2',[t.org,attempt.messageId])).rows[0]!.state).toBe('UNKNOWN');
  expect((await db.database.pool.query('SELECT attempt_count FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2',[t.org,attempt.messageId])).rows).toHaveLength(0);
});
it('combines the canonical PG ledger with the real GROUP HTTP adapter and exact receipt validation',async()=>{
  const posts:Array<{number:string;text:string}>=[];let t:Awaited<ReturnType<typeof fixture>>;
  t=await fixture({sendText:async(ctx,instance,recipient,text)=>createEvolutionGroupTextSender({baseUrl:'https://synthetic.example.test/',apiKey:'synthetic-only',instanceKey:instance,
    fetch:async(_url,init)=>{
      expect((await db.database.pool.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1',[t.org])).rows[0]!.state).toBe('DISPATCHED');
      posts.push(JSON.parse(String(init!.body)));return Response.json({key:{id:`actual-port-${posts.length}`,remoteJid:group,fromMe:true}});
    }}).sendText(ctx,recipient,text)});
  await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);
  expect(posts).toHaveLength(3);expect(posts.every(post=>post.number===group)).toBe(true);
  expect((await db.database.pool.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'CONFIRMED'},{state:'CONFIRMED'},{state:'CONFIRMED'}]);
});
it('a post-activation own-number removal remains invalidating after fresh catalog/selection until explicit G3 revalidation',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
  await db.transact(t.org,tx=>createWhatsAppGroupEvents({encryptionKey:key}).ingest(tx,t.org,t.channel,[{kind:'group-participants',action:'REMOVE',groupJid:group,senderJid:`${phone}@s.whatsapp.net`,authorJid:other,participants:[`${phone}@s.whatsapp.net`],providerEmittedAt:new Date().toISOString(),metadata:{}}] as never));
  const snapshot=randomUUID();await db.database.pool.query(`UPDATE whatsapp_group_catalogs SET last_error_code=NULL,snapshot_id=$2,observed_at=clock_timestamp(),valid_until=clock_timestamp()+interval '5 minutes' WHERE organization_id=$1`,[t.org,snapshot]);
  await db.database.pool.query('UPDATE whatsapp_group_catalog_items SET selected=true WHERE organization_id=$1',[t.org]);
  await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:false});expect(t.sends).toHaveLength(0);
});
it('persists exact Broker echo classification in the group facts when the echo and READ arrive before HTTP ACK',async()=>{
  let t:Awaited<ReturnType<typeof fixture>>;t=await fixture({sendText:async(_ctx,_key,_recipient,text)=>{
    await t.ingest(text,'echo-before-ack',author,true);
    await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,{kind:'group-status',groupJid:group,upstreamMessageId:'echo-before-ack',state:'READ'}));
    return{upstreamMessageId:'echo-before-ack'};
  }});
  await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await t.runtime.enqueueEffectsOnce(t.org);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({status:'SENT'});
  expect((await db.database.pool.query("SELECT disposition FROM whatsapp_group_transport_facts WHERE organization_id=$1 AND provider_message_id='echo-before-ack'",[t.org])).rows[0]!.disposition).toBe('BROKER_ECHO');
  expect((await db.database.pool.query("SELECT state,source FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id='echo-before-ack'",[t.org])).rows[0]).toEqual({state:'READ',source:'AUTOMATION'});
  expect(await t.runtime.view(t.principal,t.channel,group)).toMatchObject({pauseReason:null});
});
it('makes a session initiator and destination immutable under the tenant DB role',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');
  await expect(db.transact(t.org,tx=>tx.query('UPDATE whatsapp_group_automation_sessions SET initiator_jid=$2 WHERE organization_id=$1',[t.org,other]))).rejects.toMatchObject({code:'23514'});
  expect((await db.database.pool.query('SELECT initiator_jid FROM whatsapp_group_automation_sessions WHERE organization_id=$1',[t.org])).rows[0]!.initiator_jid).toBe(author);
});
it('cannot attach a GROUP session to an individual execution or a factual row to a different real group',async()=>{
  const t=await fixture(),enabled=await t.runtime.configure(t.principal,t.channel,t.input);
  const router=createEventRouter({transact:db.transact,repository:createPostgresAutomationRepository(t.options),messaging:createPostgresMessagingRepository(),enabled:true});
  const routed=await router.route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:'different-execution-scope',text:'Individual'});
  await expect(db.transact(t.org,tx=>tx.query(`INSERT INTO whatsapp_group_automation_sessions(organization_id,execution_id,channel_id,conversation_id,group_jid,initiator_jid,identity_revision,identity_fingerprint,control_revision,activation_revision,closed_at)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,1,clock_timestamp())`,[t.org,routed.execution!.id,t.channel,enabled.conversationId,group,author,t.input.expectedIdentityFingerprint,enabled.revision]))).rejects.toMatchObject({code:'23503'});
  await expect(db.transact(t.org,tx=>tx.query(`INSERT INTO whatsapp_group_transport_facts(organization_id,channel_id,conversation_id,group_jid,identity_revision,identity_fingerprint,provider_message_id,from_me,participant_jid,content,occurred_at)
    VALUES($1,$2,$3,'120363999000099@g.us',1,$4,'wrong-group',false,$5,'{"type":"TEXT","text":"Synthetic"}',clock_timestamp())`,[t.org,t.channel,enabled.conversationId,t.input.expectedIdentityFingerprint,author]))).rejects.toMatchObject({code:'23503'});
});
for(const kind of ['CHANNEL','ORGANIZATION'] as const){
  it(`purges the real completed GROUP tree safely through the ${kind} lifecycle role`,async()=>{
    const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);await drain(t);await t.ingest('1');await t.runtime.executeOnce(t.org);await drain(t);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_automation_sessions WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_executions WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(1);
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_transport_facts WHERE organization_id=$1',[t.org])).rows[0]!.n).toBeGreaterThan(0);
    const actor=kind==='CHANNEL'?t.actor:randomUUID();
    if(kind==='ORGANIZATION')await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic','SUPER_ADMIN','synthetic')",[actor,`${actor}@example.test`]);
    const platform=new Pool({connectionString:roleUrl(db.database.connectionString,'jrc_platform')});let deletion:string;
    try{deletion=(kind==='CHANNEL'?await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id',[t.org,t.instance,'Synthetic group','Synthetic completed G3 purge','TENANT',actor])
      :await platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4) AS id',[t.org,'Attendance','Synthetic completed G3 purge',actor])).rows[0]!.id;}finally{await platform.end();}
    const lease=randomUUID();await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1",[deletion]);
    await db.database.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[deletion,lease]);
    const worker=new Pool({connectionString:roleUrl(db.database.connectionString,'jrc_lifecycle')});
    try{await worker.query(kind==='CHANNEL'?'SELECT lifecycle_purge_channel($1,$2)':'SELECT lifecycle_purge_organization($1,$2)',[deletion,lease]);}finally{await worker.end();}
    expect((await db.database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1',[deletion])).rows[0]!.status).toBe('COMPLETED');
    for(const table of ['whatsapp_group_transport_facts','whatsapp_group_automation_sessions','whatsapp_group_automation_controls','messaging_messages','automation_executions'])
      expect((await db.database.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`,[t.org])).rows[0]!.n).toBe(0);
  });
}
for(const lock of ['BINDING','OWNER','CATALOG','CONTROL'] as const){
  it(`checks activation deadline after waiting for ${lock} lock before changing control`,async()=>{
    let t:Awaited<ReturnType<typeof fixture>>,blocked=false,entered!:()=>void,released!:()=>void;
    const hasLock=new Promise<void>(resolve=>{entered=resolve;}),releaseLock=new Promise<void>(resolve=>{released=resolve;});
    let blocker:Promise<void>|undefined;
    t=await fixture({requestTimeoutMs:200,readIdentity:async()=>{
      if(blocked){blocker=(async()=>{const conn=await db.database.pool.connect();try{await conn.query('BEGIN');
        if(lock==='BINDING')await conn.query('SELECT id FROM automation_bindings WHERE organization_id=$1 FOR UPDATE',[t.org]);
        if(lock==='OWNER')await conn.query('SELECT channel_id FROM attendance_owners WHERE organization_id=$1 FOR UPDATE',[t.org]);
        if(lock==='CATALOG')await conn.query('SELECT channel_id FROM whatsapp_group_catalogs WHERE organization_id=$1 FOR UPDATE',[t.org]);
        if(lock==='CONTROL')await conn.query('SELECT conversation_id FROM whatsapp_group_automation_controls WHERE organization_id=$1 FOR UPDATE',[t.org]);
        entered();await releaseLock;await conn.query('COMMIT');
      }finally{conn.release();}})();await hasLock;}
      return{connected:true,phone,groupsIgnore:false};
    }});
    const existing=lock==='CONTROL'?await t.runtime.configure(t.principal,t.channel,t.input):null;
    blocked=true;const attempt=t.runtime.configure(t.principal,t.channel,{...t.input,...(existing?{expectedRevision:existing.revision}:{})});
    const assertion=expect(attempt).rejects.toMatchObject({code:'GROUP_RUNTIME_UNAVAILABLE'});
    await hasLock;await new Promise(resolve=>setTimeout(resolve,350));released();await blocker;await assertion;
    expect((await db.database.pool.query('SELECT revision FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows).toEqual(existing?[{revision:existing.revision}]:[]);
  });
}
it('does not configure using groupsIgnore observed from a workspace replaced during I/O, even if the new binding and phone are current',async()=>{
  let t:Awaited<ReturnType<typeof fixture>>;
  t=await fixture({readIdentity:async()=>{
    await db.database.pool.query("UPDATE instances SET upstream_instance_key='replacement-workspace' WHERE id=$1",[t.instance]);
    const nextBinding=createHmac('sha256',Buffer.from(key,'base64')).update('whatsapp-group-webhook-binding:v2\0').update(JSON.stringify([configurationScope,t.org,t.channel,t.instance,'replacement-workspace'])).digest('hex');
    await db.database.pool.query('UPDATE whatsapp_group_webhook_operations SET binding_fingerprint=$2 WHERE organization_id=$1',[t.org,nextBinding]);
    return{connected:true,phone,groupsIgnore:false}; // This observation belongs to the captured old workspace.
  }});
  await expect(t.runtime.configure(t.principal,t.channel,t.input)).rejects.toMatchObject({code:'GROUP_WORKSPACE_CHANGED'});
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
});
for(const replacement of ['KEY','INSTANCE'] as const){
  it(`does not resume using a workspace observation from before physical ${replacement} replacement`,async()=>{
    let t:Awaited<ReturnType<typeof fixture>>,replace=false;
    t=await fixture({readIdentity:async()=>{
      if(replace){
        const currentKey=`replacement-resume-${randomUUID()}`,currentInstance=replacement==='INSTANCE'?randomUUID():t.instance;
        if(replacement==='INSTANCE'){
          await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
            SELECT $2,organization_id,provider_account_id,'Replacement synthetic workspace',$3,'CONNECTED' FROM instances WHERE id=$1`,[t.instance,currentInstance,currentKey]);
          await db.database.pool.query('UPDATE messaging_channels SET instance_id=$2 WHERE id=$1',[t.channel,currentInstance]);
        }else await db.database.pool.query('UPDATE instances SET upstream_instance_key=$2 WHERE id=$1',[t.instance,currentKey]);
        const currentBinding=createHmac('sha256',Buffer.from(key,'base64')).update('whatsapp-group-webhook-binding:v2\0')
          .update(JSON.stringify([configurationScope,t.org,t.channel,currentInstance,currentKey])).digest('hex');
        if(replacement==='INSTANCE'){
          // A replacement workspace gets a new operation; the old physical snapshot stays immutable.
          await db.database.pool.query(`INSERT INTO whatsapp_group_webhook_operations
            (organization_id,channel_id,instance_id,actor_id,binding_fingerprint,expected_identity_revision,catalog_revision,identity_revision,identity_fingerprint,phase,observed_at)
            SELECT organization_id,channel_id,$3,$4,$5,identity_revision,catalog_revision,identity_revision,identity_fingerprint,'CONFIRMED',clock_timestamp()
            FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2`,[t.org,t.channel,currentInstance,t.actor,currentBinding]);
        }else await db.database.pool.query('UPDATE whatsapp_group_webhook_operations SET binding_fingerprint=$2 WHERE organization_id=$1 AND channel_id=$3',[t.org,currentBinding,t.channel]);
      }
      return{connected:true,phone,groupsIgnore:false};
    }});
    const enabled=await t.runtime.configure(t.principal,t.channel,t.input),paused=await t.runtime.pause(t.principal,t.channel,group,enabled.revision);
    const priorWebhook=(await db.database.pool.query('SELECT * FROM whatsapp_group_webhook_operations WHERE organization_id=$1 AND channel_id=$2',[t.org,t.channel])).rows[0]!;
    replace=true;await expect(t.runtime.resume(t.principal,t.channel,group,paused.revision)).rejects.toMatchObject({code:'GROUP_WORKSPACE_CHANGED'});
    expect((await db.database.pool.query('SELECT revision,pause_reason FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows[0])
      .toEqual({revision:paused.revision,pause_reason:'HUMAN_ACTION'});
    if(replacement==='INSTANCE'){
      expect((await db.database.pool.query('SELECT * FROM whatsapp_group_webhook_operations WHERE organization_id=$1 AND id=$2',[t.org,priorWebhook.id])).rows).toEqual([priorWebhook]);
      expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_webhook_operations WHERE organization_id=$1 AND channel_id=$2',[t.org,t.channel])).rows).toEqual([{n:2}]);
    }
    expect(t.sends).toEqual([]);
  });
}
for(const quota of ['DAILY','PENDING'] as const){
  it(`keeps GROUP sends under ${quota} admission quota while authenticated external text remains a factual ingress`,async()=>{
    const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);
    await db.database.pool.query('UPDATE organization_limits SET messages_per_day=$2,max_pending_messages=$3 WHERE organization_id=$1',[t.org,quota==='DAILY'?1:1000,quota==='PENDING'?1:1000]);
    const repo=createPostgresMessagingRepository();const filler=await db.transact(t.org,tx=>repo.enqueueOutgoing(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,conversationId:t.conversation,source:'OPERATOR',content:{type:'TEXT',text:'Synthetic quota filler'},idempotencyKey:randomUUID(),bodyHash:'synthetic',policy:{requireOptIn:false}}));
    if(quota==='DAILY'){
      const claim=(await db.transact(t.org,tx=>repo.claimOutgoing(tx,{organizationId:t.org,workerId:randomUUID(),now:new Date(),leaseMs:10000,limit:1})))[0]!;
      expect(await db.transact(t.org,tx=>repo.validateClaim(tx,{organizationId:t.org,messageId:filler.message.id,leaseToken:claim.leaseToken}))).toMatchObject({eligible:true});
      await db.transact(t.org,tx=>repo.completeSend(tx,{organizationId:t.org,messageId:filler.message.id,leaseToken:claim.leaseToken,outcome:{state:'SENT',upstreamMessageId:'quota-filler-id'}}));
    }
    await t.ingest('/iniciar');await t.runtime.executeOnce(t.org);
    const usage=(await db.database.pool.query('SELECT usage_day,accepted_messages FROM organization_message_usage WHERE organization_id=$1',[t.org])).rows;
    await expect(t.runtime.enqueueEffectsOnce(t.org)).rejects.toMatchObject({constraint:quota==='DAILY'?'tenant_daily_limit':'tenant_pending_limit'});
    await t.ingest('Observed device fact','external-quota',author,true);
    expect((await db.database.pool.query("SELECT source,state FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id='external-quota'",[t.org])).rows[0]).toEqual({source:'EXTERNAL_OBSERVED',state:'SENT'});
    expect((await db.database.pool.query('SELECT usage_day,accepted_messages FROM organization_message_usage WHERE organization_id=$1',[t.org])).rows).toEqual(usage);
    expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id WHERE m.organization_id=$1 AND c.recipient_kind='GROUP'",[t.org])).rows[0]!.n).toBe(0);
  });
}
it('SUSPENDED transport ingress preserves factual group history and external pause without bot jobs, AI or new sends',async()=>{
  const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1",[t.org]);
  await t.ingest('/iniciar','suspended-incoming');await t.ingest('Observed suspended fact','suspended-external',author,true);
  expect((await db.database.pool.query('SELECT direction,source FROM messaging_messages WHERE organization_id=$1 ORDER BY sequence_number',[t.org])).rows).toEqual([{direction:'INCOMING',source:'CONTACT'},{direction:'OUTGOING',source:'EXTERNAL_OBSERVED'}]);
  for(const table of ['messaging_outbox','messaging_bot_jobs','automation_executions','automation_outbox','organization_message_usage'])
    expect((await db.database.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`,[t.org])).rows[0]!.n).toBe(0);
  expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({processed:false});expect(t.sends).toHaveLength(0);
});
it('equal group IDs and provider IDs in different tenants never cross facts, sessions or principal authority',async()=>{
  const a=await fixture(),b=await fixture();await a.runtime.configure(a.principal,a.channel,a.input);await b.runtime.configure(b.principal,b.channel,b.input);
  await a.ingest('/iniciar','same-cross-tenant');await b.ingest('/iniciar','same-cross-tenant');
  expect((await db.database.pool.query("SELECT count(DISTINCT organization_id)::int AS n FROM whatsapp_group_transport_facts WHERE provider_message_id='same-cross-tenant'")).rows[0]!.n).toBe(2);
  expect((await db.transact(a.org,tx=>tx.query('SELECT * FROM whatsapp_group_automation_sessions WHERE organization_id=$1',[b.org]))).rows).toHaveLength(0);
  await expect(a.runtime.view({organizationId:a.org,actorId:b.actor},a.channel,group)).rejects.toMatchObject({code:'GROUP_ACCESS_DENIED'});
});
it('equal provider IDs in another QR channel of the same tenant preserve separate factual conversations',async()=>{
  const t=await fixture();await t.ingest('First channel fact','same-cross-channel');
  const next=await db.transact(t.org,async tx=>{
    const instance=(await tx.query<{id:string}>(`INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status)
      SELECT $1,provider_account_id,'Second synthetic channel',$3,'CONNECTED' FROM messaging_channels WHERE id=$2 RETURNING id`,[t.org,t.channel,randomUUID()])).rows[0]!.id;
    return await ensureQrChannel(tx,t.org,instance);
  });
  const fp=createHmac('sha256',Buffer.from(key,'base64')).update(`whatsapp-group-identity:v1:${t.org}:${next.id}:${phone}`).digest('hex');
  await db.database.pool.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id,identity_revision,identity_fingerprint,catalog_revision,snapshot_id,observed_at,valid_until)
    VALUES($1,$2,1,$3,1,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[t.org,next.id,fp,randomUUID()]);
  await db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,next.id,t.event('Second channel fact','same-cross-channel') as never));
  expect((await db.database.pool.query("SELECT count(DISTINCT channel_id)::int AS n FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id='same-cross-channel'",[t.org])).rows[0]!.n).toBe(2);
});
for(const groupsIgnore of [true,null]){
  it(`unknown or ignored group transport (${String(groupsIgnore)}) cannot activate even with selected metadata`,async()=>{
    const t=await fixture({readIdentity:async()=>({connected:true,phone,groupsIgnore})});
    await expect(t.runtime.configure(t.principal,t.channel,t.input)).rejects.toMatchObject({code:'GROUP_TRANSPORT_IGNORED'});
    expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows[0]!.n).toBe(0);
  });
}
