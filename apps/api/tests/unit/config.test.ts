import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAppConfig } from '../../src/config/env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://jrc_app:local@127.0.0.1:5432/jrc_broker',
  AUTH_DATABASE_URL: 'postgresql://jrc_auth:local@127.0.0.1:5432/jrc_broker',
  REDIS_URL: 'redis://127.0.0.1:6379',
  TRUSTED_PROXY_CIDRS: '10.0.0.0/24, 2001:db8::/32',
  EVOLUTION_BASE_URL: 'http://127.0.0.1:8080',
  EVOLUTION_API_KEY: 'evolution-platform-secret-32-bytes-long',
  JWT_SECRET: 'jwt-secret-value-with-32-bytes-minimum',
  REFRESH_TOKEN_HASH_SECRET: 'refresh-hash-secret-with-32-bytes-minimum',
  API_KEY_HMAC_SECRET: 'api-key-hmac-secret-with-32-bytes-minimum',
  IP_RATE_LIMIT_HMAC_SECRET: 'ip-rate-hmac-secret-with-32-bytes-minimum',
  IDENTITY_RATE_LIMIT_HMAC_SECRET: 'identity-rate-secret-with-32-bytes-minimum',
  CHALLENGE_ENCRYPTION_KEY: 'challenge-encryption-key-32-bytes-minimum',
  BROWSER_CSRF_SECRET: 'browser-csrf-secret-with-32-bytes-minimum',
  CONSOLE_ALLOWED_ORIGINS: 'https://console.jrc.example,http://localhost:5173',
} as const;

