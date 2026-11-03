import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool,Client} from 'pg';
import Fastify from 'fastify';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {createOrganizationApiKey} from '@jrc/security';
import {createIsolatedLabDatabase,createPrivateMediaState} from './state.mjs';
import {openLabReceiver,LAB_ORGANIZATIONS} from './receiver.mjs';
import {openLabReceiverProcess} from './receiver-process.mjs';
import {openSourceCrashProcess} from './media-source-process.mjs';
import {runMigrations} from '../../apps/api/dist/db/migrate.js';
import {withOrganizationTransaction} from '../../apps/api/dist/db/tenant-transaction.js';
import {createApiKeyService} from '../../apps/api/dist/modules/api-keys/service.js';
import {createPostgresApiKeyRepository} from '../../apps/api/dist/modules/api-keys/repository.js';
import {createPartnerEventService} from '../../apps/api/dist/modules/partner-events/service.js';
import {createPartnerEventWorker} from '../../apps/api/dist/modules/partner-events/worker.js';
import {createIntegrationSecrets} from '../../apps/api/dist/modules/integrations/secrets.js';
import {createMediaStore,registerPendingMedia} from '../../apps/api/dist/modules/messaging/media-store.js';
import {createMediaCustodyService} from '../../apps/api/dist/modules/media-custody/service.js';
import {registerPartnerWebhookRoutes} from '../../apps/api/dist/http/routes/partner-webhooks.js';
import {registerMessagingRoutes} from '../../apps/api/dist/http/routes/messaging.js';
import {registerMediaCustodyRoutes} from '../../apps/api/dist/http/routes/media-custody.js';
import {createS3PrivateObjectStore} from '../../apps/api/dist/modules/messaging/private-object-store.js';
import {createDurablePrivateMediaStore} from '../../apps/api/dist/modules/messaging/durable-private-media.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const endpoint=process.env.TEST_CCLX_S3_ENDPOINT??process.env.TEST_STORAGE_ENDPOINT??'http://127.0.0.1:15440';
const accessKeyId=process.env.TEST_CCLX_S3_ACCESS_KEY_ID??process.env.TEST_STORAGE_ACCESS_KEY_ID??'cclxsynthetic';
const secretAccessKey=process.env.TEST_CCLX_S3_SECRET_ACCESS_KEY??process.env.TEST_STORAGE_SECRET_ACCESS_KEY??'cclx-synthetic-test-only';
async function freshBucket(){
 const bucket='cclx-lab-'+randomUUID(),url=new URL('/'+bucket,endpoint);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('LOOPBACK_MINIO_REQUIRED');
 const ready=await fetch(new URL('/minio/health/cluster',endpoint),{signal:AbortSignal.timeout(3000)});assert.equal(ready.status,200);assert.equal(ready.headers.get('x-minio-server-status'),null);await ready.body?.cancel();
 const date=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=`${day}/us-east-1/s3/aws4_request`,signed='host;x-amz-content-sha256;x-amz-date';
 const headers=`host:${url.host}\nx-amz-content-sha256:${sha('')}\nx-amz-date:${date}\n`,canonical=['PUT',url.pathname,'',headers,signed,sha('')].join('\n'),h=(k,v)=>createHmac('sha256',k).update(v).digest();
 const key=h(h(h(h('AWS4'+secretAccessKey,day),'us-east-1'),'s3'),'aws4_request'),signature=createHmac('sha256',key).update(['AWS4-HMAC-SHA256',date,scope,sha(canonical)].join('\n')).digest('hex');
 const response=await fetch(url,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(3000),headers:{'x-amz-date':date,'x-amz-content-sha256':sha(''),authorization:`AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`}});assert.equal(response.status,200);await response.body?.cancel();
 return {endpoint,bucket,accessKeyId,secretAccessKey};
}

