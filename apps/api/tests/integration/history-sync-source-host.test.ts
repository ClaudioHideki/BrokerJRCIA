import {createHmac,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {connectionStringForRole} from './helpers/task7.js';
import {createEvolutionFleetRuntime} from '../../src/modules/evolution-fleet/runtime.js';
import {historyCaptureScopeKey} from '../../src/modules/history-sync/contract.js';
import {createHash} from 'node:crypto';
import {createOriginJournal} from '../../../../integrations/evolution-origin-journal/src/journal.mjs';
import {createPostgresOriginAuthority} from '../../../../integrations/evolution-origin-journal/src/postgres-authority.mjs';
import {installOriginEngineDatabaseHost,prepareOriginEngineSocket,decideOriginWebhook} from '../../../../integrations/evolution-origin-journal/src/engine-host.mjs';
import {compileEngineFixture} from '../../../../integrations/evolution-origin-journal/tests/engine-fixture.mjs';
import {createHistorySyncRuntime} from '../../src/modules/history-sync/runtime.js';
import {projectTextBatch} from '../../../../integrations/evolution-origin-journal/src/projection.mjs';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createQrMessagingService} from '../../src/modules/messaging/qr-service.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {createCipheriv} from 'node:crypto';
import {deriveHistoryMediaKeys} from '../../../../integrations/evolution-origin-journal/src/history-media-download.mjs';
import {createHistoryConnectionAdmission} from '../../src/modules/history-sync/connection-admission.js';
import {createChatwootControlAuth} from '../../src/modules/integrations/chatwoot-control-auth.js';
import {projectLiveBatch} from '../../../../integrations/evolution-origin-journal/src/live-projection.mjs';
import {createLifecycleService,withLifecyclePlatformTransaction,withLifecycleWorkerTransaction} from '../../src/modules/lifecycle/service.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>,source:Pool;
const role='jrc_origin_t_'+randomUUID().replaceAll('-','').slice(0,12);
const signingKey='synthetic-history-operational-host-isolated-key';
beforeAll(async()=>{
  db=await attendanceDatabase();
  await db.database.pool.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await db.database.pool.query(`GRANT jrc_origin TO ${role}`);
  source=new Pool({connectionString:connectionStringForRole(db.database.connectionString,role),max:2});
},60000);
afterAll(async()=>{await source?.end();if(db){await db.dispose();const pool=new Pool({connectionString:process.env.TEST_DATABASE_ADMIN_URL,max:1});try{await pool.query(`DROP ROLE IF EXISTS ${role}`);}finally{await pool.end();}}});

