import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sanitizeEmbedDiagnostic } from '@jrc/contracts';
import config from '../../../../playwright.embed.config.js';
it('never enables automatic secret-bearing browser artifacts', () => {
  expect(config.use).toMatchObject({ screenshot: 'off', video: 'off', trace: 'off' });
  expect(config.retries).toBe(0);
});
it('allows only bounded diagnostic identifiers, statuses and known error codes', () => {
  const requestId = '884c4ce2-741f-47a1-b9a2-ccfbcbb60231';
  expect(sanitizeEmbedDiagnostic({ requestId, status: 403, code: 'EMBED_AUTHORIZATION_DENIED', token: 'synthetic-token',
    verifier: 'synthetic-proof', qr: 'synthetic-qr', body: { secret: 'synthetic' }, url: 'https://example.test/?token=synthetic' }))
    .toEqual({ requestId, status: 403, code: 'EMBED_AUTHORIZATION_DENIED' });
  expect(sanitizeEmbedDiagnostic({ requestId: 'token-in-id', status: 'qr-in-status', code: 'SECRET_SENT_AS_CODE' })).toEqual({});
  expect(sanitizeEmbedDiagnostic(null)).toEqual({});
  expect(sanitizeEmbedDiagnostic({ status: 'EXPIRED' })).toEqual({ status: 'EXPIRED' });
});
it('keeps deployment flags opt-in and excludes test captures from the container', () => {
  const compose = readFileSync('infra/dokploy/compose.yaml', 'utf8');
  expect(compose).toContain('CHATWOOT_EMBED_ENABLED: ${CHATWOOT_EMBED_ENABLED:-false}');
  expect(readFileSync('infra/dokploy/.env.example', 'utf8')).toContain('CHATWOOT_EMBED_ENABLED=false');
  expect(readFileSync('.dockerignore', 'utf8')).toContain('test-results');
});
