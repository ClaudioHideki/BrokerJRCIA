import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {runMigrations} from '../../src/db/migrate.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {createAutomationService,createEventRouter,createExecutionService,createOutboxDispatcher} from '../../src/modules/automations/service.js';
import {createAutomationRuntimeReadiness,recordAutomationHeartbeat} from '../../src/modules/automations/availability.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {AUTOMATION_ORIGIN} from '@jrc/contracts';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl,type IsolatedPostgresDatabase} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {connectionStringForRole} from './helpers/task7.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+'-'+port,source,target,port});
const graph={nodes:[node('start','start'),node('hello','message',{text:'Bem-vindo'}),node('menu','menu',{text:'Escolha',variable:'opcao',options:[{value:'1',label:'Atendimento'},{value:'2',label:'Encerrar'}]}),node('name','input',{text:'Qual seu nome?',variable:'nome'}),node('known','condition',{field:'nome',operator:'present',value:''}),node('thanks','message',{text:'Olá, {{nome}}'}),node('handoff','handoff'),node('end','end')],edges:[edge('start','hello'),edge('hello','menu'),edge('menu','name','option-1'),edge('menu','end','option-2'),edge('name','known'),edge('known','thanks','yes'),edge('known','end','no'),edge('thanks','handoff')]};

describe('native bot persisted journey and runtime pause',()=>{
 let db:IsolatedPostgresDatabase,pool:Pool;const org=randomUUID(),otherOrg=randomUUID();
 const transact=<T>(organization:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,organization,work);
 const service=createAutomationService({transact,enabled:true});
 beforeAll(async()=>{const url=requireTestDatabaseAdminUrl();db=await createIsolatedPostgresDatabase(url);await withGlobalRoleLock(url,()=>runMigrations(db.connectionString));
  const seed=await db.pool.connect();try{await seed.query('begin');
   await seed.query("insert into organizations(id,name,slug) values($1::uuid,'Native bot',$1::text),($2::uuid,'Other bot',$2::text)",[org,otherOrg]);
   const owner=(await seed.query("insert into users(email,password_hash) values($1,'no-login') returning id",[org+'@example.test'])).rows[0];
   await seed.query("insert into memberships(organization_id,user_id,role) values($1,$3,'OWNER'),($2,$3,'OWNER')",[org,otherOrg,owner.id]);
   await seed.query('insert into flow_features(organization_id,enabled) values($1,true),($2,true)',[org,otherOrg]);await seed.query('commit');
  }finally{seed.release();}pool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
 },60000);
 afterAll(async()=>{await pool?.end();await db?.dispose();});
 it('creates, saves, publishes, binds, deduplicates, resumes after worker replacement and hands off once',async()=>{
  const initial=await service.create(org,{name:'Atendimento',graph});
  const draft=await service.save(org,initial.id,{name:'Bot nativo',graph,revision:initial.draft.revision});
  expect(await service.validate(org,draft.id)).toEqual({valid:true,errors:[]});
  const published=await service.publish(org,draft.id,draft.draft.revision);expect(published.version).toBe(1);
  const ids={channel:randomUUID(),instance:randomUUID(),account:randomUUID(),contact:randomUUID(),conversation:randomUUID()};
  await transact(org,async tx=>{
   await tx.query("insert into provider_accounts(id,organization_id,provider,name) values($1,$2,'BAILEYS','Native test')",[ids.account,org]);
   await tx.query("insert into instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) values($1::uuid,$2,$3,$1::text,$1::text,'CONNECTED')",[ids.instance,org,ids.account]);
   await tx.query("insert into messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference) values($1,$2,$3,'BAILEYS',$4,'fixture')",[ids.channel,org,ids.account,ids.instance]);
   await tx.query("insert into messaging_contacts(id,organization_id,external_id) values($1,$2,'synthetic-contact')",[ids.contact,org]);
   await tx.query("insert into messaging_conversations(id,organization_id,channel_id,contact_id) values($1,$2,$3,$4)",[ids.conversation,org,ids.channel,ids.contact]);
  });
  await service.bind(org,draft.id,{channelId:ids.channel});
  const messaging=createPostgresMessagingRepository(),messageId=randomUUID();
  await transact(org,async tx=>{
   await tx.query("update messaging_conversations set mode='BOT',bot_public_id=$3,bot_origin_reference=$4 where organization_id=$1 and id=$2",[org,ids.conversation,draft.id,AUTOMATION_ORIGIN]);
   await messaging.recordIncoming(tx,{id:messageId,organizationId:org,channelId:ids.channel,conversationId:ids.conversation,webhookEventKey:'canonical-native',upstreamMessageId:'canonical-native',content:{type:'TEXT',text:'Olá'}});
  });
  const claimInput={organizationId:org,workerId:randomUUID(),now:new Date(),leaseMs:120000,automationRuntimeEnabled:false};
  expect(await transact(org,tx=>messaging.claimBotTurn(tx,claimInput))).toBeNull();
  expect((await db.pool.query('select status from messaging_bot_jobs where organization_id=$1 and message_id=$2',[org,messageId])).rows[0]?.status).toBe('PENDING');
  await db.pool.query('update flow_features set enabled=false where organization_id=$1',[org]);
  expect(await transact(org,tx=>messaging.claimBotTurn(tx,{...claimInput,automationRuntimeEnabled:true}))).toBeNull();
  await db.pool.query('update flow_features set enabled=true where organization_id=$1',[org]);
  const claimed=await transact(org,tx=>messaging.claimBotTurn(tx,{...claimInput,automationRuntimeEnabled:true}));
  expect(claimed?.message.id).toBe(messageId);
  await transact(org,tx=>messaging.completeBotTurn(tx,{organizationId:org,messageId,leaseToken:claimed!.leaseToken,sessionId:'automation:'+draft.id,texts:[]}));
  await expect(service.get(otherOrg,draft.id)).rejects.toMatchObject({code:'AUTOMATION_NOT_FOUND'});
  const router=createEventRouter({transact,enabled:true}),event={channelId:ids.channel,conversationId:ids.conversation,eventKey:'native-1',text:'Olá'};
  const routed=await router.route(org,event);expect(routed.execution?.id).toBeTruthy();
  expect(await router.route(org,event)).toEqual({duplicate:true,execution:null});
  expect(await createExecutionService({transact,enabled:false}).runOnce(org)).toEqual({processed:false});
  expect(await createExecutionService({transact,enabled:true}).runOnce(org)).toMatchObject({status:'WAITING'});
  await db.pool.query('update flow_features set enabled=false where organization_id=$1',[org]);
  const delivered:Array<{kind:string;text:unknown}>=[];
  const dispatcher=createOutboxDispatcher({transact,enabled:true},{dispatch:async item=>{delivered.push({kind:item.kind,text:item.payload.text});return {kind:'SENT',remoteReference:item.id};}});
  expect(await dispatcher.runOnce(org)).toEqual({processed:false});expect(delivered).toHaveLength(0);
  await db.pool.query('update flow_features set enabled=true where organization_id=$1',[org]);
  for(const [index,text] of ['1','Pessoa de teste'].entries()){
   expect((await router.route(org,{...event,eventKey:`native-${index+2}`,text})).resumed).toBe(true);
   // A fresh service instance models a worker restart; state only comes from PostgreSQL.
   expect(await createExecutionService({transact,enabled:true}).runOnce(org)).toMatchObject({status:index===0?'WAITING':'HANDOFF'});
  }
  while((await dispatcher.runOnce(org)).processed){}
  expect(delivered.filter(item=>item.kind==='SEND_TEXT').map(item=>item.text)).toEqual(['Bem-vindo','Escolha\n1 - Atendimento\n2 - Encerrar','Qual seu nome?','Olá, Pessoa de teste']);
  expect(delivered.filter(item=>item.kind==='HANDOFF')).toHaveLength(1);
  expect(await dispatcher.runOnce(org)).toEqual({processed:false});
  const detail=await createExecutionService({transact}).get(org,routed.execution!.id);
  expect(detail).toMatchObject({status:'HANDOFF',version:1,state:{variables:{nome:'Pessoa de teste',opcao:'1'}}});
 });
 it('uses persisted worker readiness and detects a worker paused by divergent configuration',async()=>{
  const ready=createAutomationRuntimeReadiness({transact,schemaCurrent:async()=>true,probeRedis:async()=>true});
  expect(await ready(org)).toBe(false);
  await transact(org,async tx=>{
   await tx.query('select record_operational_heartbeat($1,$2,$3)',[org,'MESSAGING_WORKER','synthetic-worker']);
   for(const component of ['AUTOMATION_WORKER','AUTOMATION_IO_WORKER','SCHEDULER'] as const)await recordAutomationHeartbeat(tx,org,component,'synthetic-worker',true);
  });
  expect(await ready(org)).toBe(true);
  await transact(org,tx=>recordAutomationHeartbeat(tx,org,'AUTOMATION_IO_WORKER','synthetic-worker',false));
  expect(await ready(org)).toBe(false);
 });
});
