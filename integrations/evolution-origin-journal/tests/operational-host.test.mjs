import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ENGINE_SOURCE_HASHES,preparePinnedEngineSources} from '../src/engine-overlay.mjs';
import {parseOriginDatabaseHost as validateEnvironment} from '../../../infra/evolution/database-host.mjs';

test('prepares database admission only after native auth and before socket construction',async()=>{
 const sources={};for(const p of Object.keys(ENGINE_SOURCE_HASHES))sources[p]=await readFile(new URL(`../../../upstream/evolution-api/${p}`,import.meta.url),'utf8');
 const code=preparePinnedEngineSources(sources).sources['src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'];
 const auth=code.indexOf('this.instance.authState = await this.defineAuthState();');
 const admission=code.indexOf('await prepareOriginEngineSocket(this);');
 assert.ok(auth>=0);assert.ok(admission>auth,'source admission must follow the initialized registration identity');
 assert.ok(admission<code.indexOf('this.client = makeWASocket'), 'source admission must precede any new socket event');
});

test('verified loader admits only explicit database-host configuration with a dedicated source principal',()=>{
 const env={JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true',HISTORY_SYNC_V2_ENABLED:'true',
  JRC_ORIGIN_DATABASE_URL:'postgres://jrc_origin_synthetic@engine-db:5432/synthetic',JRC_ORIGIN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
  JRC_ORIGIN_ENGINE_ID:'legacy',JRC_ORIGIN_ENGINE_GENERATION:'1',JRC_ORIGIN_ENGINE_FINGERPRINT:'a'.repeat(64),JRC_ORIGIN_BROKER_ORIGIN:'https://broker.example.test'};
 assert.doesNotThrow(()=>validateEnvironment({...env}));
 for(const patch of [{JRC_ORIGIN_DATABASE_URL:'postgres://jrc_app@engine-db:5432/synthetic'},{JRC_ORIGIN_ENGINE_FINGERPRINT:''},
  {JRC_ORIGIN_ENCRYPTION_KEY:''},{HISTORY_SYNC_V2_ENABLED:'false'},{JRC_ORIGIN_BROKER_ORIGIN:'https://broker.example.test/arbitrary'}])assert.throws(()=>validateEnvironment({...env,...patch}));
});
