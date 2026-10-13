import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
import {Pool} from 'pg';import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {runMigrations} from '../../src/db/migrate.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl,type IsolatedPostgresDatabase} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {createPostgresInstanceRepository} from '../../src/modules/instances/repository.js';
import {createEvolutionFleetRuntime,createPostgresFleetStore} from '../../src/modules/evolution-fleet/runtime.js';
import {loadEvolutionFleet} from '../../src/modules/evolution-fleet/config.js';
import {registerEvolutionEngines} from '../../src/modules/evolution-fleet/registration.js';
import {createLifecycleService,withLifecyclePlatformTransaction,withLifecycleWorkerTransaction} from '../../src/modules/lifecycle/service.js';
import {createEvolutionCleanupRuntime} from '../../src/modules/evolution-fleet/cleanup.js';
let db:IsolatedPostgresDatabase,app:Pool,platform:Pool,lifecycle:Pool;
const env={EVOLUTION_BASE_URL:'http://legacy:8080',EVOLUTION_API_KEY:'synthetic-legacy-key',QR_WEBHOOK_SIGNING_KEY:'synthetic-legacy-signing-key-32bytes',EVOLUTION_EAST_KEY:'synthetic-east-key',EVOLUTION_EAST_SIGN:'synthetic-east-signing-key-32bytes',EVOLUTION_WEST_KEY:'synthetic-west-key',EVOLUTION_WEST_SIGN:'synthetic-west-signing-key-32bytes',EVOLUTION_ENGINES_JSON:JSON.stringify({east:{baseUrl:'http://east:8080',apiKeyEnv:'EVOLUTION_EAST_KEY',signingKeyEnv:'EVOLUTION_EAST_SIGN',generation:2,sessionBudget:1,operationBudget:1},west:{baseUrl:'http://west:8080',apiKeyEnv:'EVOLUTION_WEST_KEY',signingKeyEnv:'EVOLUTION_WEST_SIGN',generation:9,sessionBudget:1,operationBudget:1}})};
const transact=<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(app,org,work);
const context=(org:string)=>({organizationId:org,requestId:randomUUID(),deadline:new Date(Date.now()+30000),signal:AbortSignal.timeout(30000)});
const roleUrl=(role:string)=>{const u=new URL(db.connectionString);u.username=role;u.password='';return u.toString();};
async function maintenance<T>(work:(tx:any)=>Promise<T>){const c=await db.pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE jrc_migrator');const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function tenant(){const org=randomUUID(),actor=randomUUID(),account=randomUUID();const c=await db.pool.connect();try{await c.query('BEGIN');await c.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)',[org,'Synthetic fleet tenant',org]);await c.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",[actor,`${actor}@example.test`]);await c.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,actor]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}await transact(org,tx=>tx.query("INSERT INTO provider_accounts(id,organization_id,provider,name) VALUES($1,$2,'BAILEYS','Fleet')",[account,org]));return{org,actor,account};}
async function provision(t:Awaited<ReturnType<typeof tenant>>,name='Synthetic fleet instance'){const id=randomUUID(),key=`fleet-${id}`;const created=await transact(t.org,tx=>createPostgresInstanceRepository().insertProvisioning(tx,{id,organizationId:t.org,providerAccountId:t.account,provider:'BAILEYS',name,upstreamInstanceKey:key}));return{...t,id,key,operation:created.operation.id};}
let historical:Awaited<ReturnType<typeof provision>>[],assigned:Awaited<ReturnType<typeof provision>>[]=[];
beforeAll(async()=>{
 const admin=requireTestDatabaseAdminUrl();db=await createIsolatedPostgresDatabase(admin);
 await withGlobalRoleLock(admin,()=>runMigrations(db.connectionString));
 app=new Pool({connectionString:roleUrl('jrc_app'),max:5});platform=new Pool({connectionString:roleUrl('jrc_platform')});lifecycle=new Pool({connectionString:roleUrl('jrc_lifecycle')});historical=[await provision(await tenant()),await provision(await tenant())];
});
afterAll(async()=>{vi.unstubAllGlobals();await app?.end();await platform?.end();await lifecycle?.end();await db?.dispose();});
it('traditional mode preserves more than one session with no quota/registry/engine lease',async()=>{
 const store=createPostgresFleetStore(transact,loadEvolutionFleet({...env,EVOLUTION_ENGINES_JSON:undefined}));for(const h of historical){const b=await store.resolve(h.org,h.key,h.operation);expect(b).toMatchObject({traditional:true,engineId:'legacy'});await store.acquire(b,true,new Date(Date.now()+30000),h.operation);}
 expect((await db.pool.query('SELECT count(*)::int n FROM evolution_io_leases')).rows[0].n).toBe(0);
 await expect(createEvolutionFleetRuntime(env,transact).provider.getStatus(context(historical[0]!.org),{id:historical[0]!.key})).rejects.toMatchObject({code:'EVOLUTION_ENGINE_REGISTRATION_REQUIRED'});
});
it('first maintenance registration atomically pins all historical sessions and operation snapshots',async()=>{
 await maintenance(tx=>registerEvolutionEngines(env,tx,true));const rows=(await db.pool.query('SELECT engine_id,engine_generation FROM provider_operations ORDER BY id')).rows;expect(rows).toHaveLength(2);expect(rows.every(r=>r.engine_id==='legacy'&&Number(r.engine_generation)===1)).toBe(true);
 const runtime=createEvolutionFleetRuntime(env,transact),h=historical[0]!;expect(await runtime.capture(h.org,h.key)).toMatchObject({engineId:'legacy',state:'DRAINING',traditional:false});
 await expect(app.query('SELECT * FROM evolution_engines')).rejects.toMatchObject({code:'42501'});await expect(app.query('SELECT public.evolution_register_engines($1,true)',[JSON.stringify([])])).rejects.toMatchObject({code:'42501'});
});
it('serializes competing provisioning transactions across two tenants without exceeding either engine budget',async()=>{
 const tenants=await Promise.all([tenant(),tenant(),tenant()]);const r=await Promise.allSettled(tenants.map(provision));assigned=r.filter((x):x is PromiseFulfilledResult<Awaited<ReturnType<typeof provision>>>=>x.status==='fulfilled').map(x=>x.value);
 expect(assigned).toHaveLength(2);expect(r.filter(x=>x.status==='rejected')).toHaveLength(1);const load=(await db.pool.query("SELECT engine_id,count(*)::int used FROM evolution_instance_bindings WHERE engine_id<>'legacy' GROUP BY engine_id ORDER BY engine_id")).rows;expect(load).toEqual([{engine_id:'east',used:1},{engine_id:'west',used:1}]);
 expect((await db.pool.query('SELECT count(*)::int n FROM instances')).rows[0].n).toBe(4);
});
it('resolves persistent bindings only within the authenticated tenant, even with another tenant operation ID',async()=>{
 const runtime=createEvolutionFleetRuntime(env,transact),a=assigned[0]!,b=assigned[1]!;await expect(runtime.capture(a.org,b.key)).rejects.toMatchObject({code:'EVOLUTION_ENGINE_BINDING_REQUIRED'});await expect(transact(a.org,tx=>tx.query('SELECT * FROM evolution_resolve_binding($1,$2,$3)',[b.org,b.key,b.operation]))).rejects.toMatchObject({code:'42501'});
 expect((await transact(a.org,tx=>tx.query('SELECT * FROM evolution_instance_bindings'))).rows.every(r=>r.organization_id===a.org)).toBe(true);
});
it('DRAINING serves existing bindings; DISABLED admits reconciliation reads and blocks group catalogs/mutations',async()=>{
 const a=assigned[0]!,store=createPostgresFleetStore(transact,loadEvolutionFleet(env)),b=await store.resolve(a.org,a.key);
 await maintenance(tx=>tx.query("UPDATE evolution_engines SET state='DRAINING' WHERE id=$1",[b.engineId]));const draining=await store.resolve(a.org,a.key);const lease=await store.acquire(draining,true,new Date(Date.now()+30000));await store.settle(lease,true,null);
 await maintenance(tx=>tx.query("UPDATE evolution_engines SET state='DISABLED' WHERE id=$1",[b.engineId]));const calls:string[]=[];const factory=()=>new Proxy({},{get:(_t,p)=>p==='then'?undefined:async()=>{calls.push(String(p));return p==='getStatus'?'DISCONNECTED':[];}}) as any;
 const runtime=createEvolutionFleetRuntime(env,transact,{factories:{provider:factory,groups:factory}});
 expect(await runtime.provider.getStatus(context(a.org),{id:a.key})).toBe('DISCONNECTED');await expect(runtime.provider.disconnect(context(a.org),{id:a.key})).rejects.toMatchObject({code:'EVOLUTION_ENGINE_DISABLED'});await expect(runtime.groups.list(context(a.org),a.key)).rejects.toMatchObject({code:'EVOLUTION_ENGINE_DISABLED'});expect(calls).toEqual(['getStatus']);
 await maintenance(tx=>tx.query("UPDATE evolution_engines SET state='ACTIVE',session_budget=100 WHERE id IN('east','west')"));
});
it('unknown I/O survives runtime restart and a status read never grants permission to repeat the mutation',async()=>{
 const a=await provision(await tenant());const op=(await transact(a.org,tx=>tx.query("INSERT INTO provider_operations(organization_id,instance_id,operation_type) VALUES($1,$2,'DISCONNECT') RETURNING id",[a.org,a.id]))).rows[0].id;
 const mutation=vi.fn(async()=>{throw Object.assign(new Error('synthetic lost response'),{code:'PROVIDER_TIMEOUT',uncertain:true});});const factory=()=>({kind:'BAILEYS',disconnect:mutation,getStatus:async()=> 'DISCONNECTED'}) as any;
 const runtime=createEvolutionFleetRuntime(env,transact,{factories:{provider:factory}}),c={...context(a.org),engineOperationId:op};await expect(runtime.provider.disconnect(c,{id:a.key})).rejects.toMatchObject({uncertain:true});
 const restart=createEvolutionFleetRuntime(env,transact,{factories:{provider:factory}});expect(await restart.provider.getStatus(context(a.org),{id:a.key})).toBe('DISCONNECTED');await expect(restart.provider.disconnect({...context(a.org),engineOperationId:op},{id:a.key})).rejects.toThrow('EVOLUTION_ENGINE_RECONCILIATION_REQUIRED');expect(mutation).toHaveBeenCalledTimes(1);
 const state=(await db.pool.query('SELECT outcome FROM evolution_io_leases WHERE operation_id=$1',[op])).rows[0];expect(state.outcome).toBe('UNKNOWN');
 const backoff=(await db.pool.query('SELECT attempts,next_attempt_at FROM evolution_io_backoff WHERE organization_id=$1',[a.org])).rows[0];expect(backoff.attempts).toBe(1);expect(backoff.next_attempt_at).toBeInstanceOf(Date);
});
it('stale configuration/generation cannot route or sign a callback and never uses the legacy engine',async()=>{
 const a=assigned[0]!,runtime=createEvolutionFleetRuntime(env,transact),snapshot=await runtime.capture(a.org,a.key);const engines=JSON.parse(env.EVOLUTION_ENGINES_JSON);engines[snapshot.engineId].generation++;
 const changed=createEvolutionFleetRuntime({...env,EVOLUTION_ENGINES_JSON:JSON.stringify(engines)},transact);await expect(changed.webhook(a.org,a.key,randomUUID())).rejects.toMatchObject({code:'EVOLUTION_ENGINE_BINDING_CHANGED'});
 await expect(createEvolutionFleetRuntime({...env,EVOLUTION_ENGINES_JSON:undefined},transact).provider.getStatus(context(a.org),{id:a.key})).rejects.toMatchObject({code:'EVOLUTION_ENGINE_UNAVAILABLE'});
});
it('nominated lifecycle cleanup routes by snapshot and retains private engine evidence after instance purge',async()=>{
 await maintenance(async tx=>{if(!(await tx.query('SELECT EXISTS(SELECT 1 FROM evolution_engines) AS registered')).rows[0].registered)await registerEvolutionEngines(env,tx,true);await tx.query("UPDATE evolution_engines SET state='ACTIVE',session_budget=100 WHERE id IN('east','west')");});
 const a=await provision(await tenant());await transact(a.org,tx=>tx.query("UPDATE provider_operations SET status='SUCCEEDED',reconciliation_required=false WHERE id=$1",[a.operation]));await transact(a.org,tx=>tx.query("UPDATE instances SET status='DISCONNECTED' WHERE id=$1",[a.id]));
 const routes:string[]=[];vi.stubGlobal('fetch',async(input:URL|string|Request,init?:RequestInit)=>{routes.push(String(input));if(init?.method==='DELETE')return new Response(JSON.stringify({status:'SUCCESS'}));return new Response('[]');});
 const request=createLifecycleService({transact:work=>withLifecyclePlatformTransaction(platform,work),deprovision:vi.fn()});const deletion=await request.requestChannel(a.org,a.id,'Synthetic fleet instance','Synthetic nominated cleanup','TENANT',a.actor);
 const cleanup=createEvolutionCleanupRuntime(env,work=>withLifecycleWorkerTransaction(lifecycle,work));const worker=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(lifecycle,work),...cleanup,deprovision:async(...args)=>{try{return await cleanup.deprovision(...args);}catch(e){console.error('C3_SYNTHETIC_IO_FAILURE',(e as any).code,(e as Error).message);throw e;}}});expect(await worker.processOne()).toBe(true);expect(await request.status(a.org,a.id,deletion.operationId)).toMatchObject({status:'COMPLETED',errorCode:null});
 const history=(await db.pool.query('SELECT engine_id,status FROM evolution_cleanup_history WHERE deletion_id=$1',[deletion.operationId])).rows;expect(history).toHaveLength(1);expect(history[0].status).toBe('DONE');expect(routes.every(url=>new URL(url).hostname===history[0].engine_id)).toBe(true);
 expect((await db.pool.query('SELECT engine_id FROM evolution_operation_history WHERE operation_id=$1',[a.operation])).rows[0].engine_id).toBe(history[0].engine_id);expect((await db.pool.query('SELECT count(*)::int n FROM instances WHERE id=$1',[a.id])).rows[0].n).toBe(0);vi.unstubAllGlobals();
});

