import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { executeAutomation } from '../../src/modules/automations/engine.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { seedAttendanceTenant } from './helpers/attendance.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+port,source,target,port});
const http=node('http','http',{target:'response',url:'https://example.test/read',credentialId:'11111111-1111-4111-8111-111111111111'});
const historical={nodes:[node('start','start'),http,node('parse','json-parse',{source:'response',target:'decoded'}),node('end','end')],
  edges:[edge('start','http'),...['success','client_error','server_error','timeout','unknown'].map(port=>edge('http',port==='success'?'parse':'end',port)),edge('parse','end')]};
const typed={nodes:[node('start','start'),http,node('answer','input',{variable:'answer',text:'Nome?'}),node('end','end')],
  edges:[edge('start','http'),...['success','client_error','server_error','timeout','unknown'].map(port=>edge('http',port==='success'?'answer':'end',port)),edge('answer','end')]};
const message=(text='Olá')=>({text,eventType:'MESSAGE' as const,now:new Date()});
const resume=(output:unknown)=>({text:'',eventType:'RESUME' as const,now:new Date(),payload:{outcome:'success',output}});

it('upgrades existing publications and states as textual, pins new JSON versions and reloads them without coercion',async()=>{
  const admin=requireTestDatabaseAdminUrl(),db=await createIsolatedPostgresDatabase(admin);
  const scratch=resolve('.sessions');await mkdir(scratch,{recursive:true});const folder=await mkdtemp(resolve(scratch,'runtime-version-upgrade-'));
  let pool:Pool|undefined;
  try{
    const migrations=resolve('apps/api/drizzle/migrations');
    const journal=JSON.parse(await readFile(resolve(migrations,'meta/_journal.json'),'utf8'));
    journal.entries=journal.entries.filter((entry:{tag:string})=>Number(entry.tag.slice(0,4))<41);
    await mkdir(resolve(folder,'meta'));await writeFile(resolve(folder,'meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)await copyFile(resolve(migrations,entry.tag+'.sql'),resolve(folder,entry.tag+'.sql'));
    await withGlobalRoleLock(admin,async()=>{
      const client=await db.pool.connect();
      try{await client.query(await readFile('infra/app/postgres/init-roles.sql','utf8'));await client.query('set role jrc_migrator');
        await migrate(drizzle(client),{migrationsFolder:folder,migrationsSchema:'drizzle',migrationsTable:'__drizzle_migrations'});
      }finally{await client.query('reset role');client.release();}
    });
    const t=await seedAttendanceTenant(db,false);
    await db.pool.query('update automation_versions set graph=$2 where automation_id=$1',[t.automation,JSON.stringify(historical)]);
    await db.pool.query("update automation_definitions set active_version=1,lifecycle_status='PUBLISHED',draft_graph=$2 where id=$1",[t.automation,JSON.stringify(historical)]);
    const before=await executeAutomation({automationId:t.automation,version:1,graph:historical},message(),async()=>{throw new Error('No dependency');});
    const oldState={...before.state};delete oldState.runtimeStateVersion;
    const binding=(await db.pool.query('insert into automation_bindings(organization_id,automation_id,version,channel_id) values($1,$2,1,$3) returning id',[t.org,t.automation,t.channel])).rows[0].id;
    const execution=(await db.pool.query(`insert into automation_executions(organization_id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status,state)
      values($1,$2,1,$3,$4,$5,'historical',$5,'WAITING',$6) returning id`,[t.org,t.automation,binding,t.channel,t.conversation,JSON.stringify(oldState)])).rows[0].id;
    await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
    pool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
    const transact=<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pool!,org,work);
    const service=()=>createAutomationService({transact,enabled:true});
    const root=await transact(t.org,tx=>service()._resolveVersion(tx,t.org,t.automation,1));
    expect(root.runtimeStateVersion).toBe(1);
    const saved=(await db.pool.query('select state from automation_executions where id=$1',[execution])).rows[0].state;
    expect(saved).toEqual(oldState);
    const legacyResult=await executeAutomation(root,resume({ok:true}),async()=>{throw new Error('No dependency');},saved);
    expect(legacyResult.state.variables).toMatchObject({response:'{"ok":true}',decoded:'{"ok":true}'});
    await db.pool.query("update automation_executions set status='COMPLETED',state=$2 where id=$1",[execution,JSON.stringify(legacyResult.state)]);
    await db.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);

    const parentGraph={nodes:[node('start','start'),node('call','subflow',{automationId:t.automation,version:1}),node('end','end')],edges:[edge('start','call'),edge('call','end')]};
    const parent=await service().create(t.org,{name:'Typed parent',graph:parentGraph});
    await expect(service().publish(t.org,parent.id,parent.draft.revision)).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_RUNTIME_VERSION_MISMATCH',details:[{nodeId:'call',field:'data.version'}]});
    const draft=await service().save(t.org,t.automation,{name:'Typed data',graph:typed,revision:1});
    const published=await service().publish(t.org,t.automation,draft.draft.revision);expect(published.version).toBe(2);
    expect((await db.pool.query('select version,runtime_state_version from automation_versions where automation_id=$1 order by version',[t.automation])).rows)
      .toEqual([{version:1,runtime_state_version:1},{version:2,runtime_state_version:2}]);
    const typedRoot=await transact(t.org,tx=>service()._resolveVersion(tx,t.org,t.automation,2));
    const first=await executeAutomation(typedRoot,message(),async()=>{throw new Error('No dependency');});
    const output={rows:[{active:false,balance:12.5}],missing:null,reference:'0012'};
    const waiting=await executeAutomation(typedRoot,resume(output),async()=>{throw new Error('No dependency');},first.state);
    const newBinding=(await db.pool.query("insert into automation_bindings(organization_id,automation_id,version,channel_id,status) values($1,$2,2,$3,'DISABLED') returning id",[t.org,t.automation,t.channel])).rows[0].id;
    const current=(await db.pool.query(`insert into automation_executions(organization_id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,status,state)
      values($1,$2,2,$3,$4,$5,'typed',$5,'WAITING',$6) returning id`,[t.org,t.automation,newBinding,t.channel,t.conversation,JSON.stringify(waiting.state)])).rows[0].id;
    const restartedRoot=await transact(t.org,tx=>service()._resolveVersion(tx,t.org,t.automation,2));
    const restartedState=(await db.pool.query('select state from automation_executions where id=$1',[current])).rows[0].state;
    const done=await executeAutomation(restartedRoot,message('Ana'),async()=>{throw new Error('No dependency');},restartedState);
    expect(done.state).toMatchObject({runtimeStateVersion:2,variables:{response:output,answer:'Ana'}});
    await expect(transact(t.org,tx=>tx.query('update automation_versions set runtime_state_version=1 where automation_id=$1 and version=2',[t.automation])))
      .rejects.toMatchObject({code:'42501'});
    await expect(db.pool.query('insert into automation_versions(organization_id,automation_id,version,graph,checksum,runtime_state_version) values($1,$2,99,$3,$4,3)',[t.org,t.automation,JSON.stringify(typed),'a'.repeat(64)]))
      .rejects.toMatchObject({code:'23514',constraint:'automation_versions_runtime_state_version_check'});
  }finally{await pool?.end();await db.dispose();
    if(!resolve(folder).startsWith(scratch+sep))throw new Error('Unsafe test directory');await rm(folder,{recursive:true,force:true});}
},60000);
