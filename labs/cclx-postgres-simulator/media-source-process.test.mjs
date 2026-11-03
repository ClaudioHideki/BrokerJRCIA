import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSourceCrashFixture} from './media-source-process.mjs';

const fixture=()=>({labOnly:true,database:{connectionString:'postgresql://lab_admin@127.0.0.1:55488/jrc_test_cclx_'+'a'.repeat(32),token:'00000000-0000-4000-8000-000000000001'},
 scope:{organizationId:'00000000-0000-4000-8000-000000000900',channelId:'00000000-0000-4000-8000-000000000002',mediaId:'00000000-0000-4000-8000-000000000003'},
 s3:{endpoint:'http://127.0.0.1:15440',bucket:'cclx-lab-00000000-0000-4000-8000-000000000004',accessKeyId:'synthetic',secretAccessKey:'synthetic-test-only'}});
test('source crash lab requires opt-in and owned disposable database before spawning',()=>{
 assert.throws(()=>validateSourceCrashFixture({...fixture(),labOnly:false}),/LAB_ONLY_REQUIRED/);
 const value=fixture();value.database.connectionString='postgresql://lab_admin@127.0.0.1:55488/production';
 assert.throws(()=>validateSourceCrashFixture(value),/UNSAFE_TEST_DATABASE/);
});
test('source crash lab refuses remote storage, credentials in URL and shared buckets',()=>{
 for(const endpoint of ['https://storage.example.test','http://user:pass@127.0.0.1:15440','http://127.0.0.1:15440/path']){
  const value=fixture();value.s3.endpoint=endpoint;assert.throws(()=>validateSourceCrashFixture(value),/INVALID_SOURCE_CRASH_FIXTURE/);
 }
 const value=fixture();value.s3.bucket='existing-bucket';assert.throws(()=>validateSourceCrashFixture(value),/INVALID_SOURCE_CRASH_FIXTURE/);
});
test('source crash lab restricts tenant and identifiers to synthetic scope',()=>{
 const value=fixture();value.scope.organizationId='11111111-1111-4111-8111-111111111111';
 assert.throws(()=>validateSourceCrashFixture(value),/INVALID_SOURCE_CRASH_FIXTURE/);
 const invalid=fixture();invalid.database.token='missing-marker';assert.throws(()=>validateSourceCrashFixture(invalid),/INVALID_SOURCE_CRASH_FIXTURE/);
});
test('source crash lab accepts only the bounded synthetic shape',()=>{
 assert.doesNotThrow(()=>validateSourceCrashFixture(fixture()));
 assert.doesNotThrow(()=>validateSourceCrashFixture({...fixture(),mode:'RECONCILE'}));
 assert.throws(()=>validateSourceCrashFixture({...fixture(),mode:'DELETE'}),/INVALID_SOURCE_CRASH_FIXTURE/);
 const value=fixture();value.s3.secretAccessKey='x'.repeat(4097);assert.throws(()=>validateSourceCrashFixture(value),/INVALID_SOURCE_CRASH_FIXTURE/);
});
