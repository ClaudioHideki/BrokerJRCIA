import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {welcomeFlow} from '@jrc/contracts';
import {runMigrations} from '../../src/db/migrate.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {createPostgresAutomationRepository} from '../../src/modules/automations/repository.js';
import {createAutomationService,createExecutionService} from '../../src/modules/automations/service.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl,type IsolatedPostgresDatabase} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {connectionStringForRole} from './helpers/task7.js';

describe('automation lifecycle with tenant isolation',()=>{
 let db:IsolatedPostgresDatabase,pool:Pool;const a=randomUUID(),b=randomUUID();
 const transact=<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool,org,work);
 const service=createAutomationService({transact}),executions=createExecutionService({transact});
 beforeAll(async()=>{const url=requireTestDatabaseAdminUrl();db=await createIsolatedPostgresDatabase(url);await withGlobalRoleLock(url,()=>runMigrations(db.connectionString));
  const seed=await db.pool.connect();try{await seed.query('begin');await seed.query("insert into organizations(id,name,slug) values($1::uuid,'QA A',$1::text),($2::uuid,'QA B',$2::text)",[a,b]);
 const user=(await seed.query("insert into users(email,password_hash) values($1,'no-login') returning id",[a+'@example.test'])).rows[0];await seed.query("insert into memberships(organization_id,user_id,role) values($1,$3,'OWNER'),($2,$3,'OWNER')",[a,b,user.id]);await seed.query('commit');}finally{seed.release();}
  pool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
 },60000);
 afterAll(async()=>{await pool?.end();await db?.dispose();});
 async function queued(){
  const draft=await service.create(a,{name:'Fila',graph:welcomeFlow()});await service.publish(a,draft.id,1);
  const ids={channel:randomUUID(),instance:randomUUID(),account:randomUUID(),binding:randomUUID(),execution:randomUUID(),outbox:randomUUID()};
  await transact(a,async t=>{
   ids.account=(await t.query<{id:string}>("insert into provider_accounts(id,organization_id,provider,name) values($1,$2,'BAILEYS','QR') on conflict(organization_id,provider) do update set name='QR' returning id",[ids.account,a])).rows[0]!.id;
   await t.query("insert into instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) values($1::uuid,$2,$3,$1::text,$1::text,'DISCONNECTED')",[ids.instance,a,ids.account]);
   await t.query("insert into messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference) values($1,$2,$3,'BAILEYS',$4,'qa')",[ids.channel,a,ids.account,ids.instance]);
   await t.query("insert into automation_bindings(organization_id,id,automation_id,version,channel_id) values($1,$2,$3,1,$4)",[a,ids.binding,draft.id,ids.channel]);
   await t.query("insert into automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,trigger_event_key,correlation_id,status) values($1,$2,$3,1,$4,$5,'qa',$6,'WAITING')",[a,ids.execution,draft.id,ids.binding,ids.channel,randomUUID()]);
   await t.query("insert into automation_waits(organization_id,execution_id,node_id,kind) values($1,$2,'wait','EVENT')",[a,ids.execution]);
   await t.query("insert into automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind) values($1,$2,$3,'send',0,'SEND_TEXT')",[a,ids.outbox,ids.execution]);
  });return {...ids,automation:draft.id};
 }
 it('canceling also stops pending effects, permits archive and blocks retry or resume after archive',async()=>{
  const q=await queued();await expect(service.setArchived(a,q.automation,true)).rejects.toMatchObject({code:'AUTOMATION_HAS_PENDING_WORK'});
  await executions.cancel(a,q.execution);
  expect((await db.pool.query('select status from automation_outbox where id=$1',[q.outbox])).rows[0].status).toBe('CANCELED');
  await service.setArchived(a,q.automation,true);
  await expect(executions.resume(a,q.execution,'after-archive',{})).rejects.toThrow();
 });
 it('refuses cancellation if a claimed effect may already be sent',async()=>{
  const q=await queued();await db.pool.query("update automation_outbox set status='UNKNOWN' where id=$1",[q.outbox]);
  await expect(executions.cancel(a,q.execution)).rejects.toMatchObject({code:'AUTOMATION_EXECUTION_NOT_CANCELABLE'});
  expect((await db.pool.query('select status from automation_executions where id=$1',[q.execution])).rows[0].status).toBe('WAITING');
 });

 it('a concurrent explicit resume cannot resurrect a canceled execution',async()=>{
  const q=await queued(),locker=await db.pool.connect();let resume:Promise<boolean>|undefined;
  try{
   await locker.query('begin');await locker.query("update automation_executions set status='CANCELED' where id=$1",[q.execution]);
   resume=transact(a,tx=>createPostgresAutomationRepository().resumeExecution(tx,{org:a,id:q.execution,eventId:randomUUID(),eventKey:'concurrent-resume',payload:{}}));
   let blocked=false;for(let i=0;i<200;i++){const row=await db.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%automation_executions%'");if(row.rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   expect(blocked).toBe(true);await locker.query('commit');expect(await resume).toBe(false);
   expect((await db.pool.query('select status from automation_executions where id=$1',[q.execution])).rows[0].status).toBe('CANCELED');
  }finally{await locker.query('rollback');locker.release();await resume?.catch(()=>{});}
 });
 it('a due timer never resumes a canceled execution',async()=>{
  const q=await queued();await db.pool.query("update automation_waits set kind='DELAY',wake_at=now()-interval '1 second' where execution_id=$1",[q.execution]);
  await db.pool.query("update automation_executions set status='CANCELED' where id=$1",[q.execution]);
  expect(await executions.releaseDueWaits(a)).toBe(0);
  expect((await db.pool.query('select status from automation_executions where id=$1',[q.execution])).rows[0].status).toBe('CANCELED');
 });

 it('archived inboxes reject execution revival and resuming the attendance bridge',async()=>{
  const q=await queued(),connection=randomUUID();
  await db.pool.query("insert into chatwoot_accounts(organization_id,base_url,status) values($1,'https://qa.example.test','READY') on conflict do nothing",[a]);
  await db.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,name,status) values($1,$2,$3,'QA','DISABLED')",[connection,a,q.channel]);
  await db.pool.query("update automation_executions set status='FAILED' where id=$1",[q.execution]);
  await db.pool.query("update automation_bindings set status='DISABLED' where id=$1",[q.binding]);
  await db.pool.query('update instances set archived_at=now() where id=$1',[q.instance]);
  await expect(executions.retry(a,q.execution)).rejects.toMatchObject({constraint:'instance_archived'});
  await expect(transact(a,t=>t.query("update chatwoot_connections set status='READY' where organization_id=$1 and id=$2",[a,connection]))).rejects.toMatchObject({constraint:'instance_archived'});
 });
 it('a disabled binding is terminal and cannot advertise active without channel ownership',async()=>{
  const q=await queued();const binding=(await service.bindings(a,q.automation)).data[0]!;
  await service.setBindingStatus(a,q.binding,{status:'DISABLED',revision:binding.revision},q.automation);
  await expect(service.setBindingStatus(a,q.binding,{status:'ACTIVE',revision:binding.revision+1},q.automation)).rejects.toMatchObject({code:'AUTOMATION_BINDING_DISABLED'});
 });
 it('archives without deleting draft or published versions and explicitly restores',async()=>{
  const draft=await service.create(a,{name:'Atendimento',graph:welcomeFlow()});await service.publish(a,draft.id,1);
  await expect(service.setArchived(b,draft.id,true)).rejects.toMatchObject({code:'AUTOMATION_NOT_FOUND'});
  await service.setArchived(a,draft.id,true);
  expect(await service.get(a,draft.id)).toMatchObject({lifecycleStatus:'ARCHIVED',activeVersion:1});
  await expect(service.publish(a,draft.id,1)).rejects.toMatchObject({code:'AUTOMATION_ARCHIVED'});
  await expect(service.save(a,draft.id,{name:'Não reabrir',graph:welcomeFlow(),revision:1})).rejects.toMatchObject({code:'AUTOMATION_CHANGED'});
  await expect(service.bind(a,draft.id,{channelId:randomUUID()})).rejects.toMatchObject({code:'AUTOMATION_ARCHIVED'});
  expect((await service.versions(a,draft.id)).data).toHaveLength(1);
  await service.setArchived(a,draft.id,false);
  expect(await service.get(a,draft.id)).toMatchObject({lifecycleStatus:'PUBLISHED'});
  expect((await db.pool.query("select count(*)::int n from audit_logs where organization_id=$1 and resource_id=$2",[a,draft.id])).rows[0].n).toBe(2);
 });
});
