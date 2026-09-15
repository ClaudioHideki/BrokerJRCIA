import { describe, expect, it } from 'vitest';

import {
  FakeProviderAdapter,
  MetaProviderAdapter,
  ProviderRegistry,
} from '../src/index.js';

describe('ProviderRegistry', () => {
  it('mantém registros comum e administrativo em mapas separados', () => {
    const fake = new FakeProviderAdapter();
    const meta = new MetaProviderAdapter();
    const registry = new ProviderRegistry(
      [fake, meta],
      [['BAILEYS', fake]],
    );

    expect(registry.getProvider('BAILEYS')).toBe(fake);
    expect(registry.getProvider('META')).toBe(meta);
    expect(registry.getAdminProvider('BAILEYS')).toBe(fake);
    expect(() => registry.getAdminProvider('META')).toThrow('PROVIDER_ADMIN_NOT_AVAILABLE');
  });

  it('não promove estruturalmente um provider comum ao contrato administrativo', () => {
    const meta = new MetaProviderAdapter();
    const registry = new ProviderRegistry([meta]);

    expect(() => registry.getAdminProvider('META')).toThrow('PROVIDER_ADMIN_NOT_AVAILABLE');
  });

  it('distingue provider comum não registrado de operação administrativa indisponível', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.getProvider('BAILEYS')).toThrow('PROVIDER_NOT_REGISTERED');
    expect(() => registry.getAdminProvider('BAILEYS')).toThrow('PROVIDER_ADMIN_NOT_AVAILABLE');
  });

  it('rejeita registros comuns ou administrativos duplicados', () => {
    const first = new FakeProviderAdapter();
    const second = new FakeProviderAdapter();

    expect(() => new ProviderRegistry([first, second])).toThrow('PROVIDER_ALREADY_REGISTERED');
    expect(() => new ProviderRegistry(
      [first],
      [['BAILEYS', first], ['BAILEYS', second]],
    )).toThrow('PROVIDER_ADMIN_ALREADY_REGISTERED');
  });
});
