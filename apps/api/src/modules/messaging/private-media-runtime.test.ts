import { expect, it, vi } from 'vitest';
import { createPrivateMediaRuntime } from './private-media-runtime.js';
const environment:NodeJS.ProcessEnv={MEDIA_STORAGE_DRIVER:'s3',MEDIA_S3_ENDPOINT:'https://media.example.test',MEDIA_S3_BUCKET:'broker-synthetic-media',
  MEDIA_S3_ACCESS_KEY_ID:'synthetic-key-id',MEDIA_S3_SECRET_ACCESS_KEY:'synthetic-secret-only',MEDIA_S3_DEDICATED_BUCKET:'true',
  INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),MEDIA_STORAGE_BYTES_PER_ORGANIZATION:'100'};
function ports() {return {transact:vi.fn(async()=>{throw new Error('SYNTHETIC_SCOPE_REJECTED');}),cleanupTransact:vi.fn(async()=>{throw new Error('SYNTHETIC_CLEANUP_REJECTED');})};}
it('keeps the historical database backend when no private destination is configured',()=>{
  const p=ports();expect(createPrivateMediaRuntime({},p)).toBeUndefined();expect(p.transact).not.toHaveBeenCalled();
});
it('uses the tenant transaction to deny a private read before any object I/O',async()=>{
  const p=ports(),store=createPrivateMediaRuntime(environment,p);
  expect(store).toBeDefined();
  await expect(store!.read('synthetic-org','synthetic-media')).rejects.toThrow('SYNTHETIC_SCOPE_REJECTED');
  expect(p.transact).toHaveBeenCalledOnce();expect(p.cleanupTransact).not.toHaveBeenCalled();
  expect(JSON.stringify(store)).not.toContain(environment.MEDIA_S3_SECRET_ACCESS_KEY!);
});
it.each([
  {INTEGRATION_ENCRYPTION_KEY:''},
  {INTEGRATION_ENCRYPTION_KEY:'invalid-envelope-key'},
  {MEDIA_STORAGE_BYTES_PER_ORGANIZATION:'0'},
  {MEDIA_STORAGE_BYTES_PER_ORGANIZATION:'NaN'},
  {MEDIA_STORAGE_BYTES_PER_ORGANIZATION:'100.5'},
])('rejects incomplete encryption/quota configuration before opening a worker',patch=>{
  const p=ports();
  expect(()=>createPrivateMediaRuntime({...environment,...patch},p)).toThrowError('MEDIA_STORAGE_CONFIG_INVALID');
  expect(p.transact).not.toHaveBeenCalled();expect(p.cleanupTransact).not.toHaveBeenCalled();
});
