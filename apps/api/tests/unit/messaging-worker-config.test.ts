import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../../src/commands/messaging-worker.js';

describe('worker tenant boundary', () => {
  it('only enables a mirror worker for one explicit organization and integration',()=>{
    const org='11111111-1111-4111-8111-111111111111',integration='22222222-2222-4222-8222-222222222222';
    const env={DATABASE_URL:'postgres://jrc_app@localhost/test',MESSAGING_WORKER_ORGANIZATIONS:org};
    expect(loadWorkerConfig(env).lane).toBe('all');
    const target={organizationId:org,integrationId:integration,channelId:integration,instanceId:integration,
      origin:'https://synthetic.example.invalid',accountId:1,inboxId:9,destinationRevision:1,credentialRevision:1};
    const lane={...env,MESSAGING_WORKER_LANE:'live-mirrors',MESSAGING_WORKER_MIRROR_TARGET_JSON:JSON.stringify(target)};
    expect(loadWorkerConfig(lane)).toMatchObject({lane:'live-mirrors',organizations:[org],mirrorTarget:target});
    for(const overrides of [{MESSAGING_WORKER_MODE:'automatic'},{MESSAGING_WORKER_ORGANIZATIONS:org+','+integration},
      {MESSAGING_WORKER_MIRROR_TARGET_JSON:'{}'},{MESSAGING_WORKER_ORGANIZATIONS:integration},{MESSAGING_WORKER_SHARDS:'2'}])
      expect(()=>loadWorkerConfig({...lane,...overrides})).toThrow();
  });
  it('requires a direct app role and explicit valid tenant IDs', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://postgres@localhost/test', MESSAGING_WORKER_ORGANIZATIONS: '00000000-0000-4000-8000-000000000001' })).toThrow('WORKER_REQUIRES_APP_ROLE');
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://jrc_app@localhost/test' })).toThrow();
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://jrc_app@localhost/test', MESSAGING_WORKER_ORGANIZATIONS: '*' })).toThrow();
  });
});