async function setup(){
  const t=await seedAttendanceTenant(db.database),instance=randomUUID(),instanceKey=`synthetic-${instance}`;
  await db.database.pool.query(`UPDATE provider_accounts SET provider='BAILEYS' WHERE organization_id=$1`,[t.org]);
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
    SELECT $1,organization_id,provider_account_id,'Synthetic origin host',$2 FROM messaging_channels WHERE id=$3`,[instance,instanceKey,t.channel]);
  await db.database.pool.query(`UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1`,[t.channel,instance]);
  const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
  const engine=await fleet.capture(t.org,instanceKey);
  const binding=createHmac('sha256',signingKey).update(JSON.stringify(['qr-engine:v1',engine.engineId,engine.generation,engine.destinationFingerprint,engine.traditional])).digest('hex');
  await db.database.pool.query(`INSERT INTO qr_identity_scopes(organization_id,channel_id,instance_id,upstream_instance_key,binding_fingerprint)
    VALUES($1,$2,$3,$4,$5)`,[t.org,t.channel,instance,instanceKey,binding]);
  const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[t.org])).rows[0].user_id;
  const admin=await db.database.pool.connect();
  try{await admin.query('SET ROLE jrc_migrator');await admin.query('SELECT history_register_origin_engine($1,$2,$3,$4)',[role,engine.engineId,engine.generation,engine.destinationFingerprint]);}
  finally{await admin.query('RESET ROLE');admin.release();}
  const request=randomUUID();
  const enable=()=>db.transact(t.org,tx=>tx.query('SELECT history_sync_enable_connection($1,$2,$3,$4,$5) AS policy',[t.org,t.channel,actor,request,engine]));
  const native=randomUUID(),sessionFingerprint='f'.repeat(64);
  const open=async()=>((await source.query('SELECT history_source_open($1,$2,$3) AS admission',[instanceKey,native,sessionFingerprint])).rows[0].admission);
  return{...t,instance,instanceKey,actor,request,engine,native,sessionFingerprint,enable,open};
}

it('removes both sealed journal scopes only through explicit company deletion and preserves another tenant',async()=>{
  const target=await setup(),other=await setup();
  const admissions=[];
  for(const f of [target,other]){
    await f.enable();const a=await f.open();admissions.push(a);
    for(const key of [a.historyScopeKey,a.liveScopeKey]){
      const capture=randomUUID();
      await db.database.pool.query(`INSERT INTO jrc_evolution_origin.history_batches(scope_key,capture_id,organization_id,run_id,checksum)
       VALUES($1,$2,$3,$4,$5)`,[key,capture,f.org,a.runId,'a'.repeat(64)]);
      await db.database.pool.query(`INSERT INTO jrc_evolution_origin.history_media
       (scope_key,run_id,capture_id,reference_id,descriptor_hash,descriptor_bytes,descriptor_ciphertext,descriptor_iv,descriptor_tag,state,persisted_at)
       VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,'READY',clock_timestamp())`,
       [key,a.runId,capture,randomUUID(),'b'.repeat(64),Buffer.alloc(1),Buffer.alloc(12),Buffer.alloc(16)]);
    }
  }
  const actor=randomUUID();
  await db.database.pool.query(`INSERT INTO platform_users(id,email,password_hash,role,mfa_seed)
   VALUES($1,$2,'no-login','SUPER_ADMIN','no-login')`,[actor,actor+'@example.test']);
  const platform=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_platform'),max:1});
  const worker=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_lifecycle'),max:1});
  try{
    const service=createLifecycleService({transact:work=>withLifecyclePlatformTransaction(platform,work),deprovision:async()=>{}});
    const processor=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:async()=>{}});
    const request=await service.requestOrganization(target.org,'Attendance','Synthetic explicitly confirmed deletion',actor);
    await processor.processOne();
    expect(await service.status(target.org,target.org,request.operationId)).toMatchObject({status:'COMPLETED',errorCode:null});
    expect((await db.database.pool.query(`SELECT organization_id,count(*)::int n FROM jrc_evolution_origin.history_batches
     WHERE organization_id=ANY($1::uuid[]) GROUP BY organization_id`,[[target.org,other.org]])).rows)
     .toEqual([{organization_id:other.org,n:2}]);
    expect((await db.database.pool.query(`SELECT scope_key FROM jrc_evolution_origin.history_media
     WHERE scope_key=ANY($1::text[]) ORDER BY scope_key`,[admissions.flatMap(a=>[a.historyScopeKey,a.liveScopeKey])])).rows.map(row=>row.scope_key))
     .toEqual([admissions[1].historyScopeKey,admissions[1].liveScopeKey].sort());
  }finally{await platform.end();await worker.end();}
});

it('does not capture existing/unadmitted connections, then admits an authorized connection exactly once',async()=>{
  const f=await setup();
  expect(await f.open()).toEqual({mode:'LEGACY'});
  const first=(await f.enable()).rows[0].policy,second=(await f.enable()).rows[0].policy;
  expect(second).toEqual(first);expect(first).toMatchObject({enabled:true,groupsMode:'ALL_AUTHORIZED',revision:1});
  const one=await f.open(),two=await f.open();
  expect(one).toEqual(two);expect(one).toMatchObject({mode:'CAPTURE',scope:{organizationId:f.org,channelId:f.channel,instanceId:f.instance,
    identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null}});
  expect(one.historyScopeKey).toBe(historyCaptureScopeKey(one.scope));
  expect(one.liveScopeKey).toBe(createHash('sha256').update(JSON.stringify([one.binding.instanceId,one.binding.generation,one.binding.destinationId,one.binding.revision])).digest('hex'));
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM history_sync_runs WHERE channel_id=$1',[f.channel])).rows[0].n).toBe(1);
  expect((await source.query('SELECT history_origin_host_identity() AS host')).rows[0].host).toMatchObject({engineId:'legacy',generation:1});
});

it('automatically admits a genuinely new unpaired connection without inventing an owner',async()=>{
 const f=await setup();await db.database.pool.query('DELETE FROM qr_identity_scopes WHERE channel_id=$1',[f.channel]);
 await db.database.pool.query("UPDATE chatwoot_accounts SET encrypted_token='synthetic-unused-token' WHERE organization_id=$1",[f.org]);
 const auth=createChatwootControlAuth({enabled:true,managedOrigin:`https://${f.org}.example.test`,hmacSecret:'synthetic-control-hmac'.repeat(3),transact:db.transact,
  resolveCurrentRole:async(id,org)=>(await db.database.pool.query('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2',[org,id])).rows[0]?.role??null});
 const principal=await auth.authorize({kind:'JWT',organizationId:f.org,actorId:f.actor,role:'OWNER'},'chatwoot:manage');
 const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
 const admit=createHistoryConnectionAdmission({auth,fleet,transact:db.transact,signingKey});
 await admit(principal,f.channel,f.request,async()=>{});await admit(principal,f.channel,f.request,async()=>{});
 expect((await db.database.pool.query('SELECT owner_fingerprint FROM qr_identity_scopes WHERE channel_id=$1',[f.channel])).rows).toEqual([{owner_fingerprint:null}]);
 expect(await f.open()).toMatchObject({mode:'CAPTURE',scope:{identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null}});
});

