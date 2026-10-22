import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';

it('ships an optional partner worker with private DB access and public HTTPS egress',async()=>{
  const compose=await readFile('infra/dokploy/compose.yaml','utf8');
  const block=compose.split('\n  partner-events-worker:')[1]?.split(/\n  [a-z][a-z-]*:/)[0];
  expect(block).toBeDefined();
  expect(block).toContain('profiles: [partner-api]');
  expect(block).toContain('apps/api/dist/commands/partner-events-worker.js');
  expect(block).toContain('PARTNER_WEBHOOK_ENCRYPTION_KEY: ${PARTNER_WEBHOOK_ENCRYPTION_KEY:-}');
  expect(block).toContain('networks: [backend, egress]');
  expect(block).toContain('read_only: true');
  expect(block).not.toMatch(/ports:|POSTGRES_PASSWORD|EVOLUTION_API_KEY/);
  expect(compose).toContain('PARTNER_WEBHOOK_ENCRYPTION_KEY: ${PARTNER_WEBHOOK_ENCRYPTION_KEY:-}');
});
