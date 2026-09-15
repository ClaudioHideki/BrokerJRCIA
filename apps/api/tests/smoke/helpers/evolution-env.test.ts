import { describe, expect, it } from 'vitest';

import { loadEvolutionSmokeEnvironment } from './evolution-env.js';

describe('Evolution smoke environment', () => {
  it('permanece inerte quando o opt-in não está habilitado', () => {
    expect(loadEvolutionSmokeEnvironment({ EVOLUTION_API_KEY: 'partial-secret' }))
      .toEqual({ enabled: false });
  });

  it('falha antes do provisionamento quando o opt-in está incompleto', () => {
    expect(() => loadEvolutionSmokeEnvironment({
      EVOLUTION_SMOKE_ENABLED: 'true',
      EVOLUTION_API_KEY: 'must-never-be-printed',
    })).toThrow('Incomplete or invalid Evolution smoke configuration');
  });

  it('normaliza timeout limitado para uma configuração completa', () => {
    expect(loadEvolutionSmokeEnvironment({
      EVOLUTION_SMOKE_ENABLED: 'true',
      EVOLUTION_BASE_URL: 'http://127.0.0.1:8080',
      EVOLUTION_API_KEY: 'platform-secret',
      EVOLUTION_SMOKE_TIMEOUT_MS: '60000',
    })).toEqual({
      enabled: true,
      baseUrl: 'http://127.0.0.1:8080',
      apiKey: 'platform-secret',
      timeoutMs: 60_000,
    });
  });

  it('recusa destino remoto mesmo com configuração completa', () => {
    expect(() => loadEvolutionSmokeEnvironment({
      EVOLUTION_SMOKE_ENABLED: 'true',
      EVOLUTION_BASE_URL: 'https://evolution.example.com',
      EVOLUTION_API_KEY: 'platform-secret',
    })).toThrow('Evolution smoke endpoint must be local');
  });
});
