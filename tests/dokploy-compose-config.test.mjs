import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'infra', 'dokploy', 'compose.yaml');
const composeSource = readFileSync(composeFile, 'utf8');

function renderCompose(overrides = {}) {
  const requiredNames = [...composeSource.matchAll(/\$\{([A-Z0-9_]+):\?[^}]*\}/g)].map((match) => match[1]);
  const synthetic = Object.fromEntries(requiredNames.map((name) => [name, 'synthetic-test-value']));
  Object.assign(synthetic, {
    JRC_API_IMAGE: 'example.invalid/jrc-api:test',
    JRC_WEB_IMAGE: 'example.invalid/jrc-web:test',
    EVOLUTION_ENGINE_IMAGE: 'example.invalid/evolution:test',
    META_CREDENTIALS_JSON: '{}',
    META_ASSET_BINDINGS_JSON: '{}',
    TYPEBOT_ORIGINS_JSON: '{}',
    PUBLIC_ORIGIN: 'https://jrc-broker.jrcws.cloud',
    CHATWOOT_BASE_URL: '',
    CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED: 'true',
    ...overrides,
  });

  const result = spawnSync('docker', ['compose', '--file', composeFile, 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ProgramFiles: process.env.ProgramFiles,
      ...synthetic,
    },
  });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('Dokploy Compose interpolation', () => {
  it('allows an external-only Chatwoot installation while keeping the existing broker host', () => {
    const config = renderCompose();
    const labels = config.services.web.labels;

    expect(config.services.api.environment.CHATWOOT_BASE_URL).toBe('');
    expect(config.services.worker.environment.CHATWOOT_BASE_URL).toBe('');
    expect(config.services.api.environment.CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED).toBe('true');
    expect(labels['traefik.http.routers.jrc-broker-broker-ophydn-57-web.rule']).toBe(
      'Host(`jrc-broker.jrcws.cloud`)',
    );
    expect(labels['traefik.http.routers.jrc-broker-broker-ophydn-57-websecure.rule']).toBe(
      'Host(`jrc-broker.jrcws.cloud`)',
    );
  });

  it('routes both HTTP and HTTPS through a commercial broker host', () => {
    const config = renderCompose({
      BROKER_HOST: 'broker.customer.example',
      PUBLIC_ORIGIN: 'https://broker.customer.example',
    });
    const labels = config.services.web.labels;

    expect(labels['traefik.http.routers.jrc-broker-broker-ophydn-57-web.rule']).toBe(
      'Host(`broker.customer.example`)',
    );
    expect(labels['traefik.http.routers.jrc-broker-broker-ophydn-57-websecure.rule']).toBe(
      'Host(`broker.customer.example`)',
    );
    expect(config.services.api.environment.PUBLIC_ORIGIN).toBe('https://broker.customer.example');
  });

  it('isolates project and Traefik identifiers for a second installation', () => {
    const config = renderCompose({
      BROKER_STACK_NAME: 'broker-customer-a',
      BROKER_ROUTE_ID: 'broker-customer-a',
      BROKER_HOST: 'broker.customer.example',
      PUBLIC_ORIGIN: 'https://broker.customer.example',
    });
    expect(config.name).toBe('broker-customer-a');
    expect(config.services.web.labels['traefik.http.routers.broker-customer-a-web.rule']).toBe(
      'Host(`broker.customer.example`)',
    );
    expect(config.services.web.labels['traefik.http.routers.broker-customer-a-websecure.rule']).toBe(
      'Host(`broker.customer.example`)',
    );
    expect(config.services.web.labels['traefik.http.routers.broker-customer-a-web.service']).toBe(
      'broker-customer-a-web',
    );
  });

  it('preserves a configured managed Chatwoot origin', () => {
    const config = renderCompose({
      CHATWOOT_BASE_URL: 'https://conversas.customer.example',
      CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED: 'false',
    });

    expect(config.services.api.environment.CHATWOOT_BASE_URL).toBe(
      'https://conversas.customer.example',
    );
    expect(config.services.worker.environment.CHATWOOT_BASE_URL).toBe(
      'https://conversas.customer.example',
    );
  });
});