it('keeps pure LID live facts in the confirmed source scope and recovers them once a PN alias arrives',async()=>{
 const f=await setup();await f.enable();const sourceKey=Buffer.alloc(32,39),phone='1'.repeat(11),jid=`${phone}@s.whatsapp.net`;
 const host=createPostgresOriginAuthority({pool:source,encryptionKey:sourceKey,engine:{engineId:f.engine.engineId,generation:f.engine.generation,engineFingerprint:f.engine.destinationFingerprint},maxStagedBytes:1048576});
 const capture=await host.prepare({instanceId:f.native,instanceName:f.instanceKey},{instance:{id:f.native,name:f.instanceKey,authState:{state:{creds:{registrationId:2781,me:{id:jid}}}}}});
 await capture.observeOwner();await db.database.pool.query("UPDATE instances SET status='CONNECTED' WHERE id=$1",[f.instance]);
 await db.database.pool.query('UPDATE qr_identity_scopes SET owner_fingerprint=$2 WHERE channel_id=$1',[f.channel,
  createHmac('sha256',signingKey).update(`qr-identity:v1:${f.org}:${f.channel}:${f.instanceKey}:${phone}`).digest('hex')]);
 const payload=(key:Record<string,unknown>,text:string)=>projectLiveBatch(capture.admission.binding,{'messages.upsert':{type:'notify',messages:[{key, messageTimestamp:1600000000,message:{conversation:text}}]}});
 await capture.journal.acceptBatch(capture.admission.binding,payload({id:'synthetic-lid-first',remoteJid:'123456789@lid',fromMe:false},'Synthetic pending LID'));
 const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
 const qr=createQrMessagingService({baseUrl:'https://engine.example.test',apiKey:'synthetic-engine-key',webhookOrigin:'https://broker.example.test',signingKey,fleet,
  transact:db.transact,resolveChannel:async()=>({organizationId:f.org,instanceId:f.instance})});
 const app=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_app'),max:2});
 const create=()=>createHistorySyncRuntime({pool:app,transact:db.transact,fleet,qr,environment:{HISTORY_SYNC_V2_ENABLED:'true',QR_WEBHOOK_SIGNING_KEY:signingKey,
  HISTORY_SYNC_SOURCE_KEY:sourceKey.toString('base64'),INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')}});
 try{
  expect(await(await create())!.runOnce(f.org)).toMatchObject({live:'DELIVERED'});
  const pending=(await db.database.pool.query('SELECT scope_id,status FROM qr_identity_pending_events WHERE channel_id=$1',[f.channel])).rows[0];
  expect(pending.scope_id).not.toBeNull();expect(pending.status).toBe('WAITING');
  await capture.journal.acceptBatch(capture.admission.binding,payload({id:'synthetic-lid-pair',remoteJid:jid,remoteJidAlt:'123456789@lid',fromMe:false},'Synthetic confirmed alias'));
  expect(await(await create())!.runOnce(f.org)).toMatchObject({live:'DELIVERED'});await(await create())!.runOnce(f.org);
  expect((await db.database.pool.query('SELECT status FROM instances WHERE id=$1',[f.instance])).rows).toEqual([{status:'CONNECTED'}]);
  expect((await db.database.pool.query('SELECT status FROM qr_identity_pending_events WHERE channel_id=$1',[f.channel])).rows).toEqual([{status:'RESOLVED'}]);
  expect((await db.database.pool.query('SELECT upstream_message_id FROM messaging_messages WHERE channel_id=$1 ORDER BY upstream_message_id',[f.channel])).rows)
   .toEqual([{upstream_message_id:'synthetic-lid-first'},{upstream_message_id:'synthetic-lid-pair'}]);
  expect((await db.database.pool.query('SELECT status FROM qr_identity_pending_events WHERE channel_id=$1',[f.channel])).rows).toEqual([{status:'RESOLVED'}]);
 }finally{await app.end();}
});

it('retains host revocation and QR identity fences until the source COMMIT',async()=>{
  const f=await setup();await f.enable();const admission=await f.open(),client=await source.connect(),contender=await db.database.pool.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT history_source_assert($1)',[admission.sessionId]);
    for(const sql of ['UPDATE history_origin_engine_roles SET enabled=false WHERE role_name=$1','UPDATE qr_identity_scopes SET scope_id=gen_random_uuid() WHERE channel_id=$1']){
      await contender.query('BEGIN');await contender.query("SET LOCAL lock_timeout='150ms'");
      await expect(contender.query(sql,[sql.includes('role_name')?role:f.channel])).rejects.toMatchObject({code:'55P03'});
      await contender.query('ROLLBACK');
    }
    await client.query('COMMIT');
  }finally{await client.query('ROLLBACK').catch(()=>{});await contender.query('ROLLBACK').catch(()=>{});client.release();contender.release();}
});

it('stops the headless Broker worker when its admitted source host is revoked',async()=>{
  const f=await setup();await f.enable();const a=await f.open();
  expect((await db.transact(f.org,tx=>tx.query('SELECT history_source_assert($1) current',[a.sessionId]))).rows[0].current).toBe(true);
  await db.database.pool.query('UPDATE history_origin_engine_roles SET enabled=false WHERE role_name=$1',[role]);
  await expect(db.transact(f.org,tx=>tx.query('SELECT history_source_assert($1)',[a.sessionId]))).rejects.toThrow('HISTORY_SOURCE_SESSION_CHANGED');
});

it('source cannot replace an immutable owner proof or mutate another scope',async()=>{
  const f=await setup();await f.enable();const a=await f.open();
  const proof={iv:Buffer.alloc(12).toString('base64'),tag:Buffer.alloc(16).toString('base64'),ciphertext:Buffer.from('sealed synthetic').toString('base64')};
  await source.query('SELECT history_source_bind_owner($1,$2)',[a.sessionId,proof]);
  await source.query('SELECT history_source_bind_owner($1,$2)',[a.sessionId,proof]);
  await expect(source.query('SELECT history_source_bind_owner($1,$2)',[a.sessionId,{...proof,ciphertext:Buffer.from('different sealed').toString('base64')}])).rejects.toThrow('HISTORY_SOURCE_OWNER_CHANGED');
  await expect(source.query('SELECT history_source_bind_owner($1,$2)',[randomUUID(),proof])).rejects.toThrow('HISTORY_SOURCE_SESSION_CHANGED');
  await expect(source.query('SELECT * FROM history_source_sessions')).rejects.toMatchObject({code:'42501'});
});

it('isolates source journal bytes by registered engine and Broker organization',async()=>{
  const f=await setup();await f.enable();const a=await f.open(),id=randomUUID();
  await source.query(`INSERT INTO jrc_evolution_origin.events(id,scope_key,event_key,binding_fingerprint,body_hash,payload_ciphertext,payload_iv,payload_tag,key_version)
    VALUES($1,$2,$3,$3,$3,$4,$5,$6,1)`,[id,a.liveScopeKey,'a'.repeat(64),Buffer.from('sealed'),Buffer.alloc(12),Buffer.alloc(16)]);
  await expect(source.query(`INSERT INTO jrc_evolution_origin.history_batches(scope_key,capture_id,organization_id,run_id,checksum) VALUES($1,$2,$3,$4,$5)`,
    [a.historyScopeKey,randomUUID(),randomUUID(),a.runId,'a'.repeat(64)])).rejects.toMatchObject({code:'42501'});
  expect((await db.transact(f.org,tx=>tx.query('SELECT id FROM jrc_evolution_origin.events WHERE id=$1',[id]))).rows).toHaveLength(1);
  const other=await seedAttendanceTenant(db.database);
  expect((await db.transact(other.org,tx=>tx.query('SELECT id FROM jrc_evolution_origin.events WHERE id=$1',[id]))).rows).toHaveLength(0);
  await expect(source.query('DELETE FROM jrc_evolution_origin.events WHERE id=$1',[id])).rejects.toMatchObject({code:'42501'});
  await db.database.pool.query('UPDATE history_origin_engine_roles SET enabled=false WHERE role_name=$1',[role]);
  expect((await source.query('SELECT id FROM jrc_evolution_origin.events WHERE id=$1',[id])).rows).toHaveLength(0);
});

it('refuses capture after revocation before any source journal COMMIT',async()=>{
  const f=await setup();await f.enable();const a=await f.open();let assertions=0;
  const journal=createOriginJournal({pool:source,encryptionKey:Buffer.alloc(32,37),history:{maxStagedBytes:1048576},
    assertTransaction:async(client:import('pg').PoolClient)=>{assertions++;await client.query('SELECT history_source_assert($1)',[a.sessionId]);}});
  const prepare=()=>journal.history!.prepare(a.scope,a.runId,{'messaging-history.set':{chats:[{id:'12345@g.us',name:'Synthetic'}],contacts:[],messages:[]}},
    {captureId:randomUUID(),capturedAt:new Date(),provenance:'SOCKET',startOrdinal:0});
  await journal.history!.append(prepare());expect(assertions).toBe(1);
  await db.database.pool.query('UPDATE history_sync_connection_policies SET enabled=false,revision=revision+1 WHERE channel_id=$1',[f.channel]);
  await expect(journal.history!.append(prepare())).rejects.toThrow('HISTORY_SOURCE_SESSION_CHANGED');
  expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.history_batches WHERE scope_key=$1',[a.historyScopeKey])).rows[0].n).toBe(1);
});

it('admits the constructed native instance after auth load and retains sealed owner evidence across host restarts',async()=>{
  const f=await setup();await f.enable();const key=Buffer.alloc(32,39);
  const create=()=>createPostgresOriginAuthority({pool:source,encryptionKey:key,engine:{engineId:f.engine.engineId,generation:f.engine.generation,engineFingerprint:f.engine.destinationFingerprint},maxStagedBytes:1048576});
  const auth={state:{creds:{registrationId:2781,me:undefined as {id:string}|undefined}}},instance={instance:{name:f.instanceKey,id:f.native,authState:auth}};
  const host=create(),first=await host.prepare({instanceName:f.instanceKey,instanceId:f.native},instance);
  expect(first.mode).toBe('CAPTURE');expect(first.admission.scope.instanceId).toBe(f.instance);expect(first.admission.binding.instanceId).toBe(f.native);
  const phone='1'.repeat(11),owner=`${phone}:1@s.whatsapp.net`;
  instance.instance.authState.state.creds.me={id:owner};
  await first.observeOwner();
  const proof=(await db.database.pool.query('SELECT owner_proof FROM history_source_sessions WHERE id=$1',[first.admission.sessionId])).rows[0].owner_proof;
  expect(JSON.stringify(proof)).not.toContain(phone);
  const second=await create().prepare({instanceName:f.instanceKey,instanceId:f.native},instance);
  expect(second.admission.sessionId).toBe(first.admission.sessionId);await second.observeOwner();
  instance.instance.authState.state.creds.me.id=`${'2'.repeat(11)}@s.whatsapp.net`;
  await expect(second.observeOwner()).rejects.toThrow('HISTORY_SOURCE_OWNER_CHANGED');
  await expect(host.prepare({instanceName:f.instanceKey,instanceId:randomUUID()},instance)).rejects.toThrow('ORIGIN_ENGINE_BINDING_CHANGED');
  const wrong=createPostgresOriginAuthority({pool:source,encryptionKey:key,engine:{engineId:'other',generation:1,engineFingerprint:f.engine.destinationFingerprint},maxStagedBytes:1048576});
  await expect(wrong.prepare({instanceName:f.instanceKey,instanceId:f.native},instance)).rejects.toThrow('HISTORY_SOURCE_HOST_UNREGISTERED');
});

it('owns the real pinned callback only after source COMMIT and keeps other sinks independent',async()=>{
  const f=await setup();await f.enable();const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;
  process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED='true';
  const endpoint=`https://broker.example.test/v1/webhooks/whatsapp/${f.channel}`,legacy:unknown[]=[];
  const fixture=await compileEngineFixture({endpoint,onLegacyHttp:async()=>{legacy.push('legacy');}});
  const host=await installOriginEngineDatabaseHost({pool:source,encryptionKey:Buffer.alloc(32,39),
    engine:{engineId:f.engine.engineId,generation:f.engine.generation,engineFingerprint:f.engine.destinationFingerprint},maxStagedBytes:1048576,
    brokerOrigin:'https://broker.example.test',env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true',HISTORY_SYNC_V2_ENABLED:'true'}});
  try{
    const native={instanceId:f.native,instanceName:f.instanceKey,generation:1,destinationId:f.channel,revision:1},{instance,emit}=fixture.create(native);
    instance.instance.authState={state:{creds:{registrationId:2781}}};
    await prepareOriginEngineSocket(instance);
    const message={key:{id:'synthetic-owned-live',remoteJid:`${'1'.repeat(11)}@s.whatsapp.net`,fromMe:false},messageTimestamp:1600000000,message:{conversation:'Synthetic durable live'}};
    const media={...message,key:{...message.key,id:'synthetic-owned-media'},message:{imageMessage:{caption:'Synthetic image',mimetype:'image/png',fileName:'synthetic.png',
      mediaKey:Buffer.alloc(32,17),fileSha256:createHash('sha256').update('synthetic image').digest(),fileLength:15,directPath:'/v/synthetic-owned.enc'}}};
    const group={...message,key:{...message.key,id:'synthetic-owned-group',remoteJid:'12345@g.us',participant:'123456789@lid'}};
    const groupMedia={...media,key:{...group.key,id:'synthetic-owned-group-media'}};
    await emit({'messages.upsert':{type:'notify',messages:[message,media,group,groupMedia]},'messaging-history.set':{chats:[],contacts:[],messages:[message]}});
    await fixture.drainFanouts();
    expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.events WHERE scope_key IN (SELECT live_scope_key FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows[0].n).toBe(4);
    expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.history_batches WHERE organization_id=$1',[f.org])).rows[0].n).toBe(2);
    expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.history_media WHERE live_message_key IS NOT NULL AND run_id IN (SELECT run_id FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows[0].n).toBe(2);
    expect(legacy).toHaveLength(0);expect(fixture.calls.filter((c:{kind:string})=>c.kind==='websocket')).toHaveLength(4);
  }finally{await host.close();if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}
});

it('drives admitted source pages after a host restart into the canonical Broker without a browser or live side effects',async()=>{
  const f=await setup();await f.enable();const sourceKey=Buffer.alloc(32,41),phone='1'.repeat(11),jid=`${phone}@s.whatsapp.net`;
  const h=createPostgresOriginAuthority({pool:source,encryptionKey:sourceKey,engine:{engineId:f.engine.engineId,generation:f.engine.generation,engineFingerprint:f.engine.destinationFingerprint},maxStagedBytes:1048576});
  const native={instance:{id:f.native,name:f.instanceKey,authState:{state:{creds:{registrationId:2781,me:{id:jid}}}}}};
  const capture=await h.prepare({instanceId:f.native,instanceName:f.instanceKey},native);await capture.observeOwner();
  await capture.journal.history.append(capture.journal.history.prepare(capture.admission.scope,capture.admission.runId,
    {'messaging-history.set':{chats:[{id:jid,name:'Synthetic personal'},{id:'12345@g.us',name:'Synthetic group'}],contacts:[],messages:[
      {key:{id:'synthetic-runtime-in',remoteJid:jid,fromMe:false},messageTimestamp:1600000000,message:{conversation:'Synthetic inbound'}},
      {key:{id:'synthetic-runtime-out',remoteJid:jid,fromMe:true},messageTimestamp:1600000001,message:{conversation:'Synthetic outbound'}}]}},
    {captureId:randomUUID(),capturedAt:new Date(),startOrdinal:0,provenance:'SOCKET'}));
  await db.database.pool.query('UPDATE qr_identity_scopes SET owner_fingerprint=$2 WHERE channel_id=$1',[f.channel,
    createHmac('sha256',signingKey).update(`qr-identity:v1:${f.org}:${f.channel}:${f.instanceKey}:${phone}`).digest('hex')]);
  await db.database.pool.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)',[f.org,f.channel]);
  const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
  const appPool=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_app'),max:2});
  const runtime=await createHistorySyncRuntime({pool:appPool,transact:db.transact,fleet,environment:{HISTORY_SYNC_V2_ENABLED:'true',
    QR_WEBHOOK_SIGNING_KEY:signingKey,HISTORY_SYNC_SOURCE_KEY:sourceKey.toString('base64'),INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')}});
  try{
    await runtime!.runOnce(f.org);await runtime!.runOnce(f.org);
    const facts=(await db.database.pool.query('SELECT upstream_message_id,direction,is_historical FROM messaging_messages WHERE channel_id=$1 ORDER BY upstream_message_id',[f.channel])).rows;
    expect(facts).toEqual([{upstream_message_id:'synthetic-runtime-in',direction:'INCOMING',is_historical:true},{upstream_message_id:'synthetic-runtime-out',direction:'OUTGOING',is_historical:true}]);
    expect((await db.database.pool.query('SELECT count(*)::int n FROM messaging_bot_jobs WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
    expect((await db.database.pool.query('SELECT count(*)::int n FROM messaging_outbox WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
    expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.history_chunks WHERE scope_key=$1 AND state=\'PENDING\'',[capture.admission.historyScopeKey])).rows[0].n).toBe(0);
  }finally{await appPool.end();}
});

it('denies public application/other tenant access to source registration and Broker tables from the engine login',async()=>{
  const f=await setup();await f.enable();const admission=await f.open();
  await expect(source.query('SELECT * FROM public.memberships')).rejects.toMatchObject({code:'42501'});
  await expect(db.transact(f.org,tx=>tx.query('SELECT history_register_origin_engine($1,$2,$3,$4)',[role,'legacy',1,f.engine.destinationFingerprint]))).rejects.toMatchObject({code:'42501'});
  const other=await seedAttendanceTenant(db.database);
  const hidden=await db.transact(other.org,tx=>tx.query('SELECT id FROM history_source_sessions WHERE id=$1',[admission.sessionId]));
  expect(hidden.rows).toEqual([]);
  expect((await db.transact(f.org,tx=>tx.query('SELECT id FROM history_source_sessions WHERE id=$1',[admission.sessionId]))).rows).toHaveLength(1);
});

it('continues live delivery while the historical import is paused',async()=>{
  const f=await setup();await f.enable();const a=await f.open(),sourceKey=Buffer.alloc(32,39);
  const journal=createOriginJournal({pool:source,encryptionKey:sourceKey,history:{maxStagedBytes:1048576},
    assertTransaction:async(tx:import('pg').PoolClient)=>{await tx.query('SELECT history_source_assert($1)',[a.sessionId]);}});
  await journal.acceptBatch(a.binding,projectTextBatch(a.binding,{'messages.upsert':{type:'notify',messages:[{key:{id:'synthetic-live-during-pause',
    remoteJid:`${'1'.repeat(11)}@s.whatsapp.net`,fromMe:false},messageTimestamp:1600000000,message:{conversation:'Synthetic live during pause'}}]}}));
  await db.database.pool.query("UPDATE history_sync_runs SET state='PAUSED' WHERE organization_id=$1 AND id=$2",[f.org,a.runId]);
  const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
  const appPool=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_app'),max:2});let delivered=0;
  const runtime=await createHistorySyncRuntime({pool:appPool,transact:db.transact,fleet,environment:{HISTORY_SYNC_V2_ENABLED:'true',
    QR_WEBHOOK_SIGNING_KEY:signingKey,HISTORY_SYNC_SOURCE_KEY:sourceKey.toString('base64'),INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},
    qr:{ingest:async(_channel,_auth,_body,receipt)=>{delivered++;return{status:'accepted',sourceEventId:receipt!.sourceEventId,durablyAccepted:true};}}});
  try{expect(await runtime!.runOnce(f.org)).toMatchObject({kind:'INACTIVE',state:'PAUSED',live:'DELIVERED'});expect(delivered).toBe(1);
    await runtime!.runOnce(f.org);expect(delivered).toBe(1);
  }finally{await appPool.end();}
});

it('recovers the database host after SIGKILL and a lost actual Broker ACK without duplicating live/history',async()=>{
  const f=await setup();await f.enable();const sourceKey=Buffer.alloc(32,39),phone='1'.repeat(11);
  const start=async()=>{
    const child=fork(fileURLToPath(new URL('../../../../integrations/evolution-origin-journal/tests/database-host-child.mjs',import.meta.url)),[],
      {env:{...process.env,TEST_SOURCE_DATABASE_URL:connectionStringForRole(db.database.connectionString,role)},stdio:['ignore','ignore','ignore','ipc']});
    const committed=Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('Synthetic host exited before source commit');})]);
    child.send({kind:'SYNTHETIC_DATABASE_HOST',engine:{engineId:f.engine.engineId,generation:f.engine.generation,engineFingerprint:f.engine.destinationFingerprint},
      nativeId:f.native,instanceName:f.instanceKey,channel:f.channel,phone});
    try{expect((await committed)[0]).toEqual({kind:'SOURCE_COMMITTED'});return child;}
    catch(error){child.kill('SIGKILL');throw error;}
  };
  const kill=async(child:ReturnType<typeof fork>)=>{const exited=once(child,'exit');child.kill('SIGKILL');await exited;};
  const first=await start();await kill(first);
  const second=await start();await kill(second);
  expect((await db.database.pool.query('SELECT count(*)::int n FROM history_source_sessions WHERE channel_id=$1',[f.channel])).rows[0].n).toBe(1);
  expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.events WHERE scope_key IN (SELECT live_scope_key FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows[0].n).toBe(1);
  await db.database.pool.query('UPDATE qr_identity_scopes SET owner_fingerprint=$2 WHERE channel_id=$1',[f.channel,
    createHmac('sha256',signingKey).update(`qr-identity:v1:${f.org}:${f.channel}:${f.instanceKey}:${phone}`).digest('hex')]);
  const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
  const qr=createQrMessagingService({baseUrl:'https://engine.example.test',apiKey:'synthetic-engine-key',webhookOrigin:'https://broker.example.test',signingKey,
    fleet,transact:db.transact,resolveChannel:async()=>({organizationId:f.org,instanceId:f.instance})});let loseAck=true;
  const appPool=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_app'),max:2});
  const create=()=>createHistorySyncRuntime({pool:appPool,transact:db.transact,fleet,environment:{HISTORY_SYNC_V2_ENABLED:'true',QR_WEBHOOK_SIGNING_KEY:signingKey,
    HISTORY_SYNC_SOURCE_KEY:sourceKey.toString('base64'),INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')},qr:{ingest:async(...args)=>{
      const ack=await qr.ingest(...args);if(loseAck){loseAck=false;throw Error('SYNTHETIC_ACK_LOST_AFTER_COMMIT');}return ack;}}});
  try{
    expect(await (await create())!.runOnce(f.org)).toMatchObject({live:'RETRY'});
    await db.database.pool.query("UPDATE jrc_evolution_origin.events SET next_attempt_at='-infinity' WHERE scope_key IN (SELECT live_scope_key FROM history_source_sessions WHERE channel_id=$1)",[f.channel]);
    expect(await (await create())!.runOnce(f.org)).toMatchObject({live:'DELIVERED'});
    expect((await db.database.pool.query('SELECT upstream_message_id,is_historical FROM messaging_messages WHERE channel_id=$1',[f.channel])).rows)
      .toEqual([{upstream_message_id:'synthetic-database-host-crash',is_historical:false}]);
    expect((await db.database.pool.query('SELECT count(*)::int n FROM history_sync_receipts WHERE channel_id=$1',[f.channel])).rows[0].n).toBe(1);
    expect((await db.database.pool.query('SELECT count(*)::int n FROM qr_origin_receipts WHERE channel_id=$1',[f.channel])).rows[0].n).toBe(1);
  }finally{await appPool.end();}
},60000);

it('recovers live media after SIGKILL without Prisma cache or a historical MESSAGE projection',async()=>{
 const f=await setup();await f.enable();const phone='1'.repeat(11),key=Buffer.alloc(32,39);
 const child=fork(fileURLToPath(new URL('../../../../integrations/evolution-origin-journal/tests/database-host-child.mjs',import.meta.url)),[],
  {env:{...process.env,TEST_SOURCE_DATABASE_URL:connectionStringForRole(db.database.connectionString,role)},stdio:['ignore','ignore','ignore','ipc']});
 try{
  const ready=Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('Host exited before commit');})]);
  child.send({kind:'SYNTHETIC_DATABASE_HOST',mode:'LIVE_MEDIA',engine:{engineId:f.engine.engineId,generation:f.engine.generation,engineFingerprint:f.engine.destinationFingerprint},
   nativeId:f.native,instanceName:f.instanceKey,channel:f.channel,phone});expect((await ready)[0]).toEqual({kind:'SOURCE_COMMITTED'});
 }finally{const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
 const sourceRows=(await db.database.pool.query('SELECT state FROM jrc_evolution_origin.history_media WHERE scope_key IN (SELECT history_scope_key FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows;
 expect(sourceRows).toEqual([{state:'PENDING'}]);
 expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.history_chunks WHERE run_id IN (SELECT run_id FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows[0].n).toBe(0);
 await db.database.pool.query('UPDATE qr_identity_scopes SET owner_fingerprint=$2 WHERE channel_id=$1',[f.channel,
  createHmac('sha256',signingKey).update(`qr-identity:v1:${f.org}:${f.channel}:${f.instanceKey}:${phone}`).digest('hex')]);
 const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},db.transact);
 const qr=createQrMessagingService({baseUrl:'https://engine.example.test',apiKey:'synthetic-engine-key',webhookOrigin:'https://broker.example.test',signingKey,fleet,
  transact:db.transact,resolveChannel:async()=>({organizationId:f.org,instanceId:f.instance})});
 const env={HISTORY_SYNC_V2_ENABLED:'true',QR_WEBHOOK_SIGNING_KEY:signingKey,HISTORY_SYNC_SOURCE_KEY:key.toString('base64'),INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64')};
 const app=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_app'),max:2});
 const bytes=Buffer.from('synthetic source media after crash'),keys=deriveHistoryMediaKeys(Buffer.alloc(32,17),'image');
 const cipher=createCipheriv('aes-256-cbc',keys.cipherKey,keys.iv),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
 const mac=createHmac('sha256',keys.macKey).update(keys.iv).update(encrypted).digest().subarray(0,10);let downloads=0;
 vi.stubGlobal('fetch',async(url:string)=>{expect(url).toBe('https://mmg.whatsapp.net/v/synthetic-live-crash.enc');downloads++;return new Response(Buffer.concat([encrypted,mac]));});
 try{
  const {createHistoryLiveMediaRecovery}=await import('../../src/modules/history-sync/live-media-recovery.js');
  const recovery=await createHistoryLiveMediaRecovery({transact:db.transact,environment:env,fleet});
  const media=createMediaStore({transact:db.transact,encryptionKey:env.INTEGRATION_ENCRYPTION_KEY,download:async asset=>{
   const value=await recovery!.download(asset);if(!value)throw Error('Prisma cache unavailable');return value;}});
  const runtime=await createHistorySyncRuntime({pool:app,transact:db.transact,fleet,environment:env,qr,media});
  await db.database.pool.query("UPDATE history_sync_runs SET state='PAUSED' WHERE channel_id=$1",[f.channel]);
  expect(await runtime!.runOnce(f.org)).toMatchObject({live:'DELIVERED',kind:'INACTIVE'});
  await media.runOnce(f.org);await runtime!.runOnce(f.org);
  const row=(await db.database.pool.query("SELECT m.id,m.status FROM messaging_media m WHERE m.channel_id=$1 AND m.source='QR'",[f.channel])).rows[0];
  expect(row.status).toBe('READY');expect(Buffer.from((await media.read(f.org,row.id)).bytes)).toEqual(bytes);expect(downloads).toBe(1);
  expect((await db.database.pool.query('SELECT state FROM jrc_evolution_origin.history_media WHERE scope_key IN (SELECT history_scope_key FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows).toEqual([{state:'READY'}]);
  expect((await db.database.pool.query('SELECT is_historical FROM messaging_messages WHERE channel_id=$1',[f.channel])).rows).toEqual([{is_historical:false}]);
  expect((await db.database.pool.query('SELECT count(*)::int n FROM messaging_media WHERE channel_id=$1',[f.channel])).rows[0].n).toBe(1);
 }finally{vi.unstubAllGlobals();await app.end();}
},60000);

for(const scenario of ['epoch','retire','retry','retry-pg-disconnect','retry-pg-pool-timeout','retry-pg-client-timeout','lifecycle'])it(`fences the real native callback and host lifecycle (${scenario})`,async()=>{
 const f=await setup();if(scenario!=='retire'&&scenario!=='lifecycle')await f.enable();
 const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED='true';
 let fail=scenario.startsWith('retry');
 const pool={query:source.query.bind(source),connect:async()=>{const c=await source.connect();return{release:()=>c.release(),query:async(sql:string,values?:unknown[])=>{
  if(fail&&sql.includes('INSERT INTO jrc_evolution_origin.events')){
   fail=false;
   if(scenario==='retry-pg-disconnect')throw Error('Connection terminated unexpectedly');
   if(scenario==='retry-pg-pool-timeout')throw Error('timeout exceeded when trying to connect');
   if(scenario==='retry-pg-client-timeout')throw Error('Connection terminated due to connection timeout');
   throw Object.assign(Error('Synthetic transient connection reset'),{code:'ECONNRESET'});
  }
  return c.query(sql,values);}};}};
 const host=await installOriginEngineDatabaseHost({pool,encryptionKey:Buffer.alloc(32,39),engine:{engineId:f.engine.engineId,generation:f.engine.generation,
  engineFingerprint:f.engine.destinationFingerprint},maxStagedBytes:1048576,brokerOrigin:'https://broker.example.test',
  env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true',HISTORY_SYNC_V2_ENABLED:'true'}});
 try{
  const fixture=await compileEngineFixture({endpoint:`https://broker.example.test/v1/webhooks/whatsapp/${f.channel}`});
  const a=fixture.create({instanceId:f.native,instanceName:f.instanceKey,generation:1,destinationId:f.channel,revision:1});
  if(scenario==='lifecycle'){
   expect(await decideOriginWebhook({instanceName:f.instanceKey,event:'instance.create',destination:'https://broker.example.test/unused'})).toBe('DELIVER_LEGACY');return;
  }
  a.instance.instance.authState={state:{creds:{registrationId:2781}}};await prepareOriginEngineSocket(a.instance);
  if(scenario==='retire'){
   await fixture.remove(f.instanceKey);
   expect(()=>fixture.create({instanceId:randomUUID(),instanceName:f.instanceKey,generation:1,destinationId:f.channel,revision:1})).not.toThrow();
   await expect(a.emit({'messages.upsert':{type:'notify',messages:[]}})).rejects.toThrow('ORIGIN_ENGINE_HOST_CLOSED');return;
  }
  const callbackA=a.registerCallback();
  const event={'messages.upsert':{type:'notify',messages:[{key:{id:'synthetic-socket-epoch',remoteJid:'1'.repeat(11)+'@s.whatsapp.net',fromMe:false},
   messageTimestamp:1600000000,message:{conversation:'Synthetic socket-bound event'}}]}};
  if(scenario==='epoch'){
   a.instance.instance.authState={state:{creds:{registrationId:2782}}};await prepareOriginEngineSocket(a.instance);
   await expect(callbackA(event)).rejects.toThrow('ORIGIN_ENGINE_SOCKET_CHANGED');
   expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.events WHERE scope_key IN(SELECT live_scope_key FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows[0].n).toBe(0);
  }else{
   await callbackA(event);expect(fail).toBe(false);
   expect((await db.database.pool.query('SELECT count(*)::int n FROM jrc_evolution_origin.events WHERE scope_key IN(SELECT live_scope_key FROM history_source_sessions WHERE channel_id=$1)',[f.channel])).rows[0].n).toBe(1);
  }
  await fixture.drainFanouts();
 }finally{await host.close();if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}
},60000);

it('revokes an old source epoch on new auth state without deleting committed obligations or mixing runs',async()=>{
  const f=await setup();await f.enable();const old=await f.open();
  const next=(await source.query('SELECT history_source_open($1,$2,$3) AS admission',[f.instanceKey,f.native,'e'.repeat(64)])).rows[0].admission;
  expect(next.sessionId).not.toBe(old.sessionId);expect(next.runId).not.toBe(old.runId);
  await expect(source.query('SELECT history_source_assert($1)',[old.sessionId])).rejects.toThrow('HISTORY_SOURCE_SESSION_CHANGED');
  const runs=(await db.database.pool.query('SELECT id,state FROM history_sync_runs WHERE channel_id=$1 ORDER BY id',[f.channel])).rows;
  expect(runs).toContainEqual({id:old.runId,state:'BLOCKED'});expect(runs).toContainEqual({id:next.runId,state:'RUNNING'});
});

it('holds the source policy revocation fence through its PostgreSQL COMMIT',async()=>{
  const f=await setup();await f.enable();const admission=await f.open(),client=await source.connect(),contender=await db.database.pool.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT history_source_assert($1)',[admission.sessionId]);
    await contender.query('BEGIN');await contender.query("SET LOCAL lock_timeout='150ms'");
    await expect(contender.query('UPDATE history_sync_connection_policies SET enabled=false,revision=revision+1 WHERE channel_id=$1',[f.channel])).rejects.toMatchObject({code:'55P03'});
    await contender.query('ROLLBACK');await client.query('COMMIT');
    await contender.query('UPDATE history_sync_connection_policies SET enabled=false,revision=revision+1 WHERE channel_id=$1',[f.channel]);
    await expect(source.query('SELECT history_source_assert($1)',[admission.sessionId])).rejects.toThrow('HISTORY_SOURCE_SESSION_CHANGED');
  }finally{await client.query('ROLLBACK').catch(()=>{});await contender.query('ROLLBACK').catch(()=>{});client.release();contender.release();}
});

it('admits a scoped Chatwoot control key and stops capture when that permission is revoked',async()=>{
  const f=await setup(),keyId=randomUUID();
  await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1::uuid,$2,'Synthetic control',($1::uuid)::text,'synthetic',ARRAY['chatwoot:manage'])`,[keyId,f.org]);
  await db.database.pool.query(`INSERT INTO chatwoot_control_bindings(api_key_id,organization_id,account_id,destination_revision) VALUES($1,$2,7,1)`,[keyId,f.org]);
  await db.transact(f.org,tx=>tx.query('SELECT history_sync_enable_connection($1,$2,NULL,$3,$4,$5)',[f.org,f.channel,f.request,f.engine,keyId]));
  const a=await f.open();expect(a.mode).toBe('CAPTURE');
  await db.database.pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1',[keyId]);
  await expect(source.query('SELECT history_source_assert($1)',[a.sessionId])).rejects.toThrow('HISTORY_SYNC_FORBIDDEN');
  await expect(db.transact(f.org,tx=>tx.query('SELECT history_source_assert($1)',[a.sessionId]))).rejects.toThrow('HISTORY_SYNC_FORBIDDEN');
});
