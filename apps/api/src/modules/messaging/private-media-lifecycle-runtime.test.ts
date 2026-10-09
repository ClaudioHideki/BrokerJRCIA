import {expect,it,vi} from 'vitest';
import {createLifecycleMediaRuntime} from './private-media-lifecycle-runtime.js';
const env={LIFECYCLE_DATABASE_URL:'postgresql://jrc_lifecycle@localhost/test',INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),MEDIA_STORAGE_DRIVER:'s3',
  MEDIA_S3_ENDPOINT:'https://objects.example.test',MEDIA_S3_BUCKET:'broker-private-test',MEDIA_S3_ACCESS_KEY_ID:'synthetic-key',
  MEDIA_S3_SECRET_ACCESS_KEY:'synthetic-secret',MEDIA_S3_DEDICATED_BUCKET:'true'};
it.each(['jrc_app','jrc_auth','postgres'])('refuses %s credentials before constructing cleanup',role=>{
  expect(()=>createLifecycleMediaRuntime({...env,LIFECYCLE_DATABASE_URL:`postgresql://${role}@localhost/test`},vi.fn())).toThrow('LIFECYCLE_WORKER_REQUIRES_DEDICATED_ROLE');
});
it('constructs cleanup without contacting S3 or acquiring an app transaction',()=>{
  const transact=vi.fn();expect(typeof createLifecycleMediaRuntime(env,transact)).toBe('function');expect(transact).not.toHaveBeenCalled();
});
it('rejects incomplete S3 configuration with a static error',()=>{
  expect(()=>createLifecycleMediaRuntime({...env,MEDIA_S3_SECRET_ACCESS_KEY:''},vi.fn())).toThrow('MEDIA_STORAGE_CONFIG_INVALID');
});
it('preserves the physical orphan channel scope through the real cleanup factory',async()=>{
  const query=vi.fn(async()=>({rows:[{organization_id:'org',kind:'CHANNEL',messaging_channel_id:null}],rowCount:1}));
  const transact=vi.fn(async(work:any)=>work({query}));const cleanup=createLifecycleMediaRuntime(env,transact);
  await expect(cleanup('deletion','lease')).resolves.toEqual({state:'COMPLETE'});
  expect(query).toHaveBeenCalledTimes(1);expect(transact).toHaveBeenCalledTimes(1);
});