describe('configuração da API', () => {
  it('valida e normaliza configuração com segredos separados', () => {
    expect(loadAppConfig(validEnvironment)).toMatchObject({
      nodeEnv: 'test',
      port: 3000,
      evolutionBaseUrl: 'http://127.0.0.1:8080',
      trustedProxyCidrs: ['10.0.0.0/24', '2001:db8::/32'],
      consoleAllowedOrigins: ['https://console.jrc.example', 'http://localhost:5173'],
      consoleCookieSecure: false,
      authRateLimit: { limit: 10, ttlMs: 60_000 },
      authProgressiveDelay: { baseDelayMs: 100, maximumDelayMs: 2_000 },
      redisFailurePolicy: {
        commandDeadlineMs: 500,
        connectTimeoutMs: 1_000,
        reconnectMaxAttempts: 2,
        reconnectDelayMs: 100,
      },
    });
  });

  it('aceita limites de autenticação customizados e validados no runtime', () => {
    expect(loadAppConfig({
      ...validEnvironment,
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: '7',
      AUTH_RATE_LIMIT_WINDOW_MS: '120000',
      AUTH_PROGRESSIVE_DELAY_BASE_MS: '250',
      AUTH_PROGRESSIVE_DELAY_MAX_MS: '3000',
      AUTH_RATE_LIMIT_REDIS_DEADLINE_MS: '750',
      REDIS_CONNECT_TIMEOUT_MS: '1500',
      REDIS_RECONNECT_MAX_ATTEMPTS: '3',
      REDIS_RECONNECT_DELAY_MS: '200',
    })).toMatchObject({
      authRateLimit: { limit: 7, ttlMs: 120_000 },
      authProgressiveDelay: { baseDelayMs: 250, maximumDelayMs: 3_000 },
      redisFailurePolicy: {
        commandDeadlineMs: 750,
        connectTimeoutMs: 1_500,
        reconnectMaxAttempts: 3,
        reconnectDelayMs: 200,
      },
    });
  });

  it.each([
    ['AUTH_RATE_LIMIT_MAX_ATTEMPTS', '0'],
    ['AUTH_RATE_LIMIT_WINDOW_MS', '0'],
    ['AUTH_PROGRESSIVE_DELAY_BASE_MS', '-1'],
    ['AUTH_PROGRESSIVE_DELAY_MAX_MS', '10001'],
    ['AUTH_RATE_LIMIT_REDIS_DEADLINE_MS', '0'],
    ['REDIS_CONNECT_TIMEOUT_MS', '0'],
    ['REDIS_RECONNECT_MAX_ATTEMPTS', '11'],
    ['REDIS_RECONNECT_DELAY_MS', '-1'],
  ])('rejeita valor inseguro de %s', (name, value) => {
    expect(() => loadAppConfig({ ...validEnvironment, [name]: value })).toThrow();
  });

  it('rejeita teto de atraso menor que a base', () => {
    expect(() => loadAppConfig({
      ...validEnvironment,
      AUTH_PROGRESSIVE_DELAY_BASE_MS: '500',
      AUTH_PROGRESSIVE_DELAY_MAX_MS: '499',
    })).toThrow();
  });

  it('rejeita reutilização do mesmo segredo para finalidades diferentes', () => {
    expect(() => loadAppConfig({
      ...validEnvironment,
      API_KEY_HMAC_SECRET: validEnvironment.JWT_SECRET,
    })).toThrow('Security secrets must be distinct');
  });

  it('exige as roles limitadas nos dois DSNs do runtime', () => {
    expect(() => loadAppConfig({
      ...validEnvironment,
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/jrc_broker',
    })).toThrow('DATABASE_URL must authenticate as jrc_app');
    expect(() => loadAppConfig({
      ...validEnvironment,
      AUTH_DATABASE_URL: 'postgresql://jrc_app@127.0.0.1:5432/jrc_broker',
    })).toThrow('AUTH_DATABASE_URL must authenticate as jrc_auth');
  });

  it('mantém o arquivo .env.example estruturalmente completo, mas intencionalmente não executável', () => {
    const environment = Object.fromEntries(
      readFileSync(resolve(process.cwd(), '.env.example'), 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

    expect(() => loadAppConfig(environment)).toThrow('Insecure example secret is not allowed');
  });

  it.each([
    'EVOLUTION_API_KEY',
    'JWT_SECRET',
    'REFRESH_TOKEN_HASH_SECRET',
    'API_KEY_HMAC_SECRET',
    'IP_RATE_LIMIT_HMAC_SECRET',
    'IDENTITY_RATE_LIMIT_HMAC_SECRET',
    'CHALLENGE_ENCRYPTION_KEY',
    'BROWSER_CSRF_SECRET',
  ])('rejeita o placeholder conhecido de %s mesmo fora de produção', (name) => {
    const exampleEnvironment = Object.fromEntries(
      readFileSync(resolve(process.cwd(), '.env.example'), 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(() => loadAppConfig({
      ...validEnvironment,
      [name]: exampleEnvironment[name],
    })).toThrow('Insecure example secret is not allowed');
  });

  it('rejeita segredo CSRF ausente, menor que 32 bytes ou reutilizado', () => {
    expect(() => loadAppConfig({ ...validEnvironment, BROWSER_CSRF_SECRET: undefined })).toThrow();
    expect(() => loadAppConfig({ ...validEnvironment, BROWSER_CSRF_SECRET: 'short-secret' })).toThrow();
    expect(() => loadAppConfig({
      ...validEnvironment,
      BROWSER_CSRF_SECRET: validEnvironment.JWT_SECRET,
    })).toThrow('Security secrets must be distinct');
  });

  it('rejeita origens com wildcard, path e HTTP não local', () => {
    for (const value of [
      '*.jrc.example',
      'https://console.jrc.example/path',
      'http://console.jrc.example',
    ]) {
      expect(() => loadAppConfig({
        ...validEnvironment,
        CONSOLE_ALLOWED_ORIGINS: value,
      })).toThrow();
    }
  });

  it('define Secure pelo transporte da console, independentemente da lista de origins', () => {
    expect(loadAppConfig(validEnvironment).consoleCookieSecure).toBe(false);
    expect(loadAppConfig({
      ...validEnvironment,
      NODE_ENV: 'development',
      CONSOLE_COOKIE_SECURE: 'true',
    }).consoleCookieSecure).toBe(true);
    expect(loadAppConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      CONSOLE_ALLOWED_ORIGINS: 'https://console.jrc.example',
    }).consoleCookieSecure).toBe(true);
  });

  it('rejeita explicitamente cookie sem Secure em produção', () => {
    expect(() => loadAppConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      CONSOLE_ALLOWED_ORIGINS: 'https://console.jrc.example',
      CONSOLE_COOKIE_SECURE: 'false',
    })).toThrow('Console cookies must be Secure in production');
  });
});
