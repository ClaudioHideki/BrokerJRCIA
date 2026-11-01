import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createIsolatedLabDatabase,createPrivateMediaState} from './state.mjs';
import {openLabReceiver,LAB_ORGANIZATIONS,LAB_SECRET} from './receiver.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const endpoint=process.env.TEST_CCLX_S3_ENDPOINT??process.env.TEST_STORAGE_ENDPOINT??'http://127.0.0.1:15440';
const accessKeyId=process.env.TEST_CCLX_S3_ACCESS_KEY_ID??process.env.TEST_STORAGE_ACCESS_KEY_ID??'cclxsynthetic',secretAccessKey=process.env.TEST_CCLX_S3_SECRET_ACCESS_KEY??process.env.TEST_STORAGE_SECRET_ACCESS_KEY??'cclx-synthetic-test-only';
const testUrl=new URL(endpoint);if(!['127.0.0.1','localhost','[::1]'].includes(testUrl.hostname)||testUrl.username||testUrl.password||testUrl.pathname!=='/'||testUrl.search||testUrl.hash)throw Error('UNSAFE_LAB_S3_TEST_ENDPOINT');
const bytes=Buffer.from('%PDF-1.4\nsynthetic CCLX MinIO fixture\n%%EOF'),eventId='00000000-0000-4000-8000-000000260001',organizationId=LAB_ORGANIZATIONS[0];
async function bucketCreate(bucket,objectName,body=Buffer.alloc(0)){
 const url=new URL('/'+bucket+(objectName?'/'+objectName:''),endpoint),date=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=`${day}/us-east-1/s3/aws4_request`;
 const headers=`host:${url.host}\nx-amz-content-sha256:${sha(body)}\nx-amz-date:${date}\n`,signed='host;x-amz-content-sha256;x-amz-date';
 const canonical=['PUT',url.pathname,'',headers,signed,sha(body)].join('\n'),h=(k,v)=>createHmac('sha256',k).update(v).digest();
 const key=h(h(h(h('AWS4'+secretAccessKey,day),'us-east-1'),'s3'),'aws4_request');
 const signature=createHmac('sha256',key).update(['AWS4-HMAC-SHA256',date,scope,sha(canonical)].join('\n')).digest('hex');
 const response=await fetch(url,{method:'PUT',body,redirect:'error',signal:AbortSignal.timeout(5000),headers:{'x-amz-date':date,'x-amz-content-sha256':sha(body),authorization:`AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`}});
 assert.equal(response.status,200);await response.body?.cancel();
}
async function harness(t){
 const database=await createIsolatedLabDatabase({labOnly:true}),mediaState=await createPrivateMediaState({labOnly:true});
 const s3={endpoint,bucket:'cclx-lab-'+randomUUID(),accessKeyId,secretAccessKey};await bucketCreate(s3.bucket);
 let receiver; t.after(async()=>{await receiver?.close();await database.dispose();await mediaState.dispose();});
 const restart=async()=>{await receiver?.close();receiver=await openLabReceiver({labOnly:true,database,mediaState,s3});};await restart();
 const rawBody=Buffer.from(JSON.stringify({schemaVersion:1,eventId,cursor:'1',organizationId,type:'message.received',occurredAt:'2026-11-01T00:00:00.000Z',data:{labFixture:true,sequence:1}})),ts=String(Math.floor(Date.now()/1000));
 assert.equal((await receiver.handle({method:'POST',path:'/lab/cclx/events',rawBody,headers:{'content-type':'application/json','x-jrc-event-id':eventId,'x-jrc-timestamp':ts,'x-jrc-signature':'sha256='+createHmac('sha256',LAB_SECRET).update(`${ts}.${eventId}.`).update(rawBody).digest('hex')}})).status,202);
 return {database,mediaState,s3,restart,get receiver(){return receiver;}};
}
const media=(extra={})=>({eventId,organizationId,expectedHash:sha(bytes),mime:'application/pdf',maxBytes:1024,chunks:(async function*(){yield bytes;})(),...extra});

test('S3 custody receipt follows readback and synchronous SQL commit, survives ACK loss and retains KEEP',async t=>{
 const h=await harness(t);
 const receipt=await h.receiver.persistMedia(media());
 assert.equal(receipt.storage,'S3');assert.equal(receipt.retention,'KEEP');assert.equal(receipt.sourceEligibleForDeletion,false);
 assert.equal(receipt.hash,sha(bytes));assert.equal(receipt.readbackVerified,true);
 assert.deepEqual((await h.database.query('SELECT receipt FROM cclx_lab_media_receipts')).rows[0].receipt,receipt);
 await h.restart();assert.deepEqual(await h.receiver.persistMedia(media()),receipt);
});

test('S3 object before SQL failure remains orphan KEEP and is adopted by retry; lost receipt ACK is idempotent',async t=>{
 const h=await harness(t);
 await assert.rejects(h.receiver.persistMedia(media({fault:'afterObjectUpload'})),/SYNTHETIC_AFTER_OBJECT_UPLOAD/);
 assert.equal(await h.receiver.readMediaReceipt(eventId),null);await h.restart();
 await assert.rejects(h.receiver.persistMedia(media({fault:'afterReceiptCommit'})),/SYNTHETIC_LOST_MEDIA_ACK/);
 const receipt=await h.receiver.readMediaReceipt(eventId);assert.equal(receipt.storage,'S3');await h.restart();
 assert.deepEqual(await h.receiver.persistMedia(media()),receipt);assert.equal((await h.receiver.stats()).mediaReceipts,1);
 await assert.rejects(h.receiver.persistMedia(media({expectedHash:'1'.repeat(64)})),/MEDIA_CONTENT_CONFLICT/);
});