it('QR dispatch proof resolves only its nominated uncertain engine intent after restart',async()=>{
 await maintenance(async tx=>{if(!(await tx.query('SELECT EXISTS(SELECT 1 FROM evolution_engines) AS registered')).rows[0].registered)await registerEvolutionEngines(env,tx,true);await tx.query("UPDATE evolution_engines SET state='ACTIVE',session_budget=100 WHERE id IN('east','west')");});
 const a=await provision(await tenant()),channel=randomUUID(),contact=randomUUID(),conversation=randomUUID(),message=randomUUID(),lease=randomUUID();
 await transact(a.org,async tx=>{
  await tx.query("UPDATE provider_operations SET status='SUCCEEDED',reconciliation_required=false WHERE id=$1",[a.operation]);await tx.query("UPDATE instances SET status='CONNECTED' WHERE id=$1",[a.id]);
  await tx.query("INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference) VALUES($1,$2,$3,'BAILEYS',$4,'qr-engine')",[channel,a.org,a.account,a.id]);
  await tx.query('INSERT INTO messaging_contacts(id,organization_id,external_id) VALUES($1,$2,$3)',[contact,a.org,'synthetic-contact']);
  await tx.query('INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id) VALUES($1,$2,$3,$4)',[conversation,a.org,channel,contact]);
  await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Synthetic"}','SENDING')`,[message,a.org,channel,conversation]);
  await tx.query("INSERT INTO messaging_outbox(organization_id,message_id,lease_token,lease_expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '60 seconds')",[a.org,message,lease]);
  await tx.query("INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds')",[a.org,channel,conversation,message,lease]);
 });
 const send=vi.fn(async()=>{throw Object.assign(new Error('synthetic lost ACK'),{code:'QR_SEND_UNKNOWN'});});const factories={messaging:()=>({sendText:send}) as any};
 const runtime=createEvolutionFleetRuntime(env,transact,{factories});const client=await runtime.messaging(a.org,a.key,{kind:'QR_DISPATCH',messageId:message,leaseToken:lease});
 await expect(client.sendText('15550000001','Synthetic')).rejects.toMatchObject({uncertain:true});
 const attempt=(await db.pool.query('SELECT id,engine_instance_id FROM qr_dispatch_attempts WHERE organization_id=$1 AND message_id=$2',[a.org,message])).rows[0];expect(attempt.engine_instance_id).toBe(a.id);
 expect((await db.pool.query('SELECT outcome FROM evolution_io_leases WHERE intent_id=$1',[attempt.id])).rows[0].outcome).toBe('UNKNOWN');
 const restarted=createEvolutionFleetRuntime(env,transact,{factories});await expect((await restarted.messaging(a.org,a.key)).sendText('15550000001','Synthetic')).rejects.toThrow('EVOLUTION_ENGINE_RECONCILIATION_REQUIRED');expect(send).toHaveBeenCalledTimes(1);
 await transact(a.org,tx=>tx.query("UPDATE qr_dispatch_attempts SET state='CONFIRMED',provider_message_id='synthetic-provider-message' WHERE id=$1",[attempt.id]));
 expect((await db.pool.query('SELECT outcome FROM evolution_io_leases WHERE intent_id=$1',[attempt.id])).rows[0].outcome).toBe('RESOLVED');expect(send).toHaveBeenCalledTimes(1);
});

