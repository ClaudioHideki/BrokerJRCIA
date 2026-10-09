import {expect,it} from 'vitest';
import {createStorageTestEnvironment,verifyFixtureDigest,downloadVerifiedFixture,runStorageGate,MINIO_FIXTURE} from '../scripts/ci/storage-minio.mjs';
it('pins the already exercised vendor artifact and rejects any other bytes',()=>{
 expect(MINIO_FIXTURE.release).toBe('RELEASE.2025-09-07T16-13-09Z');
 expect(MINIO_FIXTURE.sha256).toBe('7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f');
 expect(MINIO_FIXTURE.url).toBe('https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z');
 expect(()=>verifyFixtureDigest(Buffer.from('untrusted artifact'))).toThrow('STORAGE_TEST_BINARY_HASH_MISMATCH');
});
it('generates private credentials and a unique bucket without copying application/storage secrets',()=>{
 const a=createStorageTestEnvironment('http://127.0.0.1:18001'),b=createStorageTestEnvironment('http://127.0.0.1:18002');
 expect(a.TEST_STORAGE_SECRET_ACCESS_KEY).not.toBe(b.TEST_STORAGE_SECRET_ACCESS_KEY);expect(a.TEST_STORAGE_BUCKET).not.toBe(b.TEST_STORAGE_BUCKET);
 expect(a.TEST_STORAGE_SECRET_ACCESS_KEY).toMatch(/^[a-f0-9]{64}$/);expect(a.TEST_STORAGE_BINARY_SHA256).toBe(MINIO_FIXTURE.sha256);
 expect(a).not.toHaveProperty('DATABASE_URL');expect(a).not.toHaveProperty('MINIO_ROOT_PASSWORD');
});
it('uses the pinned GET with a deadline and rejects download failures before touching an artifact file',async()=>{
 await expect(downloadVerifiedFixture('must-not-be-created',async(url,options)=>{
  expect(url).toBe(MINIO_FIXTURE.url);expect(options.method).toBe('GET');expect(options.signal).toBeInstanceOf(AbortSignal);
  return new Response('synthetic failure',{status:503});
 })).rejects.toThrow('STORAGE_TEST_BINARY_DOWNLOAD_FAILED');
});
it('rejects a wrong declared download size before reading or writing artifact bytes',async()=>{
 await expect(downloadVerifiedFixture('must-not-be-created',async()=>new Response('synthetic',{status:200,headers:{'content-length':'999999999999'}})))
  .rejects.toThrow('STORAGE_TEST_BINARY_SIZE_MISMATCH');
});
it.each(['download','version','start','ready','bucket','tests'])('cleans up and propagates a %s failure before any false storage success',async failure=>{
 const trace=[];const step=async name=>{trace.push(name);if(name===failure)throw Error('EXPECTED_STAGE_FAILURE');};
 const ports={initialize:async()=>({}),download:async()=>step('download'),version:async()=>step('version'),start:async()=>step('start'),
  ready:async()=>step('ready'),bucket:async()=>step('bucket'),tests:async()=>step('tests'),cleanup:async()=>step('cleanup')};
 await expect(runStorageGate(ports)).rejects.toThrow('EXPECTED_STAGE_FAILURE');
 expect(trace.at(-1)).toBe('cleanup');expect(trace).toEqual(['download','version','start','ready','bucket','tests'].slice(0,['download','version','start','ready','bucket','tests'].indexOf(failure)+1).concat('cleanup'));
});
it('orders real setup ports before the required storage suite and always cleans up on success',async()=>{
 const trace=[],step=async name=>{trace.push(name);};
 await runStorageGate({initialize:async()=>({}),download:async()=>step('download'),version:async()=>step('version'),start:async()=>step('start'),ready:async()=>step('ready'),bucket:async()=>step('bucket'),tests:async()=>step('tests'),cleanup:async()=>step('cleanup')});
 expect(trace).toEqual(['download','version','start','ready','bucket','tests','cleanup']);
});
