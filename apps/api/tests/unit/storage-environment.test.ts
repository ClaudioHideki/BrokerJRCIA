import {expect,it} from 'vitest';
import {requireStorageEnvironment,STORAGE_TEST_BINARY_SHA256,STORAGE_TEST_RELEASE} from '../storage/environment.js';
const valid={TEST_STORAGE_ENDPOINT:'http://127.0.0.1:19099',TEST_STORAGE_BUCKET:'synthetic-storage-tests',TEST_STORAGE_PROFILE:'synthetic-tests',TEST_STORAGE_REGION:'us-east-1',
 TEST_STORAGE_ACCESS_KEY_ID:'synthetic-access',TEST_STORAGE_SECRET_ACCESS_KEY:'synthetic-test-secret',TEST_STORAGE_SERVER_RELEASE:STORAGE_TEST_RELEASE,TEST_STORAGE_BINARY_SHA256:STORAGE_TEST_BINARY_SHA256};
it('accepts an explicit bounded loopback test destination and the exact vendor fixture identity',()=>{
 expect(requireStorageEnvironment(valid)).toMatchObject({endpoint:valid.TEST_STORAGE_ENDPOINT,bucket:valid.TEST_STORAGE_BUCKET,release:STORAGE_TEST_RELEASE,binarySha256:STORAGE_TEST_BINARY_SHA256});
});
it.each(Object.keys(valid))('fails instead of silently skipping when %s is missing',name=>{
 const env:NodeJS.ProcessEnv={...valid};delete env[name];expect(()=>requireStorageEnvironment(env)).toThrow('STORAGE_TEST_ENV_REQUIRED:'+name);
});
it.each(['https://production.example.test','http://user:secret@127.0.0.1','http://127.0.0.1/path','http://127.0.0.1?private=secret'])('rejects an unsafe test destination without echoing it: case %s',endpoint=>{
 try{requireStorageEnvironment({...valid,TEST_STORAGE_ENDPOINT:endpoint});throw Error('MISSING_REJECTION');}catch(error){expect((error as Error).message).toBe('STORAGE_TEST_ENDPOINT_INVALID');}
});
it('rejects a different artifact without leaking credentials',()=>{
 expect(()=>requireStorageEnvironment({...valid,TEST_STORAGE_BINARY_SHA256:'0'.repeat(64)})).toThrow('STORAGE_TEST_ARTIFACT_UNVERIFIED');
});