it('QR instance snapshot rejects a same-engine swap before confirmation',async()=>{
 await maintenance(async tx=>{if(!(await tx.query('SELECT EXISTS(SELECT 1 FROM evolution_engines) AS registered')).rows[0].registered)await registerEvolutionEngines(env,tx,true);await tx.query("UPDATE evolution_engines SET state=CASE WHEN id='east' THEN 'ACTIVE' ELSE 'DRAINING' END,session_budget=100");});
 const t=await tenant(),a=await provision(t),b=await provision(t,'Synthetic same-engine alternative'),channel=randomUUID(),contact=randomUUID(),conversation=randomUUID(),message=randomUUID(),lease=randomUUID();
 const binding=(await db.pool.query('SELECT engine_id FROM evolution_instance_bindings WHERE instance_id IN($1,$2)',[a.id,b.id])).rows;expect(binding.map(r=>r.engine_id)).toEqual(['east','east']);
 await transact(a.org,async tx=>{
  await tx.query("INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference) VALUES($1,$2,$3,'BAILEYS',$4,'qr-engine')",[channel,a.org,a.account,a.id]);
  await tx.query('INSERT INTO messaging_contacts(id,organization_id,external_id) VALUES($1,$2,$3)',[contact,a.org,'synthetic-snapshot-contact']);
  await tx.query('INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id) VALUES($1,$2,$3,$4)',[conversation,a.org,channel,contact]);
  await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Synthetic"}','SENDING')`,[message,a.org,channel,conversation]);
  await tx.query("INSERT INTO messaging_outbox(organization_id,message_id,lease_token,lease_expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '60 seconds')",[a.org,message,lease]);
  await tx.query("INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds')",[a.org,channel,conversation,message,lease]);
 });
 await expect(transact(a.org,tx=>tx.query("UPDATE qr_dispatch_attempts SET engine_instance_id=$3,state='CONFIRMED',provider_message_id='synthetic' WHERE organization_id=$1 AND message_id=$2",[a.org,message,b.id]))).rejects.toThrow('EVOLUTION_ENGINE_BINDING_CHANGED');
 expect((await db.pool.query('SELECT engine_instance_id,state FROM qr_dispatch_attempts WHERE organization_id=$1 AND message_id=$2',[a.org,message])).rows[0]).toMatchObject({engine_instance_id:a.id,state:'DISPATCHED'});
});

