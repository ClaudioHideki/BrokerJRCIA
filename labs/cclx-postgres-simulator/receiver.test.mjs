import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createIsolatedLabDatabase, createPrivateMediaState, requireTestDatabaseUrl } from './state.mjs';
import { openLabReceiver, LAB_ORGANIZATIONS, LAB_SECRET } from './receiver.mjs';

const id='00000000-0000-4000-8000-000000250001', now=Date.parse('2026-11-01T12:00:00Z');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=Buffer.from('%PDF-1.4\n% synthetic bytes only, no codec validation\n%%EOF');
const envelope=(patch={})=>({schemaVersion:1,eventId:id,cursor:'9223372036854775807',organizationId:LAB_ORGANIZATIONS[0],type:'message.received',occurredAt:'2026-11-01T00:00:00.000Z',data:{labFixture:true,sequence:1},...patch});
function request(value=envelope(),timestamp=String(now/1000)){
  const rawBody=Buffer.from(JSON.stringify(value));
  return {method:'POST',path:'/lab/cclx/events',rawBody,headers:{'content-type':'application/json','x-jrc-event-id':value.eventId,
    'x-jrc-timestamp':timestamp,'x-jrc-signature':'sha256='+createHmac('sha256',LAB_SECRET).update(`${timestamp}.${value.eventId}.`).update(rawBody).digest('hex')}};
}
async function harness(t,options={}){
  const database=await createIsolatedLabDatabase({labOnly:true}),mediaState=await createPrivateMediaState({labOnly:true});
  let receiver=await openLabReceiver({labOnly:true,database,mediaState,now:()=>now,...options});
  t.after(async()=>{await receiver.close();await database.dispose();await mediaState.dispose();});
  return {database,mediaState,get receiver(){return receiver;},async restart(extra={}){await receiver.close();receiver=await openLabReceiver({labOnly:true,database,mediaState,now:()=>now,...extra});}};
}
const media=(extra={})=>({organizationId:LAB_ORGANIZATIONS[0],eventId:id,expectedHash:hash(bytes),mime:'application/pdf',maxBytes:1024,
  chunks:(async function*(){yield bytes;})(),...extra});

test('requires an explicit test database, production refusal, loopback and disposable test name',()=>{
  assert.throws(()=>requireTestDatabaseUrl({DATABASE_URL:'postgresql://ignored:ignored@127.0.0.1/production'}),/TEST_DATABASE_ADMIN_URL_REQUIRED/);
  for(const url of ['postgresql://test:test@remote.example.test/lab_broker_ci','postgresql://test:test@127.0.0.1/production','postgresql://test:test@127.0.0.1/lab_broker_ci?host=remote.example.test'])
    assert.throws(()=>requireTestDatabaseUrl({TEST_DATABASE_ADMIN_URL:url}),/UNSAFE_TEST_DATABASE/);
  assert.throws(()=>requireTestDatabaseUrl({NODE_ENV:'production',TEST_DATABASE_ADMIN_URL:'postgresql://test:test@127.0.0.1/lab_broker_ci'}),/PRODUCTION_REFUSED/);
});

test('HMAC authenticates raw bytes, event ID and timestamp before any durable acceptance',async t=>{
  const h=await harness(t),valid=request();
  for(const bad of [{...valid,rawBody:Buffer.concat([valid.rawBody,Buffer.from(' ')])},request(envelope(),String(now/1000-301)),
    {...valid,headers:{...valid.headers,'x-jrc-event-id':'00000000-0000-4000-8000-000000250002'}}])
    assert.equal((await h.receiver.handle(bad)).status,401);
  assert.equal((await h.receiver.handle(request(envelope({organizationId:'00000000-0000-4000-8000-999999999999'})))).status,403);
  assert.deepEqual(await h.receiver.stats(),{inbox:0,projections:0,mediaReceipts:0});
});

test('opening a receiver refuses missing lab permission and mismatched database/filesystem markers',async t=>{
  const h=await harness(t),options={labOnly:true,database:h.database,mediaState:h.mediaState};
  await assert.rejects(openLabReceiver({...options,labOnly:false}),/LAB_ONLY_REQUIRED/);
  await assert.rejects(openLabReceiver({...options,database:{...h.database,token:'00000000-0000-4000-8000-000000000000'}}),/LAB_DATABASE_MARKER_MISMATCH/);
  await assert.rejects(openLabReceiver({...options,mediaState:{...h.mediaState,token:'wrong-marker'}}),/INVALID_LAB_MEDIA_STATE/);
});

test('inbox and projection roll back together; ACK follows durable commit visible from a separate connection',async t=>{
  const h=await harness(t,{faults:['afterInboxInsert']});
  assert.equal((await h.receiver.handle(request())).status,500);
  assert.deepEqual(await h.receiver.stats(),{inbox:0,projections:0,mediaReceipts:0});
  assert.equal((await h.receiver.handle(request())).status,202);
  const rows=await h.database.query('SELECT (SELECT count(*)::int FROM cclx_lab_inbox) inbox,(SELECT count(*)::int FROM cclx_lab_projections) projections');
  assert.deepEqual(rows.rows[0],{inbox:1,projections:1});
});

