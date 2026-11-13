import {createCipheriv,createHash,createHmac,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {connectionStringForRole} from './helpers/task7.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {createEvolutionFleetRuntime} from '../../src/modules/evolution-fleet/runtime.js';
import {createHistorySyncRuntime} from '../../src/modules/history-sync/runtime.js';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {createS3PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';
import {createDurablePrivateMediaStore} from '../../src/modules/messaging/durable-private-media.js';
import {createPostgresOriginAuthority} from '../../../../integrations/evolution-origin-journal/src/postgres-authority.mjs';
import {deriveHistoryMediaKeys} from '../../../../integrations/evolution-origin-journal/src/history-media-download.mjs';
import {initializeHistoryLabBucket} from '../../../../labs/history-sync-lab2/storage-fixture.mjs';

// Auth/session input remains synthetic. All authority, decryption, S3, SQL,
// Rails HTTP, Sidekiq, destination receipts and Minhas checks below are real.
it.skipIf(process.env.HISTORY_LAB2_E2E!=='true')('runs the admitted database host, authenticated media and private worker through Rails/Sidekiq',async()=>{
 const origin=process.env.HISTORY_LAB2_ORIGIN!,endpoint=process.env.HISTORY_LAB_MINIO_ENDPOINT!;
 if(origin!=='http://127.0.0.1:54141'||!/^http:\/\/127[.]0[.]0[.]1:\d+$/u.test(endpoint))throw Error('Only isolated history laboratory allowed');
 const db=await attendanceDatabase(),role='jrc_origin_t_'+randomUUID().replaceAll('-','').slice(0,12);
 let source:Pool|undefined,app:Pool|undefined;
 try{
  await db.database.pool.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await db.database.pool.query(`GRANT jrc_origin TO ${role}`);
  source=new Pool({connectionString:connectionStringForRole(db.database.connectionString,role),max:2});
  app=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_app'),max:2});
  const transact=<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(app!,org,work);
  const signingKey='synthetic-operational-lab-signing-key'.repeat(2),sourceKey=Buffer.alloc(32,39),brokerKey=Buffer.alloc(32,83);
  const fleet=createEvolutionFleetRuntime({EVOLUTION_BASE_URL:'https://engine.example.test',EVOLUTION_API_KEY:'synthetic-engine-key',QR_WEBHOOK_SIGNING_KEY:signingKey},transact);
  const scopes=[];
  for(let index=0;index<2;index++){
   const t=await seedAttendanceTenant(db.database),instance=randomUUID(),instanceName=`synthetic-${instance}`;
   await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE organization_id=$1",[t.org]);
   await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
    SELECT $1,organization_id,provider_account_id,'Synthetic source',$2 FROM messaging_channels WHERE id=$3`,[instance,instanceName,t.channel]);
   await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
   const engine=await fleet.capture(t.org,instanceName),fingerprint=createHmac('sha256',signingKey)
    .update(JSON.stringify(['qr-engine:v1',engine.engineId,engine.generation,engine.destinationFingerprint,engine.traditional])).digest('hex');
   await db.database.pool.query(`INSERT INTO qr_identity_scopes(organization_id,channel_id,instance_id,upstream_instance_key,binding_fingerprint)
    VALUES($1,$2,$3,$4,$5)`,[t.org,t.channel,instance,instanceName,fingerprint]);
   const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[t.org])).rows[0].user_id;
   const admin=await db.database.pool.connect();try{await admin.query('SET ROLE jrc_migrator');
    await admin.query('SELECT history_register_origin_engine($1,$2,$3,$4)',[role,engine.engineId,engine.generation,engine.destinationFingerprint]);
   }finally{await admin.query('RESET ROLE');admin.release();}
   await transact(t.org,tx=>tx.query('SELECT history_sync_enable_connection($1,$2,$3,$4,$5)',[t.org,t.channel,actor,randomUUID(),engine]));
   scopes.push({t,instance,instanceName,engine});
  }
  const lab=async(path:string,body:unknown)=>{
   const response=await fetch(`${origin}/__history_lab/${path}`,{method:'POST',headers:{'content-type':'application/json','X-History-Lab-Key':process.env.HISTORY_LAB_HTTP_KEY!},body:JSON.stringify(body)});
   if(!response.ok)throw Error('SYNTHETIC_RAILS_FIXTURE_'+response.status);return response.json();
  };
  const consumers=await lab('seed',scopes.map(({t,instance})=>({organizationId:t.org,integrationId:t.integration,instanceId:instance}))) as
   {accountId:number;inboxId:number;adminToken:string;agentToken:string}[];
  const bytes=readFileSync(join(process.env.HISTORY_LAB2_CHECKOUT!,'spec/assets/sample.png')),sha256=createHash('sha256').update(bytes).digest('hex');
  const providerKey=Buffer.alloc(32,17),keys=deriveHistoryMediaKeys(providerKey,'image'),cipher=createCipheriv('aes-256-cbc',keys.cipherKey,keys.iv);
  const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]),mac=createHmac('sha256',keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0,10);
  const encrypted=Buffer.concat([ciphertext,mac]),realFetch=globalThis.fetch;let unavailable=true;
  vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
   if(String(input)==='https://mmg.whatsapp.net/v/synthetic-operational.enc'){
    if(unavailable){unavailable=false;return new Response('',{status:503});}
    return new Response(new Uint8Array(encrypted),{headers:{'content-length':String(encrypted.length)}});
   }return realFetch(input,init);
  });
  await initializeHistoryLabBucket({labOnly:true,endpoint,accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!});
  const objectStore=createS3PrivateObjectStore({endpoint,bucket:'synthetic-broker-history-20261112',profile:'synthetic-history',region:'us-east-1',
   accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!,dedicatedBucket:true,allowLoopbackHttpForTests:true});
  const privateStore=createDurablePrivateMediaStore({transact,cleanupTransact:async()=>{throw Error('Cleanup excluded');},
   encryptionKey:brokerKey.toString('base64'),profile:'synthetic-history',objectStore,maxStorageBytes:16777216});
  const media=createMediaStore({transact,encryptionKey:brokerKey.toString('base64'),privateStore,download:async()=>{throw Error('Legacy provider download excluded');}});
  for(const[index,{t,instance,instanceName,engine}]of scopes.entries()){
   const consumer=consumers[index]!,phone=String(index+1).repeat(11),jid=`${phone}@s.whatsapp.net`;
   await db.database.pool.query('UPDATE chatwoot_accounts SET account_id=$2 WHERE organization_id=$1',[t.org,consumer.accountId]);
   await db.database.pool.query('UPDATE chatwoot_connections SET inbox_id=$2 WHERE organization_id=$1',[t.org,consumer.inboxId]);
   const authority=createPostgresOriginAuthority({pool:source,encryptionKey:sourceKey,engine:{engineId:engine.engineId,generation:engine.generation,
    engineFingerprint:engine.destinationFingerprint},maxStagedBytes:4000000});
   const nativeId=randomUUID(),captured=await authority.prepare({instanceId:nativeId,instanceName},{instance:{id:nativeId,name:instanceName,
    authState:{state:{creds:{registrationId:2781,me:{id:jid}}}}}});await captured.observeOwner();
   await captured.journal.history.append(captured.journal.history.prepare(captured.admission.scope,captured.admission.runId,{'messaging-history.set':{
    chats:[{id:jid,name:'Synthetic operational customer',conversationTimestamp:1600000000}],contacts:[],messages:[{key:{id:'synthetic-operational-media',remoteJid:jid,fromMe:false},
     messageTimestamp:1600000000,message:{imageMessage:{caption:'Synthetic operational custody',fileName:'synthetic.png',mimetype:'image/png',
      mediaKey:providerKey,fileSha256:Buffer.from(sha256,'hex'),fileLength:bytes.length,directPath:'/v/synthetic-operational.enc'}}}]}},
     {captureId:randomUUID(),capturedAt:new Date(),startOrdinal:0,provenance:'SOCKET'}));
   await db.database.pool.query('UPDATE qr_identity_scopes SET owner_fingerprint=$2 WHERE channel_id=$1',[t.channel,
    createHmac('sha256',signingKey).update(`qr-identity:v1:${t.org}:${t.channel}:${instanceName}:${phone}`).digest('hex')]);
   const options={pool:app,transact,fleet,media,environment:{HISTORY_SYNC_V2_ENABLED:'true',QR_WEBHOOK_SIGNING_KEY:signingKey,
    HISTORY_SYNC_SOURCE_KEY:sourceKey.toString('base64'),INTEGRATION_ENCRYPTION_KEY:brokerKey.toString('base64')},
    client:(account:{organization_id:string;account_id:string|null})=>{if(account.organization_id!==t.org||Number(account.account_id)!==consumer.accountId)throw Error('SYNTHETIC_DESTINATION_MISMATCH');
      return new ChatwootClient({baseUrl:origin,token:consumer.adminToken,allowLocal:true,timeoutMs:30000});}};
   for(let tick=0;tick<35;tick++){
    // Reconstruct the complete private driver every time; memory cannot be progress.
    await (await createHistorySyncRuntime(options))!.runOnce(t.org);
    const done=(await db.database.pool.query("SELECT count(*)::int n FROM history_sync_deliveries WHERE run_id=$1 AND state='DONE'",[captured.admission.runId])).rows[0].n;
    if(done===2)break;
    await db.database.pool.query("UPDATE jrc_evolution_origin.history_media SET next_attempt_at='-infinity' WHERE run_id=$1 AND state='PENDING'",[captured.admission.runId]);
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   expect((await db.database.pool.query('SELECT persisted_messages,blocked_records,pending_media FROM history_sync_runs WHERE id=$1',[captured.admission.runId])).rows[0])
    .toEqual({persisted_messages:'1',blocked_records:'0',pending_media:'0'});
   const progress=(await db.database.pool.query(`SELECT s.state,s.persisted_at,m.status,m.sha256,m.byte_size FROM jrc_evolution_origin.history_media s
    JOIN messaging_media m ON m.id=s.reference_id AND m.organization_id=$2 WHERE s.run_id=$1`,[captured.admission.runId,t.org])).rows[0];
   expect(progress).toMatchObject({state:'READY',status:'READY',sha256,byte_size:bytes.length});expect(progress.persisted_at).toBeInstanceOf(Date);
   const visible=await fetch(`${origin}/api/v1/accounts/${consumer.accountId}/conversations?assignee_type=me&inbox_scope=member&status=all`,{headers:{api_access_token:consumer.agentToken}});
   expect(visible.status).toBe(200);expect((await visible.json()).data.payload).toEqual([expect.objectContaining({inbox_id:consumer.inboxId})]);
  }
  const report=await lab('verify',consumers.map(c=>c.accountId));
  expect(report).toMatchObject({messages:2,attachments:2,all_resolved:true,all_unassigned:true});expect(report.byte_hashes).toEqual([sha256,sha256]);
 }finally{
  vi.unstubAllGlobals();await source?.end();await app?.end();await db.dispose();
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_ADMIN_URL,max:1});try{await admin.query(`DROP ROLE IF EXISTS ${role}`);}finally{await admin.end();}
 }
},240000);
