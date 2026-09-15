import { describe, expect, it } from 'vitest';

import {
  createApiKey,
  createOrganizationApiKey,
  deriveIdentityRateLimitKey,
  deriveIpRateLimitKey,
  parseOrganizationApiKey,
  verifyApiKey,
} from '../src/index.js';

const identitySecret = 'identity-rate-limit-secret-32-bytes-minimum';
const ipSecret = 'ip-rate-limit-secret-with-32-bytes-minimum';
const apiKeySecret = 'api-key-hmac-secret-with-32-bytes-minimum';

describe('derivação HMAC', () => {
  it('normaliza e-mail sem persistir a identidade aberta na chave', () => {
    const derived = deriveIdentityRateLimitKey(' User@Example.COM ', identitySecret);

    expect(derived).toBe(deriveIdentityRateLimitKey('user@example.com', identitySecret));
    expect(derived).toMatch(/^[a-f0-9]{64}$/);
    expect(derived).not.toContain('user@example.com');
  });

  it.each([
    ['192.0.2.10', '192.0.2.10'],
    ['2001:db8::1', '2001:0db8:0:0:0:0:0:1'],
  ])('normaliza endereços equivalentes antes do HMAC', (canonical, equivalent) => {
    expect(deriveIpRateLimitKey(canonical, ipSecret)).toBe(
      deriveIpRateLimitKey(equivalent, ipSecret),
    );
  });

  it('rejeita IP inválido antes de derivar a chave', () => {
    expect(() => deriveIpRateLimitKey('not-an-ip', ipSecret)).toThrow('Invalid IP address');
  });
});

describe('API keys', () => {
  it('emite alta entropia e valida por HMAC sem armazenar o segredo', () => {
    let fill = 1;
    const deterministicRandom = (size: number) => Buffer.alloc(size, fill++);
    const created = createApiKey(apiKeySecret, deterministicRandom);

    expect(created.secret).toMatch(/^jrc_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
    expect(created.hmac).toMatch(/^[a-f0-9]{64}$/);
    expect(created.hmac).not.toContain(created.secret);
    expect(verifyApiKey(created.secret, created.hmac, apiKeySecret)).toBe(true);
    expect(verifyApiKey(`${created.secret}x`, created.hmac, apiKeySecret)).toBe(false);
  });

  it('incorpora um locator de organização validado no prefixo sem reduzir a entropia', () => {
    let fill = 7;
    const deterministicRandom = (size: number) => Buffer.alloc(size, fill++);
    const organizationId = '4f2491a2-6853-4ac2-a7ef-c997813a9182';

    const created = createOrganizationApiKey(
      organizationId,
      apiKeySecret,
      deterministicRandom,
    );

    expect(created.prefix).toMatch(/^[a-f0-9]{32}-[A-Za-z0-9_-]{12}$/);
    expect(parseOrganizationApiKey(created.secret)).toEqual({
      organizationId,
      prefix: created.prefix,
    });
    expect(verifyApiKey(created.secret, created.hmac, apiKeySecret)).toBe(true);
    expect(parseOrganizationApiKey('jrc_invalid')).toBeNull();
  });
});
