import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createHistoryMediaWorker } from '../src/history-media-worker.mjs';
import { historyCaptureScopeKey } from '../src/history-projection.mjs';

const bytes = Buffer.from('synthetic-media-worker-bytes');
const fixture = () => {
  const scope = Object.freeze({ organizationId:randomUUID(),channelId:randomUUID(),instanceId:randomUUID(),engineId:'synthetic',engineGeneration:1,
    sessionGeneration:randomUUID(),bindingFingerprint:'a'.repeat(64),identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null }), runId=randomUUID();
  const claim = { scopeKey:historyCaptureScopeKey(scope),runId,leaseToken:randomUUID(),reference:{referenceId:randomUUID(),byteSize:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'IMAGE',mimeType:'image/png',filename:'synthetic.png',caption:''},
    descriptor:{mediaType:'IMAGE',directPath:'/v/synthetic.enc',mediaKey:Buffer.alloc(32).toString('base64')} };
  const calls=[];
  const journal={claimMedia:async()=>claim,retryMedia:async(_s,_c,code)=>{calls.push(code);return true;},
    settleMedia:async(_s,_c,receipt,_now,authority)=>{await authority({},scope);calls.push(receipt);return receipt.persisted===true;}};
  const authority=async()=>{calls.push('AUTHORITY');};
  const download=async()=>({async *[Symbol.asyncIterator](){yield bytes.subarray(0,5);yield bytes.subarray(5);}});
  const persist=async(reference,value)=>{assert.deepEqual(value,bytes);return {protocol:'jrc-history-media/2',persisted:true,
    scopeKey:claim.scopeKey,runId,referenceId:reference.referenceId,sha256:reference.sha256,byteSize:reference.byteSize};};
  return {scope,runId,claim,calls,journal,authority,download,persist};
};
test('latches source authority before claim await and never copies old media under a changed tenant',async()=>{
  const f=fixture(),mutable={...f.scope};let release,seen;
  const journal={...f.journal,claimMedia:()=>new Promise(resolve=>{release=()=>resolve(f.claim);})};
  const worker=createHistoryMediaWorker({journal,assertCurrentScope:f.authority,download:f.download,persist:async(r,b,context)=>{
    seen=context.scope;return f.persist(r,b);
  }});
  const running=worker.runOnce(mutable,f.runId,new Date());
  Object.assign(mutable,{organizationId:randomUUID(),channelId:randomUUID(),sessionGeneration:randomUUID()});release();
  assert.equal((await running).kind,'READY');assert.deepEqual(seen,f.scope);
});
test('streams bounded source bytes, verifies plaintext integrity and requires a correlated physical receipt',async()=>{
  const f=fixture(),worker=createHistoryMediaWorker({journal:f.journal,assertCurrentScope:f.authority,download:f.download,persist:f.persist});
  assert.equal((await worker.runOnce(f.scope,f.runId,new Date())).kind,'READY');
  assert.equal(f.calls.filter(v=>v==='AUTHORITY').length,3);
});
test('truncation, excess bytes or corrupt plaintext cannot be uploaded or acknowledged',async()=>{
  for(const value of [bytes.subarray(1),Buffer.concat([bytes,Buffer.from('overflow')]),Buffer.alloc(bytes.length)]) {
    const f=fixture(); let persisted=false;
    const worker=createHistoryMediaWorker({journal:f.journal,assertCurrentScope:f.authority,
      download:async()=>({async *[Symbol.asyncIterator](){yield value;}}),persist:async()=>{persisted=true;return {};}});
    assert.equal((await worker.runOnce(f.scope,f.runId,new Date())).kind,'RETRY');
    assert.equal(persisted,false);assert.ok(f.calls.includes('INTEGRITY_FAILED'));
  }
});
test('network errors stay pending and never expose raw URLs or keys in results',async()=>{
  const f=fixture(),worker=createHistoryMediaWorker({journal:f.journal,assertCurrentScope:f.authority,
    download:async()=>{throw Error('https://private.invalid/key=SYNTHETIC_SECRET');},persist:f.persist});
  const result=await worker.runOnce(f.scope,f.runId,new Date());
  assert.deepEqual(result,{kind:'RETRY',code:'DOWNLOAD_FAILED'});
  assert.doesNotMatch(JSON.stringify(result),/private|SECRET|mediaKey/u);
});
test('an aborted download cannot hold the history worker forever while a stream stops producing bytes',async()=>{
  const f=fixture(),abort=new AbortController();let release;
  const stream={async *[Symbol.asyncIterator](){await new Promise(resolve=>{release=resolve;});yield bytes;}};
  const worker=createHistoryMediaWorker({journal:f.journal,assertCurrentScope:f.authority,download:async()=>stream,persist:f.persist});
  const running=worker.runOnce(f.scope,f.runId,new Date(),{signal:abort.signal});
  await new Promise(setImmediate);abort.abort();
  try {
    const value=await Promise.race([running,new Promise(resolve=>setTimeout(()=>resolve({kind:'STUCK'}),100))]);
    assert.equal(value.kind,'RETRY');
  } finally {release();await running;}
});
// Real HTTP/abort/redirect/CBC/MAC proof replaces the old mock-only adapter assertion
// in history-media-download.test.mjs; Baileys drops RequestInit controls internally.
test('revocation stops the worker before download and an HTTP-only acceptance never settles custody',async()=>{
  const f=fixture();let downloaded=false;
  const worker=createHistoryMediaWorker({journal:f.journal,assertCurrentScope:async()=>{throw Error('revoked');},
    download:async()=>{downloaded=true;return f.download();},persist:f.persist});
  assert.deepEqual(await worker.runOnce(f.scope,f.runId,new Date()),{kind:'RETRY',code:'AUTHORITY_CHANGED'});
  assert.equal(downloaded,false);
  const other=createHistoryMediaWorker({journal:{...f.journal,settleMedia:async()=>false},assertCurrentScope:f.authority,download:f.download,persist:async()=>({status:202})});
  assert.deepEqual(await other.runOnce(f.scope,f.runId,new Date()),{kind:'RETRY',code:'PERSISTENCE_UNCERTAIN'});
});
