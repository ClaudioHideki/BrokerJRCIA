import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { createIntegrationRuntime } from './runtime.js';
const s3:NodeJS.ProcessEnv={MEDIA_STORAGE_DRIVER:'s3',MEDIA_S3_ENDPOINT:'https://media.example.test',MEDIA_S3_BUCKET:'broker-synthetic-media',
  MEDIA_S3_ACCESS_KEY_ID:'synthetic-key-id',MEDIA_S3_SECRET_ACCESS_KEY:'synthetic-secret-only',MEDIA_S3_DEDICATED_BUCKET:'true',
  INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),MEDIA_STORAGE_BYTES_PER_ORGANIZATION:'100'};
function pool(){return {connect:vi.fn(async()=>{throw new Error('SYNTHETIC_TENANT_NOT_AUTHORIZED');}),query:vi.fn()} as unknown as Pool;}
it('composes private storage for standalone media without requiring a configured central or QR instance',()=>{
  const db=pool(),runtime=createIntegrationRuntime(s3,db) as ReturnType<typeof createIntegrationRuntime>&{privateMedia?:{runOnce:unknown}};
  expect(runtime.media).toBeDefined();expect(runtime.privateMedia?.runOnce).toBeTypeOf('function');
  expect(runtime.chatwoot).toBeUndefined();expect(runtime.qr).toBeUndefined();
  expect(db.connect).not.toHaveBeenCalled();expect(db.query).not.toHaveBeenCalled();
  expect(JSON.stringify(runtime)).not.toContain(s3.MEDIA_S3_SECRET_ACCESS_KEY!);
});
it('rejects an incomplete private destination instead of silently using database media',()=>{
  const db=pool();expect(()=>createIntegrationRuntime({...s3,MEDIA_S3_BUCKET:''},db)).toThrowError('MEDIA_STORAGE_CONFIG_INVALID');
  expect(db.connect).not.toHaveBeenCalled();
});
it('rejects missing encryption rather than disabling the configured private store',()=>{
  expect(()=>createIntegrationRuntime({...s3,INTEGRATION_ENCRYPTION_KEY:''},pool())).toThrowError('MEDIA_STORAGE_CONFIG_INVALID');
});
it('preserves an unconfigured standalone installation without starting object I/O',()=>{
  const db=pool(),runtime=createIntegrationRuntime({},db);
  expect(runtime.media).toBeUndefined();expect(db.connect).not.toHaveBeenCalled();expect(db.query).not.toHaveBeenCalled();
});
