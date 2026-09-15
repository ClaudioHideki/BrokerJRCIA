import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import type { FullConfig } from '@playwright/test';
import { Pool } from 'pg';

import {
  FakeProviderAdapter,
  ProviderRegistry,
  type BeginConnectionInput,
  type ProviderContext,
  type ProviderInstanceReference,
  type ProviderStatus,
  type ProvisionInstanceInput,
} from '@jrc/providers';
import { initializePasswordVerifier } from '@jrc/security';

import { buildApp } from '../../../api/src/app.js';
import { runMigrations } from '../../../api/src/db/migrate.js';
import { withOrganizationTransaction } from '../../../api/src/db/tenant-transaction.js';
import { createPostgresApiKeyRepository } from '../../../api/src/modules/api-keys/repository.js';
import { createApiKeyService } from '../../../api/src/modules/api-keys/service.js';
import { writeTenantAudit } from '../../../api/src/modules/audit/audit.js';
import { createSecurityAuditWriter } from '../../../api/src/modules/audit/security-audit.js';
import { createPostgresAuthRepository } from '../../../api/src/modules/auth/repository.js';
import {
  RedisRateLimitStore,
  createRuntimeRedisClient,
} from '../../../api/src/modules/auth/rate-limit/redis-store.js';
import { createPostgresInstanceRepository } from '../../../api/src/modules/instances/repository.js';
import { createInstanceService } from '../../../api/src/modules/instances/service.js';
import { createPostgresProviderAccountRepository } from '../../../api/src/modules/provider-accounts/repository.js';
import { createProviderAccountService } from '../../../api/src/modules/provider-accounts/service.js';
import { withGlobalRoleLock } from '../../../api/tests/integration/helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
  type IsolatedPostgresDatabase,
} from '../../../api/tests/integration/helpers/postgres.js';
import {
  ADMIN_CREDENTIAL,
  createRealBootstrap,
  createRealTenantCreator,
} from '../../../api/tests/integration/helpers/task7.js';
import { runE2eCleanupSteps, type E2eCleanupStep } from './cleanup.js';
import { SYNTHETIC_PAIRING_HINT } from './artifact-policy.js';
import { createMessagingFixture } from './messaging-fixture.js';
import { createPlatformFixture } from './platform-fixture.js';
import { createMessagingMembershipResolver } from '../../../api/src/modules/messaging/membership.js';

const API_PORT = 33_10;
const CONSOLE_ORIGIN = 'http://127.0.0.1:4173';
const QR_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function requiredRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) throw new Error('TEST_REDIS_URL is required for isolated browser E2E tests');
  return value;
}

function roleConnectionString(connectionString: string, role: 'jrc_app' | 'jrc_auth'): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = '';
  return url.toString();
}

function secret(): string {
  return randomBytes(48).toString('base64url');
}

export class BrowserE2eFakeProvider extends FakeProviderAdapter {
  readonly #connected = new Set<string>();
  readonly #pendingChallengeObservation = new Set<string>();

  override async provisionInstance(context: ProviderContext, input: ProvisionInstanceInput) {
    this.responses.provisionInstance = {
      reference: { id: input.upstreamInstanceKey },
      status: 'CREATED',
    };
    return super.provisionInstance(context, input);
  }

  override async beginConnection(context: ProviderContext, input: BeginConnectionInput) {
    this.#connected.add(input.reference.id);
    this.#pendingChallengeObservation.add(input.reference.id);
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    this.responses.beginConnection = input.pairingHint
      ? { type: 'PAIRING_CODE', code: '1234-5678', expiresAt }
      : { type: 'QR_CODE', encoding: 'BASE64', value: QR_PNG, expiresAt };
    return super.beginConnection(context, input);
  }

  override async getStatus(context: ProviderContext, reference: ProviderInstanceReference) {
    if (this.#pendingChallengeObservation.delete(reference.id)) {
      this.responses.getStatus = 'AWAITING_ACTION';
    } else {
      this.responses.getStatus = (
        this.#connected.has(reference.id) ? 'CONNECTED' : 'CREATED'
      ) satisfies ProviderStatus;
    }
    return super.getStatus(context, reference);
  }

