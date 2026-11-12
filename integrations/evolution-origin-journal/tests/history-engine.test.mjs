import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Pool } from 'pg';
import { withOriginEngineLabHost, awaitOriginEngineReady } from '../src/engine-host.mjs';
import { createOriginEngineComposition } from '../src/engine-composition.mjs';
import { createOriginJournal, installOriginJournal, bindingFingerprint } from '../src/journal.mjs';
import { historyCaptureScopeKey } from '../src/history-projection.mjs';
import { compileEngineFixture } from './engine-fixture.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';

let pool, admin, database;
const key = Buffer.alloc(32, 95), enabled = { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true', HISTORY_SYNC_V2_ENABLED: 'true' };
before(async () => {
  const url = validateTestAdminUrl(process.env.TEST_DATABASE_ADMIN_URL);
  database = `jrc_test_history_engine_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: url.href, max: 1 }); await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href, max: 4 }); await installOriginJournal(pool);
});
after(async () => { await pool?.end(); try { if (admin && database) await admin.query(`DROP DATABASE "${database}"`); } finally { await admin?.end(); } });

test('the compiled pinned socket callback seals history synchronously and commits it through the source journal before legacy work', async () => {
  const binding = { instanceId: randomUUID(), instanceName: `Synthetic-${randomUUID()}`, generation: 1, destinationId: randomUUID(), revision: 1 };
  const scope = { organizationId: randomUUID(), channelId: randomUUID(), instanceId: binding.instanceId, engineId: 'synthetic-engine', engineGeneration: 1,
    sessionGeneration: randomUUID(), bindingFingerprint: bindingFingerprint(binding), identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null };
  const endpoint = `https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`, runId = randomUUID();
  const fixture = await compileEngineFixture({ endpoint });
  const journal = createOriginJournal({ pool, encryptionKey: key, history: { maxStagedBytes: 2000000 } });
  const history = { scope, runId };
  await withOriginEngineLabHost({ labOnly: true, env: enabled, prepareInstance: async () => ({ pool, journal, binding,
    resolveBinding: async () => binding, history, transport: { endpoint, bearerToken: 'synthetic-test-only' } }) }, async () => {
    const engine = fixture.create(binding); await awaitOriginEngineReady(engine.instance);
    history.runId = randomUUID(); // Attached host authority must remain latched.
    let legacyObservedCommitted = false;
    engine.instance.messageHandle['messaging-history.set'] = async () => { legacyObservedCommitted = (await journal.history.pending(scope)).length === 1; };
    const event = { 'messaging-history.set': { isLatest: true, progress: 100, chats: [], contacts: [], messages: [{
      key: { id: 'synthetic-engine-history', remoteJid: `${'1'.repeat(11)}@s.whatsapp.net`, fromMe: false },
      messageTimestamp: 1600000000, message: { conversation: 'Original socket text' },
    }] } };
    const capturing = engine.emit(event);
    event['messaging-history.set'].messages[0].message.conversation = 'Mutation after callback';
    await capturing;
    const [pending] = await journal.history.pending(scope);
    assert.equal(pending?.chunk.records[0].content.text, 'Original socket text');
    assert.equal(pending.runId, runId);
    assert.equal(legacyObservedCommitted, true);
    assert.equal((await awaitOriginEngineReady(engine.instance)).deliveryOwnership, 'UNPROVEN');
  });
});

test('history opt-in refuses a mismatched engine identity instead of admitting another instance history', () => {
  const binding = { instanceId: randomUUID(), instanceName: 'Synthetic mismatch', generation: 1, destinationId: randomUUID(), revision: 1 };
  const scope = { instanceId: randomUUID(), engineGeneration: 1, bindingFingerprint: bindingFingerprint(binding) };
  assert.throws(() => createOriginEngineComposition({ binding, pool, journal: createOriginJournal({ pool, encryptionKey: key }), env: enabled,
    history: { scope, runId: randomUUID() }, resolveBinding: async () => binding,
    transport: { endpoint: `https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`, bearerToken: 'synthetic-test-only' } }), /HISTORY_SOURCE_BINDING_CHANGED/u);
});

test('the compiled pinned socket snapshots recoverable media descriptors before the original event can change',async()=>{
  const binding={instanceId:randomUUID(),instanceName:`Synthetic-raw-media-${randomUUID()}`,generation:1,destinationId:randomUUID(),revision:1};
  const scope={organizationId:randomUUID(),channelId:randomUUID(),instanceId:binding.instanceId,engineId:'synthetic-engine',engineGeneration:1,
    sessionGeneration:randomUUID(),bindingFingerprint:bindingFingerprint(binding),identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null};
  const endpoint=`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`,runId=randomUUID(),bytes=Buffer.from('synthetic-socket-media');
  const fixture=await compileEngineFixture({endpoint}),journal=createOriginJournal({pool,encryptionKey:key,history:{maxStagedBytes:2000000,captureMedia:true}});
  await withOriginEngineLabHost({labOnly:true,env:enabled,prepareInstance:async()=>({pool,encryptionKey:key,binding,history:{scope,runId,maxStagedBytes:2000000,captureMedia:true},
    resolveBinding:async()=>binding,transport:{endpoint,bearerToken:'synthetic-test-only'}})},async()=>{
    const engine=fixture.create(binding);await awaitOriginEngineReady(engine.instance);
    engine.instance.messageHandle['messaging-history.set']=async()=>{};
    const media={mediaKey:Buffer.alloc(32,37),directPath:'/v/synthetic-engine.enc',fileLength:bytes.length,
      fileSha256:createHash('sha256').update(bytes).digest(),mimetype:'image/png',caption:'Synthetic captured caption'};
    const event={'messaging-history.set':{chats:[],contacts:[],messages:[{key:{id:'synthetic-raw-media',remoteJid:`${'1'.repeat(11)}@s.whatsapp.net`,fromMe:true},
      messageTimestamp:1600000000,message:{imageMessage:media}}]}};
    const writing=engine.emit(event);media.mediaKey.fill(99);media.caption='Changed after socket callback';await writing;
    const [page]=await journal.history.pending(scope,{runId}),claim=await journal.history.claimMedia(scope,runId,new Date());
    assert.equal(page.chunk.records[0].content.caption,'Synthetic captured caption');
    assert.equal(page.chunk.records[0].fromMe,true);
    assert.equal(claim.descriptor.mediaKey,Buffer.alloc(32,37).toString('base64'));
    assert.equal(page.chunk.records[0].content.referenceId,claim.reference.referenceId);
    assert.doesNotMatch(JSON.stringify(page),/mediaKey|directPath|Changed after socket/u);
  });
});

test('the compiled hook retains only persisted media references fenced to its original capture scope', async () => {
  const binding = { instanceId:randomUUID(),instanceName:`Synthetic-media-${randomUUID()}`,generation:1,destinationId:randomUUID(),revision:1 };
  const scope = { organizationId:randomUUID(),channelId:randomUUID(),instanceId:binding.instanceId,engineId:'synthetic-engine',engineGeneration:1,
    sessionGeneration:randomUUID(),bindingFingerprint:bindingFingerprint(binding),identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null };
  const endpoint = `https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`, runId=randomUUID();
  const fixture = await compileEngineFixture({endpoint});
  const journal = createOriginJournal({pool,encryptionKey:key,history:{maxStagedBytes:2000000}});
  const reference = {persisted:true,scopeKey:historyCaptureScopeKey(scope),referenceId:randomUUID(),mediaType:'IMAGE',
    byteSize:4,sha256:'a'.repeat(64),mimeType:'image/png',filename:'synthetic.png',caption:'Synthetic media'};
  let resolved = 0;
  const history = {scope,runId,mediaReference:request=>{
    assert.deepEqual(request.scope,scope);assert.equal(request.providerMessageId,'synthetic-scoped-media');resolved++;return reference;
  }};
  await withOriginEngineLabHost({labOnly:true,env:enabled,prepareInstance:async()=>({pool,journal,binding,history,
    resolveBinding:async()=>binding,transport:{endpoint,bearerToken:'synthetic-test-only'}})},async()=>{
    const engine=fixture.create(binding);await awaitOriginEngineReady(engine.instance);
    engine.instance.messageHandle['messaging-history.set']=async()=>{};
    history.mediaReference=()=>{throw Error('Resolver changed after attachment');};
    await engine.emit({'messaging-history.set':{chats:[],contacts:[],messages:[{
      key:{id:'synthetic-scoped-media',remoteJid:`${'1'.repeat(11)}@s.whatsapp.net`,fromMe:false},messageTimestamp:1600000000,
      message:{imageMessage:{url:'https://synthetic.invalid/private-media',mediaKey:'synthetic-raw-key-must-not-survive'}},
    }]}});
    const [page]=await journal.history.pending(scope,{runId});
    assert.equal(resolved,1);assert.equal(page.chunk.records[0].content.type,'MEDIA');
    assert.equal(page.chunk.records[0].content.referenceId,reference.referenceId);
    assert.equal(JSON.stringify(page.chunk).includes('synthetic-raw-key'),false);
    assert.equal(JSON.stringify(page.chunk).includes('synthetic.invalid/private-media'),false);
  });
});

test('the engine refuses a ready reference from another capture scope and preserves a media gap',async()=>{
  const binding={instanceId:randomUUID(),instanceName:`Synthetic-other-media-${randomUUID()}`,generation:1,destinationId:randomUUID(),revision:1};
  const scope={organizationId:randomUUID(),channelId:randomUUID(),instanceId:binding.instanceId,engineId:'synthetic-engine',engineGeneration:1,
    sessionGeneration:randomUUID(),bindingFingerprint:bindingFingerprint(binding),identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null};
  const journal=createOriginJournal({pool,encryptionKey:key,history:{maxStagedBytes:2000000}}),runId=randomUUID();
  const composition=createOriginEngineComposition({binding,pool,journal,env:enabled,history:{scope,runId,mediaReference:()=>({
    persisted:true,scopeKey:'f'.repeat(64),referenceId:randomUUID(),mediaType:'IMAGE',byteSize:4,sha256:'a'.repeat(64),
    mimeType:'image/png',filename:'synthetic.png',caption:'Synthetic wrong capture'})},resolveBinding:async()=>binding,
    transport:{endpoint:`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`,bearerToken:'synthetic-test-only'}});
  await composition.capture({'messaging-history.set':{messages:[{key:{id:'synthetic-wrong-media-scope',remoteJid:`${'1'.repeat(11)}@s.whatsapp.net`,fromMe:false},
    messageTimestamp:1600000000,message:{imageMessage:{}}}]}});
  const [page]=await journal.history.pending(scope,{runId});
  assert.deepEqual(page.chunk.records.map(r=>r.kind==='GAP'?r.reason:r.kind),['MEDIA_UNAVAILABLE']);
});
