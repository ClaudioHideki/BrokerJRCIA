import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../../src/commands/messaging-worker.js';

describe('worker tenant boundary', () => {
  it('requires a direct app role and explicit valid tenant IDs', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://postgres@localhost/test', MESSAGING_WORKER_ORGANIZATIONS: '00000000-0000-4000-8000-000000000001' })).toThrow('WORKER_REQUIRES_APP_ROLE');
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://jrc_app@localhost/test' })).toThrow();
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://jrc_app@localhost/test', MESSAGING_WORKER_ORGANIZATIONS: '*' })).toThrow();
  });
});
