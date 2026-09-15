import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ConnectionActionSchema,
  ProviderInstanceLookupSchema,
  type WhatsAppProvider,
  type WhatsAppProviderAdmin,
} from '../src/index.js';

describe('contratos canônicos de provider', () => {
  it.each([
    {
      type: 'QR_CODE',
      encoding: 'BASE64',
      value: 'encoded-value',
      expiresAt: '2026-09-03T12:05:00.000Z',
    },
    {
      type: 'PAIRING_CODE',
      code: '12345678',
      expiresAt: '2026-09-03T12:05:00.000Z',
    },
    {
      type: 'EMBEDDED_SIGNUP',
      flowId: 'flow-1',
      expiresAt: '2026-09-03T12:05:00.000Z',
    },
    {
      type: 'REDIRECT',
      url: 'https://provider.example/connect',
      expiresAt: '2026-09-03T12:05:00.000Z',
    },
    {
      type: 'NONE',
      reason: 'ALREADY_CONNECTED',
    },
  ])('aceita a ação discriminada $type', (action) => {
    expect(ConnectionActionSchema.parse(action)).toEqual(action);
  });

  it('rejeita QR Code sem metadados canônicos', () => {
    expect(() => ConnectionActionSchema.parse({ type: 'QR_CODE', value: 'x' })).toThrow();
  });

  it('representa lookup administrativo sem efeitos colaterais no resultado', () => {
    expect(ProviderInstanceLookupSchema.parse({ exists: false })).toEqual({ exists: false });
    expect(ProviderInstanceLookupSchema.parse({
      exists: true,
      reference: { id: 'provider-reference' },
      status: 'CONNECTED',
    })).toEqual({
      exists: true,
      reference: { id: 'provider-reference' },
      status: 'CONNECTED',
    });
  });

  it('mantém contratos comum e administrativo como portas distintas', () => {
    expectTypeOf<WhatsAppProvider>().not.toEqualTypeOf<WhatsAppProviderAdmin>();
    expectTypeOf<WhatsAppProvider>().toHaveProperty('beginConnection');
    expectTypeOf<WhatsAppProviderAdmin>().toHaveProperty('lookupInstance');
  });
});
