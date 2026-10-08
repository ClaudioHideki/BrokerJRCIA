import { describe, expect, it } from 'vitest';
import { createDatabasePools } from '../../src/db/pools.js';
import { loadDatabasePoolBudget, type DatabasePoolProfile } from '../../src/db/pool-budget.js';
import { loadAppConfig } from '../../src/config/env.js';

const runtimeEnvironment: Record<string, string> = {
  DATABASE_URL: 'postgresql://jrc_app@localhost/synthetic', AUTH_DATABASE_URL: 'postgresql://jrc_auth@localhost/synthetic',
  REDIS_URL: 'redis://localhost:6379', EVOLUTION_BASE_URL: 'http://localhost:8080', CONSOLE_ALLOWED_ORIGINS: 'https://console.example.test',
  ...Object.fromEntries(['EVOLUTION_API_KEY', 'JWT_SECRET', 'REFRESH_TOKEN_HASH_SECRET', 'API_KEY_HMAC_SECRET',
    'IP_RATE_LIMIT_HMAC_SECRET', 'IDENTITY_RATE_LIMIT_HMAC_SECRET', 'CHALLENGE_ENCRYPTION_KEY', 'BROWSER_CSRF_SECRET']
    .map((key, index) => [key, `synthetic-config-secret-value-00000000-${index}`])),
};

const profiles: Array<[DatabasePoolProfile, number, number]> = [
  ['API_APP', 10, 0], ['API_AUTH', 10, 0], ['API_PLATFORM', 4, 5000],
  ['MESSAGING_WORKER', 4, 5000], ['MESSAGING_AUTH', 2, 5000],
  ['AUTOMATION_WORKER', 4, 5000], ['AUTOMATION_IO_WORKER', 4, 5000],
  ['SCHEDULER_WORKER', 2, 5000], ['LIFECYCLE_WORKER', 2, 5000],
];

describe('database pool budgets', () => {
  it.each(profiles)('preserves the installed %s defaults explicitly', (profile, max, connectionTimeoutMillis) => {
    expect(loadDatabasePoolBudget({}, profile)).toEqual({ max, connectionTimeoutMillis, idleTimeoutMillis: 10000 });
  });

  it.each(profiles)('applies independent validated overrides to %s', profile => {
    const env = { [`${profile}_DB_POOL_MAX`]: '7', [`${profile}_DB_POOL_CONNECT_TIMEOUT_MS`]: '1200',
      [`${profile}_DB_POOL_IDLE_TIMEOUT_MS`]: '60000', UNRELATED_SECRET: 'unused' };
    expect(loadDatabasePoolBudget(env, profile)).toEqual({ max: 7, connectionTimeoutMillis: 1200, idleTimeoutMillis: 60000 });
    expect(env[`${profile}_DB_POOL_MAX`]).toBe('7');
  });

  it('does not apply one process override to a different process', () => {
    expect(loadDatabasePoolBudget({ API_APP_DB_POOL_MAX: '30' }, 'API_AUTH').max).toBe(10);
  });

  it('exposes separate validated budgets in API runtime configuration', () => {
    const config = loadAppConfig({ ...runtimeEnvironment, API_APP_DB_POOL_MAX: '3', API_AUTH_DB_POOL_MAX: '2',
      API_PLATFORM_DB_POOL_MAX: '1', API_APP_DB_POOL_CONNECT_TIMEOUT_MS: '1200' });
    expect(config.databasePools).toEqual({
      app: { max: 3, connectionTimeoutMillis: 1200, idleTimeoutMillis: 10000 },
      auth: { max: 2, connectionTimeoutMillis: 0, idleTimeoutMillis: 10000 },
      platform: { max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
    });
    expect(config.databaseUrl).toBe(runtimeEnvironment.DATABASE_URL);
    expect(config.authDatabaseUrl).toBe(runtimeEnvironment.AUTH_DATABASE_URL);
  });

  it('rejects an invalid API budget during configuration before pool construction', () => {
    expect(() => loadAppConfig({ ...runtimeEnvironment, API_AUTH_DB_POOL_MAX: '0' })).toThrow('API_AUTH_DB_POOL_MAX');
  });

  it.each([
    ['MAX', '0'], ['MAX', '101'], ['MAX', '1.5'], ['MAX', 'NaN'], ['MAX', ''], ['MAX', '  '],
    ['CONNECT_TIMEOUT_MS', '-1'], ['CONNECT_TIMEOUT_MS', '120001'],
    ['IDLE_TIMEOUT_MS', '-1'], ['IDLE_TIMEOUT_MS', '3600001'], ['IDLE_TIMEOUT_MS', 'Infinity'],
  ])('rejects invalid %s and identifies the environment field', (suffix, value) => {
    const key = `API_APP_DB_POOL_${suffix}`;
    expect(() => loadDatabasePoolBudget({ [key]: value }, 'API_APP')).toThrow(key);
  });

  it('allows explicit zero timeouts and the documented upper bounds', () => {
    expect(loadDatabasePoolBudget({ API_APP_DB_POOL_MAX: '100', API_APP_DB_POOL_CONNECT_TIMEOUT_MS: '0',
      API_APP_DB_POOL_IDLE_TIMEOUT_MS: '0' }, 'API_APP')).toEqual({ max: 100, connectionTimeoutMillis: 0, idleTimeoutMillis: 0 });
    expect(loadDatabasePoolBudget({ API_APP_DB_POOL_CONNECT_TIMEOUT_MS: '120000', API_APP_DB_POOL_IDLE_TIMEOUT_MS: '3600000' }, 'API_APP'))
      .toMatchObject({ connectionTimeoutMillis: 120000, idleTimeoutMillis: 3600000 });
  });

  it('makes API app/auth defaults explicit without opening a connection', async () => {
    const pools = createDatabasePools({ app: { connectionString: 'postgresql://jrc_app@localhost/synthetic' },
      auth: { connectionString: 'postgresql://jrc_auth@localhost/synthetic' } });
    try {
      const poolOptions = (pool: unknown) => (pool as { options: Record<string, unknown> }).options;
      expect(poolOptions(pools.appPool)).toMatchObject({ max: 10, connectionTimeoutMillis: 0, idleTimeoutMillis: 10000 });
      expect(poolOptions(pools.authPool)).toMatchObject({ max: 10, connectionTimeoutMillis: 0, idleTimeoutMillis: 10000 });
      expect(pools.appPool.totalCount).toBe(0);
      expect(pools.authPool.totalCount).toBe(0);
    } finally { await pools.close(); }
  });

  it('keeps separate supplied app/auth budgets and idempotent pool closure', async () => {
    const pools = createDatabasePools({ app: loadDatabasePoolBudget({ API_APP_DB_POOL_MAX: '3' }, 'API_APP'),
      auth: loadDatabasePoolBudget({ API_AUTH_DB_POOL_MAX: '2' }, 'API_AUTH') });
    expect((pools.appPool as unknown as { options: { max: number } }).options.max).toBe(3);
    expect((pools.authPool as unknown as { options: { max: number } }).options.max).toBe(2);
    const closing = pools.close();
    expect(pools.close()).toBe(closing);
    await closing;
  });
});