test('S3 receipt is not issued when actual SQL commit is rejected after durable upload',async t=>{
 const h=await harness(t);
 await h.database.query(`CREATE FUNCTION reject_s3_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SQL_COMMIT_REJECTED'; END $$;
 CREATE CONSTRAINT TRIGGER reject_s3_receipt AFTER INSERT ON cclx_lab_media_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_s3_commit();`);
 await assert.rejects(h.receiver.persistMedia(media()),/SYNTHETIC_SQL_COMMIT_REJECTED/);
 assert.equal(await h.receiver.readMediaReceipt(eventId),null);
 await h.database.query('DROP TRIGGER reject_s3_receipt ON cclx_lab_media_receipts');
 await h.restart();const receipt=await h.receiver.persistMedia(media());assert.equal(receipt.storage,'S3');assert.equal(receipt.sourceEligibleForDeletion,false);
});

test('S3 mode refuses remote destinations and non-dedicated buckets before contact',async t=>{
 const h=await harness(t);
 for(const patch of [{endpoint:'https://remote.example.test'},{bucket:'campaign-existing'},{endpoint:'http://127.0.0.1:15440/?redirect=remote'}])
  await assert.rejects(openLabReceiver({labOnly:true,database:h.database,mediaState:h.mediaState,s3:{...h.s3,...patch}}),/UNSAFE_LAB_S3/);
});

test('S3 destination change cannot return an earlier custody receipt from SQL',async t=>{
 const h=await harness(t);await h.receiver.persistMedia(media());
 const s3={...h.s3,bucket:'cclx-lab-'+randomUUID()};await bucketCreate(s3.bucket);
 const other=await openLabReceiver({labOnly:true,database:h.database,mediaState:h.mediaState,s3});
 try{await assert.rejects(other.persistMedia(media()),/MEDIA_DESTINATION_CONFLICT/);}finally{await other.close();}
 assert.equal((await h.receiver.stats()).mediaReceipts,1);
});


test('S3 retry detects corrupted object bytes and never claims successful readback',async t=>{
 const h=await harness(t),receipt=await h.receiver.persistMedia(media());
 await bucketCreate(h.s3.bucket,receipt.objectName,Buffer.from('synthetic-corruption'));
 await assert.rejects(h.receiver.persistMedia(media()),/OBJECT_INTEGRITY_FAILED|OBJECT_LIMIT_EXCEEDED/);
 assert.equal((await h.receiver.stats()).mediaReceipts,1);
});

test('switching S3 receipts to filesystem cannot issue an apparently successful custody ACK',async t=>{
 const h=await harness(t);await h.receiver.persistMedia(media());
 const filesystem=await openLabReceiver({labOnly:true,database:h.database,mediaState:h.mediaState});
 try{await assert.rejects(filesystem.persistMedia(media()),/MEDIA_DESTINATION_CONFLICT/);}finally{await filesystem.close();}
});


test('S3 override cannot replace the guarded transport or inject production configuration',async()=>{
 const {createLabS3Custody}=await import('./s3-custody.mjs');
 const config={endpoint:'http://127.0.0.1:15440',bucket:'cclx-lab-00000000-0000-4000-8000-000000000000',accessKeyId,secretAccessKey};
 assert.throws(()=>createLabS3Custody({...config,fetch:async()=>new Response('synthetic')},{labOnly:true}),/UNSAFE_LAB_S3/);
 assert.throws(()=>createLabS3Custody(config,{labOnly:false}),/LAB_ONLY_REQUIRED/);
 assert.throws(()=>createLabS3Custody(config,{labOnly:true,environment:'production'}),/PRODUCTION_REFUSED/);
});

test('concurrent filesystem loser cannot return S3 winner receipt after both observed no previous receipt',async t=>{
 const {poolFor}=await import('./state.mjs');
 const h=await harness(t),gatePool=poolFor(h.database.connectionString),gate=await gatePool.connect();
 const filesystem=await openLabReceiver({labOnly:true,database:h.database,mediaState:h.mediaState});
 const gateKey=260191;let pending;
 try{
  await gate.query('SELECT pg_advisory_lock($1)',[gateKey]);
  await h.database.query(`CREATE FUNCTION wait_filesystem_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.receipt->>'storage' IS NULL THEN PERFORM pg_advisory_xact_lock(${gateKey}); END IF; RETURN NEW; END $$;
   CREATE TRIGGER wait_filesystem_receipt BEFORE INSERT ON cclx_lab_media_receipts FOR EACH ROW EXECUTE FUNCTION wait_filesystem_receipt()`);
  pending=filesystem.persistMedia(media());pending.catch(()=>{});
  const deadline=Date.now()+10000;let blocked=false;
  while(Date.now()<deadline){
   blocked=(await h.database.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') AS blocked")).rows[0].blocked;
   if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(blocked,true,'filesystem insert must reach actual PG advisory wait before S3 starts');
  const winner=await h.receiver.persistMedia(media());assert.equal(winner.storage,'S3');
  await gate.query('SELECT pg_advisory_unlock($1)',[gateKey]);
  await assert.rejects(pending,/MEDIA_DESTINATION_CONFLICT/);
  assert.deepEqual(await h.receiver.readMediaReceipt(eventId),winner);
 }finally{
  await gate.query('SELECT pg_advisory_unlock($1)',[gateKey]);
  await pending?.catch(()=>{});await filesystem.close();gate.release();await gatePool.end();
 }
});
