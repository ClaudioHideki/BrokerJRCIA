import { describe, expect, it } from 'vitest';
import { loadPrivateMediaBackend } from './private-media-config.js';

const configured = { MEDIA_STORAGE_DRIVER: 's3', MEDIA_S3_ENDPOINT: 'https://objects.example.test', MEDIA_S3_BUCKET: 'broker-private',
  MEDIA_S3_PROFILE: 'broker-media-v1', MEDIA_S3_REGION: 'us-east-1', MEDIA_S3_ACCESS_KEY_ID: 'synthetic-access',
  MEDIA_S3_SECRET_ACCESS_KEY: 'synthetic-secret-canary', MEDIA_S3_DEDICATED_BUCKET: 'true' };
describe('private media deployment configuration', () => {
  it('preserves the historical postgres path when no object destination is supplied', () => {
    expect(loadPrivateMediaBackend({})).toBeUndefined();
    expect(loadPrivateMediaBackend({ MEDIA_STORAGE_DRIVER: 'postgres', MEDIA_S3_ENDPOINT: '' })).toBeUndefined();
  });
  it('constructs a usable destination without a second feature flag or raw configuration exposure', () => {
    const backend = loadPrivateMediaBackend(configured)!;
    expect(backend.profile).toBe('broker-media-v1'); expect(backend.requestTimeoutMs).toBe(30000);
    expect(backend.objectStore.destinationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(backend.objectStore.put).toBeTypeOf('function'); expect(backend.objectStore.read).toBeTypeOf('function');
    const exposed = JSON.stringify(backend);
    expect(exposed).not.toContain(configured.MEDIA_S3_SECRET_ACCESS_KEY); expect(exposed).not.toContain('objects.example.test');
  });
  it('does not silently ignore a prepared destination while the driver remains postgres', () => {
    expect(() => loadPrivateMediaBackend({ ...configured, MEDIA_STORAGE_DRIVER: 'postgres' })).toThrow('MEDIA_STORAGE_CONFIG_INVALID');
  });
  it('rejects incomplete credentials without returning their values', () => {
    const environment = { ...configured, MEDIA_S3_ACCESS_KEY_ID: '' };
    expect(() => loadPrivateMediaBackend(environment)).toThrow('MEDIA_STORAGE_CONFIG_INVALID');
    try { loadPrivateMediaBackend(environment); } catch (error) { expect(String(error)).not.toContain(configured.MEDIA_S3_SECRET_ACCESS_KEY); }
  });
  it.each([
    { MEDIA_S3_ENDPOINT: 'http://objects.example.test' },
    { MEDIA_S3_ENDPOINT: 'https://synthetic-user:synthetic-password@objects.example.test' },
    { MEDIA_S3_DEDICATED_BUCKET: 'false' },
    { MEDIA_STORAGE_DRIVER: 'invented' },
    { MEDIA_S3_REQUEST_TIMEOUT_MS: '90000' },
  ])('rejects unsafe or unsupported configuration with one static diagnostic (%j)', changed => {
    expect(() => loadPrivateMediaBackend({ ...configured, ...changed })).toThrow('MEDIA_STORAGE_CONFIG_INVALID');
  });
  it('preserves destination identity during credential rotation and changes it for a different bucket', () => {
    const first = loadPrivateMediaBackend(configured)!;
    const rotated = loadPrivateMediaBackend({ ...configured, MEDIA_S3_ACCESS_KEY_ID: 'rotated-access', MEDIA_S3_SECRET_ACCESS_KEY: 'rotated-synthetic-secret' })!;
    const changed = loadPrivateMediaBackend({ ...configured, MEDIA_S3_BUCKET: 'broker-other-private' })!;
    expect(first.objectStore.destinationFingerprint).toBe(rotated.objectStore.destinationFingerprint);
    expect(first.objectStore.destinationFingerprint).not.toBe(changed.objectStore.destinationFingerprint);
  });
});