  override async disconnect(context: ProviderContext, reference: ProviderInstanceReference) {
    this.#connected.delete(reference.id);
    this.#pendingChallengeObservation.delete(reference.id);
    return super.disconnect(context, reference);
  }
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const adminUrl = requireTestDatabaseAdminUrl();
  const redisUrl = requiredRedisUrl();
  const redisPrefix = `jrc:e2e:${randomUUID()}:`;
  let database: IsolatedPostgresDatabase | undefined;
  let appPool: Pool | undefined;
  let authPool: Pool | undefined;
  const redisClient = createRuntimeRedisClient({
    url: redisUrl,
    connectTimeoutMs: 1_000,
    reconnectMaxAttempts: 1,
    reconnectDelayMs: 50,
  });
  let app: ReturnType<typeof buildApp> | undefined;
  let messagingFixture: Awaited<ReturnType<typeof createMessagingFixture>> | undefined;
  let redisWasConnected = false;
  let platformFixture:Awaited<ReturnType<typeof createPlatformFixture>>|undefined;
  let syntheticEmail = '';
  let syntheticPassword = '';
  const logChunks: string[] = [];
  const logSink = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(String(chunk));
      callback();
    },
  });

  const teardown = async () => {
    delete process.env.JRC_E2E_EMAIL;
    delete process.env.JRC_E2E_PASSWORD;
    delete process.env.JRC_E2E_META_SECRET;
    const steps: E2eCleanupStep[] = [];
    if (app) steps.push({ name: 'Fastify API', run: async () => app!.close() });
    if (platformFixture) steps.push({name:'platform pool',run:platformFixture.cleanup});
    if (messagingFixture) steps.push({ name: 'messaging worker', run: messagingFixture.close });
    if (appPool) steps.push({ name: 'jrc_app pool', run: async () => appPool!.end() });
    if (authPool) steps.push({ name: 'jrc_auth pool', run: async () => authPool!.end() });
    if (redisWasConnected) {
      steps.push({
        name: 'owned Redis keys',
        run: async () => {
          if (!redisClient.isOpen) await redisClient.connect();
          const keys = await redisClient.keys(`${redisPrefix}*`);
          if (keys.length > 0) await redisClient.del(keys);
          const remaining = await redisClient.keys(`${redisPrefix}*`);
          if (remaining.length > 0) throw new Error('owned Redis keys remain');
        },
      });
      steps.push({
        name: 'Redis connection',
        run: async () => {
          if (redisClient.isOpen) await redisClient.quit();
        },
      });
    }
    if (database) steps.push({ name: 'isolated PostgreSQL database', run: database.dispose });
    steps.push({
      name: 'sensitive log canaries',
      run: async () => {
        const logs = logChunks.join('');
        if (
          (syntheticEmail && logs.includes(syntheticEmail))
          || (syntheticPassword && logs.includes(syntheticPassword))
          || logs.includes(QR_PNG)
          || logs.includes('1234-5678')
          || logs.includes(SYNTHETIC_PAIRING_HINT)
        ) {
          throw new Error('sensitive E2E canary reached API logs');
        }
      },
    });
    await runE2eCleanupSteps(steps);
  };

  try {
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database!.connectionString));

    const email = `console-${randomUUID()}@example.test`;
    const password = `E2E-${secret()}!`;
    syntheticEmail = email;
    syntheticPassword = password;
    await createRealBootstrap(database.pool)({
      organizationName: 'JRC E2E Matriz',
      organizationSlug: `jrc-e2e-matriz-${randomUUID()}`,
      email,
      password,
      requestId: randomUUID(),
    });
    await createRealTenantCreator(database.pool)({
      ownerMode: 'LINK_EXISTING',
      confirmLinkExisting: true,
      administrativeCredential: ADMIN_CREDENTIAL,
      organizationName: 'JRC E2E Filial',
      organizationSlug: `jrc-e2e-filial-${randomUUID()}`,
      ownerEmail: email,
      requestId: randomUUID(),
    });

    appPool = new Pool({
      connectionString: roleConnectionString(database.connectionString, 'jrc_app'),
      max: 4,
    });
    authPool = new Pool({
      connectionString: roleConnectionString(database.connectionString, 'jrc_auth'),
      max: 4,
    });
    await redisClient.connect();
    redisWasConnected = true;

    const jwtSecret = secret();
    const refreshTokenHashSecret = secret();
    const apiKeyHmacSecret = secret();
    const ipRateLimitHmacSecret = secret();
    const identityRateLimitHmacSecret = secret();
    const browserCsrfSecret = secret();
    const authRepository = createPostgresAuthRepository(authPool);
    const rateLimitStore = new RedisRateLimitStore(redisClient, {
      prefix: redisPrefix,
      deadlineMs: 1_000,
    });
    const writeSecurityAudit = createSecurityAuditWriter(authPool);
    const writeOrganizationSelectedAudit = async (event: Parameters<typeof writeTenantAudit>[1]) => {
      await withOrganizationTransaction(
        appPool!,
        event.organizationId,
        (transaction) => writeTenantAudit(transaction, {
          type: 'ORGANIZATION_SELECTED',
          ...event,
        }),
      );
    };
    const sharedAuth = {
      repository: authRepository,
      rateLimitStore,
      writeSecurityAudit,
      writeOrganizationSelectedAudit,
      ipRateLimitHmacSecret,
      identityRateLimitHmacSecret,
      jwtSecret,
      refreshTokenHashSecret,
      trustedProxyCidrs: [] as string[],
      rateLimit: { limit: 100, ttlMs: 60_000 },
      progressiveDelay: { baseDelayMs: 0, maximumDelayMs: 0 },
      sleeper: async () => undefined,
    };
    const apiKeys = createApiKeyService({
      repository: createPostgresApiKeyRepository(),
      hmacSecret: apiKeyHmacSecret,
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool!, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
    });
    const provider = new BrowserE2eFakeProvider();
    const providers = new ProviderRegistry([provider], [['BAILEYS', provider]]);
    const instances = createInstanceService({
      repository: createPostgresInstanceRepository(),
      providers,
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool!, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
    });

    const passwordVerifier = await initializePasswordVerifier();
    messagingFixture = await createMessagingFixture(database.pool, appPool);
    platformFixture=await createPlatformFixture(database.pool,database.connectionString,CONSOLE_ORIGIN);
    const metaWebhookSecret = secret();
    process.env.JRC_E2E_META_SECRET = metaWebhookSecret;
    app = buildApp({
      nodeEnv: 'test',
      platform:platformFixture.routeOptions,
      tenantOperations:{jwtSecret,authenticateApiKey:apiKeys.authenticateApiKey,transact:(organizationId,operation)=>withOrganizationTransaction(appPool!,organizationId,operation)},
      messaging: { jwtSecret, authenticateApiKey: apiKeys.authenticateApiKey, service: messagingFixture.service,
        resolveCurrentRole: createMessagingMembershipResolver(authPool) },
      metaWebhooks: { appSecret: metaWebhookSecret, verifyToken: secret(), ingest: messagingFixture.ingest },
      loggerDestination: logSink,
      passwordVerifierInitializer: async () => passwordVerifier,
      auth: sharedAuth,
      consoleAuth: {
        ...sharedAuth,
        browserCsrfSecret,
        consoleAllowedOrigins: [CONSOLE_ORIGIN],
        browserCookieSecure: false,
      },
      apiKeys: {
        jwtSecret,
        authenticateApiKey: apiKeys.authenticateApiKey,
        issueApiKey: apiKeys.issueApiKey,
        listApiKeys: apiKeys.listApiKeys,
        revokeApiKey: apiKeys.revokeApiKey,
      },
      providerAccounts: {
        jwtSecret,
        authenticateApiKey: apiKeys.authenticateApiKey,
        service: createProviderAccountService({
          repository: createPostgresProviderAccountRepository(),
          runInOrganizationTransaction: (organizationId, operation) => (
            withOrganizationTransaction(appPool!, organizationId, operation)
          ),
        }),
      },
      instances: {
        jwtSecret,
        authenticateApiKey: apiKeys.authenticateApiKey,
        service: instances,
        requestTimeoutMs: 5_000,
      },
    });
    await app.listen({ host: '127.0.0.1', port: API_PORT });
    process.env.JRC_E2E_EMAIL = email;
    process.env.JRC_E2E_PASSWORD = password;
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