// Actual Broker module implementations and HTTP routes; only provider download/network routing are lab ports.
for (const privateSource of [false, true]) for (const ackMode of ['HTTP', 'PERSISTENCE_RECEIPT_V1']) test(`actual partner worker ${ackMode} with ${privateSource?'private S3':'inline'} source delivers persisted media through authenticated HTTP to PG+MinIO then reconciles lost ACK with KEEP${privateSource&&ackMode==='PERSISTENCE_RECEIPT_V1'?' after receiver process crash':''}`, {timeout:180000}, async t=>{
 let broker,receiverDb,mediaState,app,pool,receiver,listener,sourceProcess,markerMoved=false;let receiverCalls=0,mediaDownloads=0,dropAck=false;const observedBodies=[];
 const crashReceiver=privateSource&&ackMode==='PERSISTENCE_RECEIPT_V1',openReceiver=crashReceiver?openLabReceiverProcess:openLabReceiver;
 let crashObservation=null,receiverRecovery=Promise.resolve();
 // Register cleanup before acquisition: a failed second database must not leave
 // the first fixture and its pool alive for the remaining test cases.
 t.after(async()=>{
  const failures=[],attempt=async work=>{try{await work();}catch(error){failures.push(error);}};
  await attempt(async()=>{listener?.closeAllConnections();if(listener)await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));});
  // Wait for the owned replacement process before closing it; no orphan on a worker timeout.
  await attempt(()=>receiverRecovery);
  await attempt(()=>sourceProcess?.close());
  await attempt(()=>receiver?.close());await attempt(()=>app?.close());await attempt(()=>pool?.end());
  await attempt(async()=>{if(markerMoved)await broker.query('ALTER TABLE cclx_fixture.cclx_lab_marker SET SCHEMA public');await broker?.dispose();});
  await attempt(()=>receiverDb?.dispose());await attempt(()=>mediaState?.dispose());
  if(failures.length)throw new AggregateError(failures,'ISOLATED_MEDIA_FIXTURE_CLEANUP_FAILED');
 });
 broker=await createIsolatedLabDatabase({labOnly:true});receiverDb=await createIsolatedLabDatabase({labOnly:true});mediaState=await createPrivateMediaState({labOnly:true});
 // Exclusive lab window; no backup/dump/restore or shared databases.
 // Keep the fixture marker outside public while real migrations enforce public ownership/grants.
 await broker.query('CREATE SCHEMA cclx_fixture');
 for(const table of ['cclx_lab_marker','cclx_lab_inbox','cclx_lab_projections','cclx_lab_media_receipts'])await broker.query('ALTER TABLE '+table+' SET SCHEMA cclx_fixture');markerMoved=true;
 const migrationLock=new Client({connectionString:broker.connectionString});await migrationLock.connect();
 try{await migrationLock.query("SELECT pg_advisory_lock(hashtextextended('jrc-test-global-roles',0))");await runMigrations(broker.connectionString);}
 finally{await migrationLock.query("SELECT pg_advisory_unlock(hashtextextended('jrc-test-global-roles',0))");await migrationLock.end();}
 const roleUrl=new URL(broker.connectionString);roleUrl.username='jrc_app';roleUrl.password='';
 pool=new Pool({connectionString:roleUrl.href,max:2,connectionTimeoutMillis:3000,statement_timeout:10000});
 const transact=(org,work)=>withOrganizationTransaction(pool,org,work),org=LAB_ORGANIZATIONS[0],channel=randomUUID(),conversation=randomUUID(),messageId=randomUUID(),apiKeyId=randomUUID();
 const hmacSecret='synthetic-worker-api-hmac-only-'.repeat(2),key=createOrganizationApiKey(org,hmacSecret),scopes=['webhooks:manage','messaging:read','media:archive'];
 const seed=new Client({connectionString:broker.connectionString});await seed.connect();
 try{await seed.query('BEGIN');
 await seed.query(`INSERT INTO organizations(id,name,slug) VALUES($1,'Synthetic worker media',$2)`,[org,'synthetic-'+randomUUID()]);
 const actor=randomUUID();await seed.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic-only')",[actor,actor+'@example.test']);await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,actor]);
 await seed.query('COMMIT');}catch(error){await seed.query('ROLLBACK');throw error;}finally{await seed.end();}
 const provider=(await broker.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'META','Synthetic fixture') RETURNING id",[org])).rows[0].id;
 await broker.query("INSERT INTO messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference) VALUES($1,$2,$3,'synthetic-worker','synthetic','vault://synthetic')",[channel,org,provider]);
 const contact=(await broker.query("INSERT INTO messaging_contacts(organization_id,external_id) VALUES($1,'synthetic-no-number') RETURNING id",[org])).rows[0].id;
 await broker.query('INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id) VALUES($1,$2,$3,$4)',[conversation,org,channel,contact]);
 await broker.query("INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'synthetic-worker',$3,$4,$5)",[apiKeyId,org,key.prefix,key.hmac,scopes]);
 const authenticateApiKey=createApiKeyService({repository:createPostgresApiKeyRepository(),hmacSecret,runInOrganizationTransaction:transact,writeAudit:async()=>{}}).authenticateApiKey;
 const secrets=createIntegrationSecrets(Buffer.alloc(32,31).toString('base64'));
 const partner=createPartnerEventService({transact,secrets}),custody=createMediaCustodyService({transact});
 const bytes=Buffer.from('%PDF-1.4\nsynthetic worker custody fixture\n%%EOF'),file={bytes:new Uint8Array(bytes),mimeType:'application/pdf',kind:'document',fileName:'synthetic-worker.pdf'};
 const encryptionKey=Buffer.alloc(32,32).toString('base64');
 let providerDownloads=0,sourcePuts=0,sourceUnavailable=false,sourceObject;
 const sourceStorage=privateSource?await freshBucket():null;
 const sourceAdapter=sourceStorage?createS3PrivateObjectStore({...sourceStorage,profile:'broker-lab',region:'us-east-1',dedicatedBucket:true,allowLoopbackHttpForTests:true}):null;
 const sourcePort=sourceAdapter?{
  destinationFingerprint:sourceAdapter.destinationFingerprint,
  async put(ref,value,expected,control){
   sourcePuts++;const result=await sourceAdapter.put(ref,value,expected,control);
   return result.outcome==='CONFIRMED'?{outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'}:result;
  },
  read:(...args)=>sourceUnavailable?Promise.resolve({outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'}):sourceAdapter.read(...args),
  inspect:(...args)=>sourceAdapter.inspect(...args),
  remove:()=>{throw Error('KEEP_MUST_NOT_DELETE');},
 }:null;
 const createFacade=()=>createMediaStore({transact,encryptionKey,download:async()=>{providerDownloads++;return file;},
  ...(sourcePort?{privateStore:createDurablePrivateMediaStore({transact,encryptionKey,profile:'broker-lab',objectStore:sourcePort,
   requestTimeoutMs:3000,cleanupTransact:()=>{throw Error('CLEANUP_OUT_OF_SCOPE');}})}:{})});
 let media=createFacade();
 const mediaId=await transact(org,tx=>registerPendingMedia(tx,org,channel,{source:'META',sourceKey:'synthetic-worker-media',kind:'document',fileName:file.fileName,descriptor:{mediaId:'11111'}}));
 if(crashReceiver){
  // This separate producer is killed after real S3 PUT but before SQL settlement.
  // It validates the exact disposable database marker and the sole synthetic media row.
  sourceProcess=await openSourceCrashProcess({labOnly:true,database:{connectionString:broker.connectionString,token:broker.token},
   scope:{organizationId:org,channelId:channel,mediaId},s3:sourceStorage});
  sourcePuts+=sourceProcess.observation.sourcePuts;providerDownloads+=sourceProcess.observation.providerDownloads;
  const terminated=await sourceProcess.crash();
  assert.ok(terminated.signal==='SIGKILL'||process.platform==='win32'&&terminated.code!==0);
  t.diagnostic(JSON.stringify({gate:'SOURCE_PROCESS_CRASH_AFTER_PUT_BEFORE_SQL_SETTLEMENT',...terminated}));
 }else await media.runOnce(org);
 if(privateSource){
  const staged=(await broker.query('SELECT status,private_object_id,storage_backend,encrypted_data FROM messaging_media WHERE id=$1',[mediaId])).rows[0];
  assert.equal(staged.status,'STORING');assert.equal(staged.storage_backend,'PRIVATE_OBJECT');assert.equal(staged.encrypted_data,null);
  assert.equal((await broker.query('SELECT state FROM media_private_operations WHERE object_id=$1',[staged.private_object_id])).rows[0].state,crashReceiver?'DISPATCHED':'UNKNOWN');
  if(crashReceiver){
   // Use the naturally expiring fixture lease; do not manufacture an expired row.
   const expires=Date.now()+10000;
   while(!(await broker.query('SELECT lease_expires_at<=clock_timestamp() AS expired FROM media_private_operations WHERE object_id=$1',[staged.private_object_id])).rows[0].expired){
    assert.ok(Date.now()<expires,'source fixture lease must expire within its bounded budget');await new Promise(resolve=>setTimeout(resolve,100));
   }
  }
  // Rebuild production modules after the lost PUT receipt; only committed state survives.
  // The process-crash scenario recovers in a newly spawned source PID, not the parent.
  if(crashReceiver){
   const previousPid=sourceProcess.pid;
   sourceProcess=await openSourceCrashProcess({labOnly:true,mode:'RECONCILE',database:{connectionString:broker.connectionString,token:broker.token},
    scope:{organizationId:org,channelId:channel,mediaId},s3:sourceStorage});
   assert.notEqual(sourceProcess.pid,previousPid);assert.equal(sourceProcess.observation.sha256,sha(bytes));
   sourcePuts+=sourceProcess.observation.sourcePuts;providerDownloads+=sourceProcess.observation.providerDownloads;
   const exit=await sourceProcess.finish();assert.equal(exit.code,0);
   t.diagnostic(JSON.stringify({gate:'SOURCE_PROCESS_RESTART_RECOVERY_FROM_PG',previousPid,restartedPid:sourceProcess.pid,exitCode:exit.code}));
   media=createFacade();
  }else{media=createFacade();await media.runOnce(org);}
  sourceObject=(await broker.query('SELECT * FROM media_private_objects WHERE id=$1',[staged.private_object_id])).rows[0];
  assert.equal(sourceObject.state,'READY');assert.equal(sourceObject.staging_ciphertext,null);
  assert.equal(sourcePuts,1,'recovery must inspect the previous PUT, never upload blindly');
  const stored=await sourceAdapter.read({organizationId:org,channelId:channel,mediaId,operationId:sourceObject.id},
   {byteLength:sourceObject.cipher_byte_length,sha256:sourceObject.cipher_sha256},{deadline:new Date(Date.now()+10000)});
  assert.equal(stored.outcome,'CONFIRMED');assert.notDeepEqual(Buffer.from(stored.bytes),bytes,'Broker storage must retain encrypted bytes');
 }
 assert.equal(providerDownloads,1);assert.equal((await broker.query('SELECT status FROM messaging_media WHERE id=$1',[mediaId])).rows[0].status,'READY');
 app=Fastify({logger:false});app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 app.addHook('onResponse',async(req,reply)=>{if(req.url.startsWith('/v1/messaging/media/')&&reply.statusCode===200)mediaDownloads++;});
 const auth={jwtSecret:hmacSecret,authenticateApiKey,resolveCurrentRole:async()=>null};
 await app.register(scope=>registerPartnerWebhookRoutes(scope,{...auth,service:partner}));
 await app.register(scope=>registerMessagingRoutes(scope,{...auth,service:{readMedia:(tenant,id)=>media.read(tenant,id)}}));
 await app.register(scope=>registerMediaCustodyRoutes(scope,{...auth,service:custody}));
 const brokerOrigin=await app.listen({host:'127.0.0.1',port:0}),headers={'x-jrc-api-key':key.secret};
 const call=async(path,init={})=>{const response=await fetch(brokerOrigin+path,{...init,headers:{...headers,...init.headers}});return {response,value:await response.json()};};
 listener=createServer(async(req,res)=>{receiverCalls++;const chunks=[];for await(const c of req)chunks.push(c);try{observedBodies.push(JSON.parse(Buffer.concat(chunks)));const result=await receiver.handle({method:req.method,path:req.url,headers:req.headers,rawBody:Buffer.concat(chunks)});if(dropAck&&result.status===202){dropAck=false;
  if(crashReceiver){
   // The child has COMMITted and read back custody; kill it before the proxy emits its ACK.
   receiverRecovery=(async()=>{const previousPid=receiver.pid;crashObservation=await receiver.crash();
    receiver=await openReceiver(receiverOptions);assert.notEqual(receiver.pid,previousPid);})();
   await receiverRecovery;
  }
  res.destroy();return;}res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.body));}catch{res.destroy();}});
 await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const target='https://cclx-lab.example.test/lab/cclx/events',created=await call('/v1/partner-webhooks',{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({url:target,ackMode})});assert.equal(created.response.status,201);
 const endpointId=created.value.endpoint.id;
 const waitForRetry=async()=>{
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   const row=(await broker.query("SELECT available_at<=clock_timestamp() AS ready FROM partner_event_deliveries WHERE organization_id=$1 AND endpoint_id=$2 AND status='PENDING'",[org,endpointId])).rows;
   assert.equal(row.length,1,'retry belongs to the one isolated synthetic event');
   if(row[0].ready)return;
   await new Promise(r=>setTimeout(r,100));
  }
  assert.fail('synthetic delivery never became due within its retry budget');
 };
 await transact(org,tx=>tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'INCOMING','CONTACT',$5,'DELIVERED')`,[messageId,org,channel,conversation,{type:'MEDIA',mediaId,kind:'document',fileName:file.fileName}]));
 const events=await call('/v1/partner-events?limit=100');assert.equal(events.response.status,200);assert.equal(events.value.data.length,1);const event=events.value.data[0];
 const receiverOptions={labOnly:true,database:receiverDb,mediaState,s3:await freshBucket(),partnerFixture:{signingSecret:created.value.signingSecret,brokerOrigin,apiKey:key.secret,endpointId,expected:{organizationId:org,channelId:channel,messageId,mediaId,sha256:sha(bytes),byteSize:bytes.length,mime:'application/pdf'}}};
 receiver=await openReceiver({...receiverOptions,partnerFixture:{...receiverOptions.partnerFixture,signingSecret:'synthetic-wrong-signing-secret'}});
 const worker=createPartnerEventWorker({transact,openSecret:claim=>secrets.decrypt(`partner-webhook:${claim.organizationId}:${claim.endpointId}`,claim.encryptedSecret),send:async(url,init)=>{assert.equal(url,target);return fetch(`http://127.0.0.1:${listener.address().port}/lab/cclx/events`,init);}});
 assert.equal(await worker.processOne(org),true);
 const rejected=await call('/v1/partner-webhook-deliveries?limit=100');assert.equal(rejected.value.data[0].status,'FAILED');assert.equal(rejected.value.data[0].lastErrorCode,'HTTP_401');assert.equal((await receiver.stats()).inbox,0);
 assert.equal(await worker.processOne(org),false,'terminal auth failure must never replay blindly');
 const replay=await call(`/v1/partner-webhook-deliveries/${rejected.value.data[0].id}/replay`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:'{}'});assert.equal(replay.response.status,200);assert.equal(replay.value.replay.eventId,event.eventId);
 await receiver.close();receiver=await openReceiver(receiverOptions);
 await assert.rejects(openLabReceiver({...receiverOptions,partnerFixture:{...receiverOptions.partnerFixture,brokerOrigin:'https://remote.example.test'}}),/INVALID_WORKER_FIXTURE/);
 if(privateSource){
  // An unavailable source must not produce a media-custody receipt or a positive ACK.
  sourceUnavailable=true;assert.equal(await worker.processOne(org),true);sourceUnavailable=false;
  assert.equal((await receiver.stats()).mediaReceipts,0);assert.equal((await receiver.stats()).inbox,0);
  assert.equal((await broker.query('SELECT count(*)::int AS n FROM media_custody_receipts WHERE organization_id=$1',[org])).rows[0].n,0);
  const unavailable=await call('/v1/partner-webhook-deliveries?limit=100');assert.equal(unavailable.value.data[0].status,'PENDING');
  await waitForRetry();
 }
 dropAck=true;assert.equal(await worker.processOne(org),true);
 await receiverRecovery;
 if(crashReceiver){
  assert.ok(crashObservation?.pid>0,'separate receiver process was killed after its durable result');
  assert.ok(crashObservation.signal==='SIGKILL'||process.platform==='win32'&&crashObservation.code!==0,
   'record actual OS termination; Windows process kill is not a POSIX SIGKILL claim');
  t.diagnostic(JSON.stringify({gate:'RECEIVER_PROCESS_CRASH_AFTER_COMMIT_BEFORE_ACK',...crashObservation,restartedPid:receiver.pid}));
 }
 let deliveries=await call('/v1/partner-webhook-deliveries?limit=100');assert.equal(deliveries.value.data[0].status,'PENDING','lost ACK after durable receiver COMMIT must retain retry');
 assert.equal((await receiver.stats()).mediaReceipts,1,'real worker envelope must persist physical custody before reply loss');
 const receipt=await receiver.readMediaReceipt(event.eventId);assert.equal(receipt.storage,'S3');assert.equal(receipt.retention,'KEEP');assert.equal(receipt.readbackVerified,true);
 const receiverEvent=await receiver.readEvent(event.eventId);assert.deepEqual(receiverEvent,observedBodies[0],'persist exact real worker envelope, no synthetic remapping');assert.equal(new Date(receiverEvent.occurredAt).toISOString(),event.occurredAt);
 await waitForRetry();assert.equal(await worker.processOne(org),true);deliveries=await call('/v1/partner-webhook-deliveries?limit=100');assert.equal(deliveries.value.data[0].status,'DELIVERED');assert.equal(deliveries.value.data[0].attempts,privateSource?3:2);assert.equal(receiverCalls,privateSource?4:3);
 assert.equal(deliveries.value.data[0].ackMode,ackMode);
 if(ackMode==='PERSISTENCE_RECEIPT_V1'){
  const accepted=deliveries.value.data[0].persistenceReceipt;
  assert.equal(accepted.schemaVersion,1);
  assert.equal(accepted.receiptId,receipt.eventReceiptId,'receipt identity must survive receiver commit followed by lost ACK');
  assert.equal(accepted.persistedAt,receipt.committedAt);
 }else assert.equal(deliveries.value.data[0].persistenceReceipt,null,'legacy transport ACK must not invent a persistence receipt');
 const stats=await call('/v1/partner-webhook-delivery-stats');assert.equal(stats.response.status,200);assert.equal(stats.value.replays,1);assert.equal(stats.value.lifetimeAttempts,privateSource?4:3);assert.equal(stats.value.counts.DELIVERED,1);
 assert.deepEqual(await receiver.readMediaReceipt(event.eventId),receipt);assert.deepEqual(await receiver.stats(),{inbox:1,projections:1,mediaReceipts:1});
 assert.equal(mediaDownloads,2,'retry must download authenticated actual Broker bytes again');
 const independent=createS3PrivateObjectStore({...receiverOptions.s3,profile:'cclx-lab',region:'us-east-1',dedicatedBucket:true,allowLoopbackHttpForTests:true});
 const readback=await independent.read({organizationId:org,channelId:'00000000-0000-4000-8000-000000000920',mediaId:event.eventId,operationId:event.eventId},{byteLength:bytes.length,sha256:sha(bytes)},{deadline:new Date(Date.now()+10000)});
 assert.equal(readback.outcome,'CONFIRMED');assert.deepEqual(Buffer.from(readback.bytes),bytes,'independent actual MinIO read preserves plaintext fixture bytes');
 const attestation=(await broker.query('SELECT id FROM media_custody_receipts WHERE organization_id=$1',[org])).rows;assert.equal(attestation.length,1);
 const keep=await call(`/v1/media-custody/receipts/${attestation[0].id}/retention`);assert.equal(keep.response.status,200);assert.equal(keep.value.policy,'KEEP');assert.equal(keep.value.eligibleForDeletion,false);assert.equal(keep.value.physicalStorageVerified,false);
 const denied=await fetch(brokerOrigin+'/v1/messaging/media/'+mediaId);assert.equal(denied.status,401);await denied.body?.cancel();
 if(privateSource){
  assert.equal(sourcePuts,1);assert.equal(providerDownloads,1);
  const retained=(await broker.query('SELECT state,reserved_bytes FROM media_private_objects WHERE id=$1',[sourceObject.id])).rows[0];
  assert.equal(retained.state,'READY');assert.equal(retained.reserved_bytes,bytes.length);
  assert.equal((await broker.query("SELECT count(*)::int AS n FROM media_private_operations WHERE object_id=$1 AND kind='DELETE'",[sourceObject.id])).rows[0].n,0);
  const retainedBytes=await sourceAdapter.read({organizationId:org,channelId:channel,mediaId,operationId:sourceObject.id},
   {byteLength:sourceObject.cipher_byte_length,sha256:sourceObject.cipher_sha256},{deadline:new Date(Date.now()+10000)});
  assert.equal(retainedBytes.outcome,'CONFIRMED','KEEP retains the physical source after receiver custody');
  assert.deepEqual(Buffer.from((await media.read(org,mediaId)).bytes),bytes);
 }
});
