import { expect, it } from 'vitest';
import { mayUsePlatformToken } from '../../src/modules/integrations/chatwoot-context.js';
import { loadIntegrationConfig } from '../../src/modules/integrations/runtime.js';

it('never authorizes platform credentials for an external or nonmatching destination', () => {
  expect(mayUsePlatformToken({ mode: 'EXTERNAL', origin: 'https://client.example.com', managedOrigin: 'https://jrc.example.com' })).toBe(false);
  expect(mayUsePlatformToken({ mode: 'MANAGED', origin: 'https://other.example.com', managedOrigin: 'https://jrc.example.com' })).toBe(false);
  expect(mayUsePlatformToken({ mode: 'MANAGED', origin: 'https://jrc.example.com', managedOrigin: 'https://jrc.example.com' })).toBe(true);
  expect(mayUsePlatformToken({ mode: 'EXTERNAL', origin: 'https://client.example.com', managedOrigin: null })).toBe(false);
});
it('supports external-only runtime without inferring a managed origin from the media encryption key', () => {
  const encryptionKey = Buffer.alloc(32, 4).toString('base64');
  const config = loadIntegrationConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://broker.example.com',
    INTEGRATION_ENCRYPTION_KEY: encryptionKey, CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED: 'true' });
  expect(config.chatwoot).toMatchObject({ publicOrigin: 'https://broker.example.com', encryptionKey, externalDestinationsEnabled: true });
  expect(config.chatwoot?.baseUrl).toBeUndefined();
  expect(loadIntegrationConfig({ INTEGRATION_ENCRYPTION_KEY: encryptionKey })).toEqual({});
  // Disabling new registrations must not turn off delivery for saved external tenants.
  expect(loadIntegrationConfig({ PUBLIC_ORIGIN: 'https://broker.example.com', INTEGRATION_ENCRYPTION_KEY: encryptionKey,
    CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED: 'false' }).chatwoot).toMatchObject({ externalDestinationsEnabled: false });
  expect(() => loadIntegrationConfig({ CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED: 'true' })).toThrow();
  expect(() => loadIntegrationConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://broker.example.com', INTEGRATION_ENCRYPTION_KEY: encryptionKey,
    CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED: 'true', CHATWOOT_PLATFORM_TOKEN: 'synthetic-platform' })).toThrow();
});
