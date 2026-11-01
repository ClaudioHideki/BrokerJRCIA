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

it('waits for real cluster readiness instead of accepting the ready endpoint early200',async()=>{
 const {waitForMinio}=await import('../scripts/ci/storage-minio.mjs');
 const previous=globalThis.fetch,urls=[];let clusterRequests=0;
 globalThis.fetch=async url=>{urls.push(String(url));return String(url).endsWith('/cluster')
  ?new Response(null,{status:++clusterRequests===1?503:200}):new Response(null,{status:200,headers:{'x-minio-server-status':'offline'}});};
 try{await waitForMinio({env:{TEST_STORAGE_ENDPOINT:'http://127.0.0.1:18001'}});expect(urls).toEqual(['http://127.0.0.1:18001/minio/health/cluster','http://127.0.0.1:18001/minio/health/cluster']);}
 finally{globalThis.fetch=previous;}
});
it('retries only an explicit503 MinIO initialization rejection before creating its same fresh bucket',async()=>{
 const {createPrivateBucket}=await import('../scripts/ci/storage-minio.mjs');
 const previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return calls.length===1
  ?new Response('<Error><Code>XMinioServerNotInitialized</Code><Message>NEVER_LOG_SYNTHETIC_SECRET</Message></Error>',{status:503}):new Response(null,{status:200});};
 try{await createPrivateBucket({env:createStorageTestEnvironment('http://127.0.0.1:18001')});expect(calls).toHaveLength(2);expect(calls[1].url).toBe(calls[0].url);expect(calls.every(call=>call.options.redirect==='error')).toBe(true);}
 finally{globalThis.fetch=previous;}
});

it.each(['XMinioServerNotInitialized','XMinioIAMNotInitialized','XMinioBucketMetadataNotInitialized'])('bounds retries of503 %s and emits only safe status/code diagnostics',async code=>{
 const {createPrivateBucket}=await import('../scripts/ci/storage-minio.mjs');
 const previous=globalThis.fetch,logs=[];let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(`<Error><Code>${code}</Code><Message>NEVER_LOG_SYNTHETIC_SECRET</Message><Resource>/private-sensitive-path</Resource></Error>`,{status:503});};
 try{await expect(createPrivateBucket({env:createStorageTestEnvironment('http://127.0.0.1:18001')},{sleep:async()=>{},diagnostic:line=>logs.push(line)})).rejects.toThrow('STORAGE_TEST_BUCKET_CREATE_FAILED');
  expect(calls).toBe(8);expect(logs).toHaveLength(8);expect(logs.every(line=>line.includes('status=503')&&line.includes('code='+code))).toBe(true);expect(logs.join('')).not.toContain('NEVER_LOG');expect(logs.join('')).not.toContain('sensitive-path');}
 finally{globalThis.fetch=previous;}
});
it.each([[403,'AccessDenied'],[403,'SignatureDoesNotMatch'],[409,'BucketAlreadyOwnedByYou'],[500,'InternalError'],[503,'SlowDown'],[503,'UnexpectedSecretCode'],[400,'XMinioServerNotInitialized']])('never retries status%s code%s outside exact initialization errors',async(status,code)=>{
 const {createPrivateBucket}=await import('../scripts/ci/storage-minio.mjs');
 const previous=globalThis.fetch,logs=[];let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(`<Error><Code>${code}</Code><Message>NEVER_LOG_SYNTHETIC_SECRET</Message></Error>`,{status});};
 try{await expect(createPrivateBucket({env:createStorageTestEnvironment('http://127.0.0.1:18001')},{sleep:async()=>{},diagnostic:line=>logs.push(line)})).rejects.toThrow('STORAGE_TEST_BUCKET_CREATE_FAILED');
  expect(calls).toBe(1);expect(logs).toHaveLength(1);expect(logs[0]).toContain('status='+status);expect(logs[0]).not.toContain('NEVER_LOG');if(code==='UnexpectedSecretCode')expect(logs[0]).not.toContain(code);}
 finally{globalThis.fetch=previous;}
});
it('does not retry or expose ambiguous network failures or unbounded/malformed error bodies',async()=>{
 const {createPrivateBucket}=await import('../scripts/ci/storage-minio.mjs');
 for(const respond of [()=>{throw Error('NEVER_LOG_SYNTHETIC_SECRET');},()=>new Response('<Error><Code>XMinioServerNotInitialized</Code>'+ 'x'.repeat(9000)+'</Error>',{status:503}),()=>new Response('<Error><Message><Code>XMinioServerNotInitialized</Code></Message></Error>',{status:503})]){
  const previous=globalThis.fetch,logs=[];let calls=0;globalThis.fetch=async()=>{calls++;return respond();};
  try{await expect(createPrivateBucket({env:createStorageTestEnvironment('http://127.0.0.1:18001')},{sleep:async()=>{},diagnostic:line=>logs.push(line)})).rejects.toThrow('STORAGE_TEST_BUCKET_CREATE_FAILED');expect(calls).toBe(1);expect(logs.join('')).not.toContain('NEVER_LOG');expect(logs).toHaveLength(1);}
  finally{globalThis.fetch=previous;}
 }
});
