import { describe, expect, it } from 'vitest';
import { DestinationRequestSchema } from '@jrc/contracts';
import { normalizeChatwootOrigin } from '../../src/modules/integrations/chatwoot-destination.js';

describe('approved Chatwoot origin contract', () => {
  it('canonicalizes a hostname and the default TLS port', () => {
    expect(normalizeChatwootOrigin('https://Atendimento.Example.com:443/')).toBe('https://atendimento.example.com');
  });
  it.each([
    'http://example.com', 'https://u:p@example.com', 'https://example.com/app',
    'https://example.com/?token=x', 'https://example.com/#x', 'https://example.com:8443',
    'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]',
    'https://localhost', 'https://host.local', 'https://metadata.google.internal',
    'https://example.com./', 'https://example.com/../', 'https://example.com\\path',
    ' https://example.com', 'https://example.com?', 'https://example.com#',
  ])('rejects an ambiguous or prohibited origin: %s', value => {
    expect(() => normalizeChatwootOrigin(value)).toThrow('INVALID_CHATWOOT_ORIGIN');
  });
  it('rejects credentials, approval and tenant identifiers in destination requests', () => {
    const input = { baseUrl: 'https://support.example.com', mode: 'EXTERNAL' };
    expect(DestinationRequestSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ token: 'synthetic' }, { approvalStatus: 'APPROVED' }, { organizationId: 'other' }]) {
      expect(DestinationRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });
});
