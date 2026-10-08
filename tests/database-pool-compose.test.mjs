import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDatabasePoolBudget } from '../apps/api/src/db/pool-budget.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'infra', 'dokploy', 'compose.yaml');
const composeSource = readFileSync(composeFile, 'utf8');
const profiles = [
  ['API_APP', { max: 10, connectionTimeoutMillis: 0, idleTimeoutMillis: 10000 }],
  ['API_AUTH', { max: 10, connectionTimeoutMillis: 0, idleTimeoutMillis: 10000 }],
  ['API_PLATFORM', { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }],
  ['MESSAGING_WORKER', { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }],
  ['MESSAGING_AUTH', { max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }],
  ['AUTOMATION_WORKER', { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }],
  ['AUTOMATION_IO_WORKER', { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }],
  ['SCHEDULER_WORKER', { max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }],
  ['LIFECYCLE_WORKER', { max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }],
];
const owners = [
  ['api', ['API_APP', 'API_AUTH', 'API_PLATFORM']],
  ['worker', ['MESSAGING_WORKER', 'MESSAGING_AUTH']],
  ['automation-worker', ['AUTOMATION_WORKER']],
  ['automation-io-worker', ['AUTOMATION_IO_WORKER']],
  ['scheduler-worker', ['SCHEDULER_WORKER']],
  ['lifecycle-worker', ['LIFECYCLE_WORKER']],
];
const fields = [
  ['MAX', 'max'], ['CONNECT_TIMEOUT_MS', 'connectionTimeoutMillis'], ['IDLE_TIMEOUT_MS', 'idleTimeoutMillis'],
];
const variables = (profile, budget) => Object.fromEntries(fields.map(([suffix, field]) =>
  [`${profile}_DB_POOL_${suffix}`, String(budget[field])],
));

// Uses the same local Compose config boundary as dokploy-compose-config.test.mjs:
// interpolation/merge only, without starting containers or contacting PostgreSQL.
function renderCompose(overrides = {}) {
  const requiredNames = [...composeSource.matchAll(/\$\{([A-Z0-9_]+):\?[^}]*\}/g)].map(match => match[1]);
  const synthetic = Object.fromEntries(requiredNames.map(name => [name, 'synthetic-test-value']));
  Object.assign(synthetic, {
    JRC_API_IMAGE: 'example.invalid/jrc-api:test', JRC_WEB_IMAGE: 'example.invalid/jrc-web:test',
    EVOLUTION_ENGINE_IMAGE: 'example.invalid/evolution:test', PUBLIC_ORIGIN: 'https://broker.example.test',
    META_CREDENTIALS_JSON: '{}', META_ASSET_BINDINGS_JSON: '{}', TYPEBOT_ORIGINS_JSON: '{}',
    ...overrides,
  });
  const result = spawnSync('docker', ['compose', '--env-file', join(root, 'infra', 'dokploy', '.env.example'),
    '--file', composeFile, 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: Object.fromEntries([...['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles']
      .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]), ...Object.entries(synthetic)]),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('Dokploy database pool configuration', () => {
  it('delivers all canonical fallback budgets while preserving runtime inheritance and dedicated lifecycle ownership', () => {
    const config = renderCompose();
    for (const [profile, expected] of profiles) {
      expect(loadDatabasePoolBudget({}, profile)).toEqual(expected);
      expect(config['x-runtime']).toMatchObject(variables(profile, expected));
    }
    for (const [service, ownedProfiles] of owners) {
      const environment = config.services[service].environment;
      for (const profile of ownedProfiles) {
        const expected = profiles.find(([name]) => name === profile)[1];
        expect(environment, `${service} must receive ${profile}`).toMatchObject(variables(profile, expected));
        expect(loadDatabasePoolBudget(environment, profile)).toEqual(expected);
      }
      const serviceSource = composeSource.split(new RegExp(`^  ${service}:\\s*$`, 'm'))[1]?.split(/^  [\w-]+:\s*$/m)[0];
      if (service !== 'lifecycle-worker') expect(serviceSource).toMatch(/environment:\s*\n\s+<<: \*runtime/);
    }
    const lifecycle = config.services['lifecycle-worker'].environment;
    expect(lifecycle.LIFECYCLE_DATABASE_URL).toMatch(/^postgresql:\/\/jrc_lifecycle:/);
    for (const name of ['DATABASE_URL', 'AUTH_DATABASE_URL', 'PLATFORM_DATABASE_URL']) expect(lifecycle).not.toHaveProperty(name);
    for (const [profile] of profiles.filter(([name]) => name !== 'LIFECYCLE_WORKER')) {
      for (const [suffix] of fields) expect(lifecycle).not.toHaveProperty(`${profile}_DB_POOL_${suffix}`);
    }
  });

  it('delivers independent operator overrides to the pools owned by each service', () => {
    const custom = profiles.map(([profile], index) => [profile,
      { max: 11 + index, connectionTimeoutMillis: 1250 + index, idleTimeoutMillis: 22000 + index }]);
    const config = renderCompose(Object.assign({}, ...custom.map(([profile, budget]) => variables(profile, budget))));
    for (const [service, ownedProfiles] of owners) {
      for (const profile of ownedProfiles) {
        const expected = custom.find(([name]) => name === profile)[1];
        const environment = config.services[service].environment;
        expect(environment, `${service} must receive configured ${profile}`).toMatchObject(variables(profile, expected));
        expect(loadDatabasePoolBudget(environment, profile)).toEqual(expected);
      }
    }
  });

  it('keeps explicit empty overrides visible so runtime validation rejects the misconfiguration', () => {
    const empty = Object.fromEntries(profiles.flatMap(([profile]) => fields.map(([suffix]) => [`${profile}_DB_POOL_${suffix}`, ''])));
    const config = renderCompose(empty);
    for (const [service, ownedProfiles] of owners) {
      for (const profile of ownedProfiles) {
        const fallback = profiles.find(([name]) => name === profile)[1];
        for (const [suffix] of fields) {
          const name = `${profile}_DB_POOL_${suffix}`;
          const value = config.services[service].environment[name];
          expect(value, `${service} must preserve the explicit empty ${name}`).toBe('');
          expect(() => loadDatabasePoolBudget({ ...variables(profile, fallback), [name]: value }, profile)).toThrow(name);
        }
      }
    }
  });
});
