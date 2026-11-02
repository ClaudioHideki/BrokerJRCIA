import { describe, expect, it } from 'vitest';
import * as contracts from '@jrc/contracts';
import { requestedPartnerScopes } from '../../src/modules/api-keys/service.js';

describe('explicit partner media contracts', () => {
  it('permits all eight generic scopes only when explicitly requested', () => {
    const scopes = ['instances:read', 'instances:write', 'api_keys:manage', 'messaging:read', 'messaging:send', 'webhooks:manage', 'media:upload', 'media:send'];
    expect(contracts.IssueApiKeyRequestSchema.safeParse({ name: 'partner', scopes }).success).toBe(true);
    expect(contracts.IssueApiKeyRequestSchema.parse({ name: 'old key', scopes: ['messaging:send'] }).scopes).toEqual(['messaging:send']);
    expect(contracts.IssueApiKeyRequestSchema.safeParse({ name: 'control', scopes: ['chatwoot:manage'] }).success).toBe(false);
  });
  it('subjects both media scopes to the existing transactional delegation fence', () => {
    expect(requestedPartnerScopes(['media:upload', 'media:send', 'instances:read'])).toEqual(['media:upload', 'media:send']);
  });
});