test('durable acceptance and media receipts override an asynchronous database commit default',async t=>{
  const h=await harness(t),name=new URL(h.database.connectionString).pathname.slice(1);
  assert.match(name,/^jrc_test_cclx_[a-f0-9]{32}$/);
  await h.database.query(`ALTER DATABASE "${name}" SET synchronous_commit=off`);
  await h.database.query(`CREATE FUNCTION cclx_lab_require_sync_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('synchronous_commit')<>'on' THEN RAISE EXCEPTION 'CCLX_LAB_ASYNC_COMMIT_REFUSED'; END IF; RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER cclx_lab_projection_sync AFTER INSERT ON cclx_lab_projections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cclx_lab_require_sync_commit();
    CREATE CONSTRAINT TRIGGER cclx_lab_receipt_sync AFTER INSERT ON cclx_lab_media_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cclx_lab_require_sync_commit();`);
  await h.restart();
  assert.equal((await h.receiver.handle(request())).status,202);
  const receipt=await h.receiver.persistMedia(media());
  assert.equal(receipt.hash,hash(bytes));
});

test('concurrent duplicate requests have one logical effect; changed payload conflicts and tenant identity is separate',async t=>{
  const h=await harness(t),responses=await Promise.all(Array.from({length:5},()=>h.receiver.handle(request())));
  assert.ok(responses.every(r=>r.status===202));
  assert.equal(responses.filter(r=>!r.body.duplicate).length,1);
  assert.equal((await h.receiver.handle(request(envelope({data:{labFixture:true,sequence:2}})))).status,409);
  assert.equal((await h.receiver.handle(request(envelope({organizationId:LAB_ORGANIZATIONS[1]})))).status,202);
  assert.deepEqual(await h.receiver.stats(),{inbox:2,projections:2,mediaReceipts:0});
  assert.equal((await h.receiver.readEvent(id,LAB_ORGANIZATIONS[1])).organizationId,LAB_ORGANIZATIONS[1]);
});

test('commit with lost ACK survives pool close/reopen and retry never creates a second projection',async t=>{
  const h=await harness(t,{faults:['lostAckAfterCommit']});
  await assert.rejects(h.receiver.handle(request()),/SYNTHETIC_LOST_ACK/);
  await h.restart();
  assert.deepEqual(await h.receiver.readEvent(id),envelope());
  assert.deepEqual(await h.receiver.handle(request()),{status:202,body:{status:'accepted',duplicate:true}});
  assert.deepEqual(await h.receiver.stats(),{inbox:1,projections:1,mediaReceipts:0});
});

test('close immediately refuses new requests and drains a request admitted before closing',async t=>{
  const h=await harness(t),accepted=h.receiver.handle(request()),closing=h.receiver.close();
  await assert.rejects(async()=>h.receiver.handle(request()),/LAB_RECEIVER_CLOSED/);
  assert.equal((await accepted).status,202);
  await closing;await h.restart();
  assert.deepEqual(await h.receiver.stats(),{inbox:1,projections:1,mediaReceipts:0});
});

test('media cannot receipt absent inbox, interrupted download, excess bytes, MIME mismatch or wrong hash',async t=>{
  const h=await harness(t);
  await assert.rejects(h.receiver.persistMedia(media()),/EVENT_NOT_PERSISTED/);
  await h.receiver.handle(request());
  await assert.rejects(h.receiver.persistMedia(media({chunks:(async function*(){yield bytes.subarray(0,4);throw Error('SYNTHETIC_INTERRUPTED');})()})),/SYNTHETIC_INTERRUPTED/);
  await assert.rejects(h.receiver.persistMedia(media({maxBytes:4})),/LIMIT_EXCEEDED/);
  await assert.rejects(h.receiver.persistMedia(media({expectedHash:'0'.repeat(64)})),/HASH_MISMATCH/);
  await assert.rejects(h.receiver.persistMedia(media({mime:'image/png'})),/MIME_REJECTED/);
  assert.equal(await h.receiver.readMediaReceipt(id),null);
  assert.deepEqual(await h.receiver.stats(),{inbox:1,projections:1,mediaReceipts:0});
});

test('file sync before receipt crash is recovered by adopting verified bytes; receipt ACK loss survives reopen',async t=>{
  const h=await harness(t);await h.receiver.handle(request());
  await assert.rejects(h.receiver.persistMedia(media({fault:'afterFileSync'})),/SYNTHETIC_AFTER_FILE_SYNC/);
  assert.equal(await h.receiver.readMediaReceipt(id),null);
  await h.restart();
  await assert.rejects(h.receiver.persistMedia(media({fault:'afterReceiptCommit'})),/SYNTHETIC_LOST_MEDIA_ACK/);
  await h.restart();
  const receipt=await h.receiver.readMediaReceipt(id);
  assert.equal(receipt.hash,hash(bytes));assert.equal(receipt.sourceEligibleForDeletion,false);
  assert.equal(receipt.validation,'SIGNATURE_ONLY_NO_CODEC_VALIDATION');
  assert.deepEqual(await readFile(join(h.mediaState.directory,receipt.objectName)),bytes);
  assert.deepEqual(await h.receiver.persistMedia(media()),receipt);
  await assert.rejects(h.receiver.persistMedia(media({expectedHash:'1'.repeat(64)})),/MEDIA_CONTENT_CONFLICT/);
  assert.deepEqual(await h.receiver.stats(),{inbox:1,projections:1,mediaReceipts:1});
  await writeFile(join(h.mediaState.directory,receipt.objectName),'SYNTHETIC_CORRUPTION');
  await assert.rejects(h.receiver.persistMedia(media()),/STORED_MEDIA_CORRUPTED/);
});
