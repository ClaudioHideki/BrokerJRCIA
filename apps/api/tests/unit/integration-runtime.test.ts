import { describe, expect, it } from 'vitest';
import { loadIntegrationConfig } from '../../src/modules/integrations/runtime.js';
import { loadWorkerConfig, belongsToWorkerShard } from '../../src/commands/messaging-worker.js';

describe('integration runtime configuration', () => {
  it('defaults new surfaces off and never enables embed without control', () => {
    const environment = { NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://broker.example.test', INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64') };
    expect(loadIntegrationConfig(environment).chatwoot).toMatchObject({ controlEnabled: false, embedEnabled: false });
    expect(loadIntegrationConfig({ ...environment, CHATWOOT_EMBED_ENABLED: 'true' }).chatwoot).toMatchObject({ embedEnabled: false });
    expect(loadIntegrationConfig({ ...environment, CHATWOOT_EMBED_ENABLED: 'true', CHATWOOT_CONTROL_ENABLED: 'true' }).chatwoot).toMatchObject({ controlEnabled: true, embedEnabled: true });
  });
  it('disables absent integrations and fails closed for partial credentials', () => {
    expect(loadIntegrationConfig({})).toEqual({});
    expect(() => loadIntegrationConfig({ CHATWOOT_BASE_URL: 'https://conversas.example.com' })).toThrow();
    expect(() => loadIntegrationConfig({ QR_WEBHOOK_ORIGIN: 'http://api:3000' })).toThrow();
  });
  it('accepts explicit public TLS callbacks and private QR callbacks', () => {
    const cfg = loadIntegrationConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://broker.example.com',
      CHATWOOT_BASE_URL: 'https://conversas.example.com', INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
      QR_WEBHOOK_SIGNING_KEY: 's'.repeat(40), QR_WEBHOOK_ORIGIN: 'http://api:3000',
      EVOLUTION_BASE_URL: 'http://engine:8080', EVOLUTION_API_KEY: 'k'.repeat(40) });
    expect(cfg.chatwoot?.publicOrigin).toBe('https://broker.example.com');
    expect(cfg.qr?.webhookOrigin).toBe('http://api:3000');
    expect(() => loadIntegrationConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://localhost:3000',
      CHATWOOT_BASE_URL: 'https://conversas.example.com', INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') })).toThrow();
  });
  it('discovers tenants only when explicitly configured and partitions each once', () => {
    const cfg = loadWorkerConfig({ DATABASE_URL: 'postgres://jrc_app@localhost/test', MESSAGING_WORKER_MODE: 'automatic', MESSAGING_WORKER_SHARDS: '3', MESSAGING_WORKER_SHARD: '1' });
    expect(cfg.mode).toBe('automatic'); expect(cfg.shards).toBe(3);
    const id = '00000000-0000-4000-8000-000000000001';
    expect([0, 1, 2].filter(shard => belongsToWorkerShard(id, shard, 3))).toHaveLength(1);
    expect(() => loadWorkerConfig({ DATABASE_URL: cfg.databaseUrl, MESSAGING_WORKER_MODE: 'automatic', MESSAGING_WORKER_SHARDS: '2', MESSAGING_WORKER_SHARD: '2' })).toThrow();
  });
});