it('I/O acquisition waits for instance authority without holding the engine lock',async()=>{
 await maintenance(async tx=>{if(!(await tx.query('SELECT EXISTS(SELECT 1 FROM evolution_engines) AS registered')).rows[0].registered)await registerEvolutionEngines(env,tx,true);await tx.query("UPDATE evolution_engines SET state='ACTIVE',session_budget=100 WHERE id IN('east','west')");});
 const a=await provision(await tenant()),store=createPostgresFleetStore(transact,loadEvolutionFleet(env)),binding=await store.resolve(a.org,a.key),holder=await app.connect();let acquire:Promise<any>|undefined;
 try{
  await holder.query('BEGIN');await holder.query("SELECT set_config('app.organization_id',$1,true)",[a.org]);await holder.query("SET LOCAL statement_timeout='3s'");await holder.query('SELECT id FROM instances WHERE organization_id=$1 AND id=$2 FOR UPDATE',[a.org,a.id]);
  acquire=store.acquire(binding,false,new Date(Date.now()+30000));acquire.catch(()=>{});
  let waiting=false;for(let n=0;n<100;n++){waiting=(await db.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='jrc_app' AND wait_event_type='Lock' AND query LIKE '%evolution_acquire_io%') AS waiting")).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);
  expect((await holder.query('SELECT evolution_assert_binding($1,$2,$3,$4,$5,false) AS valid',[a.org,a.id,binding.engineId,binding.generation,binding.destinationFingerprint])).rows[0].valid).toBe(true);
  await holder.query('COMMIT');const io=await acquire;await store.settle(io,true,null);
 }finally{await holder.query('ROLLBACK');holder.release();await acquire?.catch(()=>{});}
});
