import swagger from "@fastify/swagger";
import { registerFlowRoutes, type FlowRouteOptions } from './http/routes/flows.js';
import { createFlowService } from './modules/flows/service.js';
import { registerAutomationRoutes, type AutomationRouteOptions } from './http/routes/automations.js';
import { registerObservabilityRoutes, type ObservabilityRouteOptions } from './http/routes/observability.js';
import { createAutomationService, createEventRouter, createExecutionService } from './modules/automations/service.js';
import { createPostgresAutomationRepository } from './modules/automations/repository.js';
import { createLegacyFlowMigrationService } from './modules/automations/legacy-migration.js';
import { createObservabilityService } from './modules/observability/service.js';
import { registerCredentialRoutes, type CredentialRouteOptions } from './http/routes/credentials.js';
import { createCredentialService, createCredentialVault } from './modules/automation-integrations/credentials.js';
import { createCredentialTester } from './modules/automation-integrations/credential-tester.js';
import { registerAutomationWebhookRoutes, type AutomationWebhookRouteOptions } from './http/routes/automation-webhooks.js';
import { createWebhookService } from './modules/automation-integrations/webhooks.js';
import { registerAutomationImportRoutes, type AutomationImportRouteOptions } from './http/routes/automation-imports.js';
import { createAutomationImporter } from './modules/automation-integrations/importer.js';
import { createIntegrationRuntime } from "./modules/integrations/runtime.js";
import { z } from 'zod';
import { createChatwootControlAuth } from './modules/integrations/chatwoot-control-auth.js';
import { createEmbedService } from './modules/integrations/embed/authorization.js';
import { registerChatwootEmbedRoutes, type ChatwootEmbedRouteOptions } from './http/routes/chatwoot-embed.js';
import { registerChatwootControlRoutes, type ChatwootControlRouteOptions } from './http/routes/chatwoot-control.js';
import {
  registerIntegrationRoutes,
  type IntegrationRouteOptions,
} from "./http/routes/integrations.js";
import {
  registerInstanceWorkspaceRoutes,
  type InstanceWorkspaceRouteOptions,
} from "./http/routes/instance-workspace.js";
import { InstanceWorkspaceService } from "./modules/instances/workspace.js";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { LogController } from "fastify";
import { Pool } from "pg";
import {
  registerPlatformRoutes,
  type PlatformRouteOptions,
} from "./http/routes/platform.js";
import { PlatformService } from "./modules/platform/service.js";
import {
  registerMetaOnboardingRoutes,
  type MetaOnboardingRouteOptions,
} from "./http/routes/meta-onboarding.js";
import { createMetaOnboardingService } from "./modules/meta-onboarding/service.js";
import { createMetaOnboardingWebhook } from "./modules/meta-onboarding/webhook.js";
import {
  registerChannelRoutes,
  type ChannelRouteOptions,
} from "./http/routes/channels.js";
import { createChannelFacade } from "./modules/channels/facade.js";
import {
  registerTenantOperationsRoutes,
  type TenantOperationsOptions,
} from "./http/routes/tenant-operations.js";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import {
  createRedactedLogger,
  initializePasswordVerifier,
  type LoggerDestination,
  type PasswordVerifier,
} from "@jrc/security";
import {
  EvolutionProviderAdapter,
  EvolutionWorkspaceClient,
  ProviderRegistry,
} from "@jrc/providers";

import {
  registerAuthRoutes,
  type AuthRouteOptions,
} from "./http/routes/auth.js";
import {
  registerConsoleAuthRoutes,
  type ConsoleAuthRouteOptions,
} from "./http/routes/console-auth.js";
import {
  registerApiKeyRoutes,
  type ApiKeyRouteOptions,
} from "./http/routes/api-keys.js";
import {
  registerInstanceRoutes,
  type InstanceRouteOptions,
} from "./http/routes/instances.js";
import {
  registerProviderAccountRoutes,
  type ProviderAccountRouteOptions,
} from "./http/routes/provider-accounts.js";
import { resolveRequestId } from "./http/request-id.js";
import { loadAppConfig } from "./config/env.js";
import { createDatabasePools } from "./db/pools.js";
import { withOrganizationTransaction } from "./db/tenant-transaction.js";
import { writeTenantAudit } from "./modules/audit/audit.js";
import { createSecurityAuditWriter } from "./modules/audit/security-audit.js";
import { createPostgresAuthRepository } from "./modules/auth/repository.js";
import {
  createRuntimeRedisClient,
  RedisRateLimitStore,
} from "./modules/auth/rate-limit/redis-store.js";
import { createPostgresApiKeyRepository } from "./modules/api-keys/repository.js";
import { createApiKeyService } from "./modules/api-keys/service.js";
import { createPostgresInstanceRepository } from "./modules/instances/repository.js";
import { createInstanceService } from "./modules/instances/service.js";
import { createPostgresProviderAccountRepository } from "./modules/provider-accounts/repository.js";
import { createProviderAccountService } from "./modules/provider-accounts/service.js";
import {
  registerMessagingRoutes,
  type MessagingRouteOptions,
} from "./http/routes/messaging.js";
import { createPostgresMessagingRepository } from "./modules/messaging/repository.js";
import { createMessagingService } from "./modules/messaging/service.js";
import { createMessagingMembershipResolver } from "./modules/messaging/membership.js";
import {
  createMetaClientResolver,
  createTypebotClientResolver,
} from "./modules/messaging/credentials.js";
import {
  createMetaIngestor,
  loadMetaAssetBindings,
} from "./modules/messaging/ingest.js";
import {
  registerMetaWebhookRoutes,
  type MetaWebhookRouteOptions,
} from "./http/routes/meta-webhooks.js";

declare module "fastify" {
  interface FastifyInstance {
    passwordVerifier: PasswordVerifier | null;
  }
}

export interface BuildAppOptions {
  readinessCheck?: () => Promise<void>;
  loggerDestination?: LoggerDestination;
  passwordVerifierInitializer?: () => Promise<PasswordVerifier>;
  nodeEnv?: "development" | "test" | "production";
  auth?: Omit<AuthRouteOptions, "getPasswordVerifier" | "nodeEnv">;
  consoleAuth?: Omit<ConsoleAuthRouteOptions, "nodeEnv">;
  apiKeys?: ApiKeyRouteOptions;
  providerAccounts?: ProviderAccountRouteOptions;
  instances?: InstanceRouteOptions;
  channels?: ChannelRouteOptions;
  instanceWorkspace?: InstanceWorkspaceRouteOptions;
  messaging?: MessagingRouteOptions;
  flows?: FlowRouteOptions;
  automations?: AutomationRouteOptions;
  observability?: ObservabilityRouteOptions;
  credentials?: CredentialRouteOptions;
  automationWebhooks?: AutomationWebhookRouteOptions;
  automationImports?: AutomationImportRouteOptions;
  metaWebhooks?: MetaWebhookRouteOptions;
  platform?: PlatformRouteOptions;
  metaOnboarding?: MetaOnboardingRouteOptions;
  tenantOperations?: TenantOperationsOptions;
  integrations?: IntegrationRouteOptions;
  chatwootControl?: ChatwootControlRouteOptions;
  chatwootEmbed?: ChatwootEmbedRouteOptions;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'";
const SWAGGER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
].join("; ");

export function resolveContentSecurityPolicy(
  requestUrl: string,
  swaggerUiEnabled: boolean,
): string {
  return swaggerUiEnabled && requestUrl.startsWith("/documentation")
    ? SWAGGER_CONTENT_SECURITY_POLICY
    : API_CONTENT_SECURITY_POLICY;
}

export function buildApp(options: BuildAppOptions = {}) {
  const nodeEnv =
    options.nodeEnv ??
    (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "production"
      ? process.env.NODE_ENV
      : "development");
  const app = Fastify({
    genReqId(request) {
      return resolveRequestId(request.headers["x-request-id"]);
    },
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: createRedactedLogger(options.loggerDestination),
  });
  const passwordVerifierInitializer =
    options.passwordVerifierInitializer ?? initializePasswordVerifier;
  const runtimeConfig =
    nodeEnv === "test"
      ? null
      : loadAppConfig({
          ...(options.environment ?? process.env),
          NODE_ENV: nodeEnv,
        });
  if (
    nodeEnv !== "test" &&
    (options.auth !== undefined ||
      options.readinessCheck !== undefined ||
      options.consoleAuth !== undefined ||
      options.apiKeys !== undefined ||
      options.providerAccounts !== undefined ||
      options.instances !== undefined ||
      options.channels !== undefined ||
      options.instanceWorkspace !== undefined ||
      options.messaging !== undefined ||
      options.flows !== undefined ||
      options.automations !== undefined ||
      options.observability !== undefined ||
      options.credentials !== undefined ||
      options.automationWebhooks !== undefined ||
      options.automationImports !== undefined ||
      options.metaWebhooks !== undefined ||
      options.platform !== undefined ||
      options.metaOnboarding !== undefined ||
      options.tenantOperations !== undefined ||
      options.integrations !== undefined || options.chatwootControl !== undefined || options.chatwootEmbed !== undefined)
  ) {
    throw new Error("Runtime authentication dependency injection is forbidden");
  }
  if (nodeEnv !== "test" && options.passwordVerifierInitializer !== undefined) {
    throw new Error(
      "Runtime password verifier dependency injection is forbidden",
    );
  }
  let auth = nodeEnv === "test" ? options.auth : undefined;
  let consoleAuth = nodeEnv === "test" ? options.consoleAuth : undefined;
  let apiKeys = nodeEnv === "test" ? options.apiKeys : undefined;
  let providerAccounts =
    nodeEnv === "test" ? options.providerAccounts : undefined;
  let instances = nodeEnv === "test" ? options.instances : undefined;
  let channels = nodeEnv === "test" ? options.channels : undefined;
  let messaging = nodeEnv === "test" ? options.messaging : undefined;
  let flows = nodeEnv === "test" ? options.flows : undefined;
  let automations = nodeEnv === "test" ? options.automations : undefined;
  let observability = nodeEnv === "test" ? options.observability : undefined;
  let credentials = nodeEnv === "test" ? options.credentials : undefined;
  let automationWebhooks = nodeEnv === "test" ? options.automationWebhooks : undefined;
  let automationImports = nodeEnv === "test" ? options.automationImports : undefined;
  let instanceWorkspace =
    nodeEnv === "test" ? options.instanceWorkspace : undefined;
  let metaWebhooks = nodeEnv === "test" ? options.metaWebhooks : undefined;
  let platform = nodeEnv === "test" ? options.platform : undefined;
  let metaOnboarding = nodeEnv === "test" ? options.metaOnboarding : undefined;
  let tenantOperations =
    nodeEnv === "test" ? options.tenantOperations : undefined;
  let integrations = nodeEnv === "test" ? options.integrations : undefined;
  let chatwootControl = nodeEnv === 'test' ? options.chatwootControl : undefined;
  let chatwootEmbed = nodeEnv === 'test' ? options.chatwootEmbed : undefined;
  let readinessCheck = nodeEnv === "test" ? options.readinessCheck : undefined;
  if (
    (!auth || !consoleAuth || !apiKeys || !providerAccounts || !instances) &&
    nodeEnv !== "test"
  ) {
    const config = runtimeConfig!;
    const pools = createDatabasePools({
      app: { connectionString: config.databaseUrl },
      auth: { connectionString: config.authDatabaseUrl },
    });
    const redisClient = createRuntimeRedisClient({
      url: config.redisUrl,
      connectTimeoutMs: config.redisFailurePolicy.connectTimeoutMs,
      reconnectMaxAttempts: config.redisFailurePolicy.reconnectMaxAttempts,
      reconnectDelayMs: config.redisFailurePolicy.reconnectDelayMs,
    });
    redisClient.on("error", () => {
      app.log.error(
        { code: "REDIS_CONNECTION_ERROR" },
        "Redis connection error",
      );
    });
    const rateLimitStore = new RedisRateLimitStore(redisClient, {
      deadlineMs: config.redisFailurePolicy.commandDeadlineMs,
    });
    const repository = createPostgresAuthRepository(pools.authPool);
    // Revalidate all tenant JWTs before route RBAC, including tokens issued before a role change.
    app.decorate(
      "resolveTenantRole",
      async (userId: string, organizationId: string) => {
        const result = await pools.authPool.query<{
          role: import("./http/plugins/authorization.js").Role;
        }>(
          `SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id
          JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2
          AND m.status='ACTIVE' AND u.status='ACTIVE' AND o.status<>'DISABLED'`,
          [userId, organizationId],
        );
        return result.rows[0]?.role ?? null;
      },
    );
    auth ??= {
      repository,
      rateLimitStore,
      ipRateLimitHmacSecret: config.ipRateLimitHmacSecret,
      identityRateLimitHmacSecret: config.identityRateLimitHmacSecret,
      jwtSecret: config.jwtSecret,
      refreshTokenHashSecret: config.refreshTokenHashSecret,
      trustedProxyCidrs: config.trustedProxyCidrs,
      rateLimit: config.authRateLimit,
      progressiveDelay: config.authProgressiveDelay,
      writeSecurityAudit: createSecurityAuditWriter(pools.authPool),
      async writeOrganizationSelectedAudit(event) {
        await withOrganizationTransaction(
          pools.appPool,
          event.organizationId,
          async (transaction) =>
            writeTenantAudit(transaction, {
              type: "ORGANIZATION_SELECTED",
              ...event,
            }),
        );
      },
    };
    consoleAuth ??= {
      repository,
      rateLimitStore,
      ipRateLimitHmacSecret: config.ipRateLimitHmacSecret,
      identityRateLimitHmacSecret: config.identityRateLimitHmacSecret,
      jwtSecret: config.jwtSecret,
      refreshTokenHashSecret: config.refreshTokenHashSecret,
      browserCsrfSecret: config.browserCsrfSecret,
      consoleAllowedOrigins: config.consoleAllowedOrigins,
      browserCookieSecure: config.consoleCookieSecure,
      trustedProxyCidrs: config.trustedProxyCidrs,
      rateLimit: config.authRateLimit,
      progressiveDelay: config.authProgressiveDelay,
      writeSecurityAudit: createSecurityAuditWriter(pools.authPool),
      async writeOrganizationSelectedAudit(event) {
        await withOrganizationTransaction(
          pools.appPool,
          event.organizationId,
          async (transaction) =>
            writeTenantAudit(transaction, {
              type: "ORGANIZATION_SELECTED",
              ...event,
            }),
        );
      },
    };
    if (!apiKeys) {
      const service = createApiKeyService({
        repository: createPostgresApiKeyRepository(),
        hmacSecret: config.apiKeyHmacSecret,
        runInOrganizationTransaction: (organizationId, operation) =>
          withOrganizationTransaction(pools.appPool, organizationId, operation),
        writeAudit: writeTenantAudit,
      });
      apiKeys = {
        jwtSecret: config.jwtSecret,
        authenticateApiKey: service.authenticateApiKey,
        issueApiKey: service.issueApiKey,
        listApiKeys: service.listApiKeys,
        revokeApiKey: service.revokeApiKey,
      };
    }
    if (!providerAccounts) {
      providerAccounts = {
        jwtSecret: config.jwtSecret,
        authenticateApiKey: apiKeys.authenticateApiKey,
        service: createProviderAccountService({
          repository: createPostgresProviderAccountRepository(),
          runInOrganizationTransaction: (organizationId, operation) =>
            withOrganizationTransaction(
              pools.appPool,
              organizationId,
              operation,
            ),
        }),
      };
    }
    if (!instances) {
      const evolution = new EvolutionProviderAdapter({
        baseUrl: config.evolutionBaseUrl,
        apiKey: config.evolutionApiKey,
      });
      const providers = new ProviderRegistry(
        [evolution],
        [["BAILEYS", evolution]],
      );
      const service = createInstanceService({
        repository: createPostgresInstanceRepository(),
        providers,
        runInOrganizationTransaction: (organizationId, operation) =>
          withOrganizationTransaction(pools.appPool, organizationId, operation),
        writeAudit: writeTenantAudit,
      });
      instances = {
        jwtSecret: config.jwtSecret,
        authenticateApiKey: apiKeys.authenticateApiKey,
        service,
      };
    }
    instanceWorkspace = {
      jwtSecret: config.jwtSecret,
      authenticateApiKey: apiKeys.authenticateApiKey,
      service: new InstanceWorkspaceService({
        transact: (org, operation) =>
          withOrganizationTransaction(pools.appPool, org, operation),
        provider: new EvolutionWorkspaceClient({
          baseUrl: config.evolutionBaseUrl,
          apiKey: config.evolutionApiKey,
        }),
      }),
    };
    const messagingEnvironment = options.environment ?? process.env;
    const metaOnboardingService = createMetaOnboardingService({
      environment: messagingEnvironment,
      transact: (organizationId, operation) =>
        withOrganizationTransaction(pools.appPool, organizationId, operation),
    });
    const controlAuth = createChatwootControlAuth({ enabled: z.enum(['true', 'false']).default('false').parse(messagingEnvironment.CHATWOOT_CONTROL_ENABLED) === 'true',
      hmacSecret: config.apiKeyHmacSecret,
      managedOrigin: messagingEnvironment.CHATWOOT_BASE_URL ? new URL(messagingEnvironment.CHATWOOT_BASE_URL).origin : undefined,
      transact: (org, work) => withOrganizationTransaction(pools.appPool, org, work),
      resolveCurrentRole: createMessagingMembershipResolver(pools.authPool) });
    const integrationRuntime = createIntegrationRuntime(
      { ...messagingEnvironment, NODE_ENV: nodeEnv },
      pools.appPool,
      createMetaClientResolver(
        messagingEnvironment,
        metaOnboardingService.resolveCredential,
      ),
      { auth: controlAuth, instances: instances.service },
    );
    channels = {
      jwtSecret: config.jwtSecret,
      authenticateApiKey: apiKeys.authenticateApiKey,
      resolveCurrentRole: createMessagingMembershipResolver(pools.authPool),
      service: createChannelFacade({
        instances: instances.service,
        meta: metaOnboardingService,
        chatwoot: integrationRuntime.chatwoot,
        transact: (organizationId, operation) =>
          withOrganizationTransaction(pools.appPool, organizationId, operation),
      }),
    };
    integrations = {
      jwtSecret: config.jwtSecret,
      authenticateApiKey: apiKeys.authenticateApiKey,
      resolveCurrentRole: createMessagingMembershipResolver(pools.authPool),
      service: integrationRuntime.chatwoot,
      qr: integrationRuntime.qr,
    };
    chatwootControl = {
      jwtSecret: config.jwtSecret, authenticateApiKey: apiKeys.authenticateApiKey,
      service: controlAuth, onboarding: integrationRuntime.onboarding, facade: integrationRuntime.controlService,
    };
    chatwootEmbed = {
      nodeEnv, jwtSecret: config.jwtSecret, authenticateApiKey: apiKeys.authenticateApiKey,
      browserCsrfSecret: config.browserCsrfSecret, browserCookieSecure: config.consoleCookieSecure,
      consoleAllowedOrigins: config.consoleAllowedOrigins, trustedProxyCidrs: config.trustedProxyCidrs,
      facade: integrationRuntime.controlService,
      service: createEmbedService({ enabled: z.enum(['true', 'false']).default('false').parse(messagingEnvironment.CHATWOOT_EMBED_ENABLED) === 'true',
        pool: pools.appPool, transact: (org, work) => withOrganizationTransaction(pools.appPool, org, work), control: controlAuth,
        publicOrigin: messagingEnvironment.PUBLIC_ORIGIN, dashboardClient: integrationRuntime.dashboardClient,
        managedOrigin: messagingEnvironment.CHATWOOT_BASE_URL ? new URL(messagingEnvironment.CHATWOOT_BASE_URL).origin : undefined,
        rateLimitStore, rateLimitSecret: config.ipRateLimitHmacSecret, sessionSigningSecret: config.jwtSecret }),
    };
    metaOnboarding = {
      service: metaOnboardingService,
      jwtSecret: config.jwtSecret,
      authenticateApiKey: apiKeys.authenticateApiKey,
      resolveCurrentRole: createMessagingMembershipResolver(pools.authPool),
    };
    tenantOperations = {
      jwtSecret: config.jwtSecret,
      authenticateApiKey: apiKeys.authenticateApiKey,
      transact: (organizationId, operation) =>
        withOrganizationTransaction(pools.appPool, organizationId, operation),
    };
    if (
      messagingEnvironment.PLATFORM_DATABASE_URL ||
      messagingEnvironment.PLATFORM_MFA_KEY ||
      messagingEnvironment.PLATFORM_ORIGIN
    ) {
      if (
        !messagingEnvironment.PLATFORM_DATABASE_URL ||
        !messagingEnvironment.PLATFORM_MFA_KEY ||
        !messagingEnvironment.PLATFORM_ORIGIN ||
        new URL(messagingEnvironment.PLATFORM_DATABASE_URL).username !==
          "jrc_platform" ||
        !config.consoleAllowedOrigins.includes(
          messagingEnvironment.PLATFORM_ORIGIN,
        )
      )
        throw new Error("INVALID_PLATFORM_CONFIGURATION");
      const platformPool = new Pool({
        connectionString: messagingEnvironment.PLATFORM_DATABASE_URL,
        max: 4,
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000,
      });
      platform = {
        service: new PlatformService(
          platformPool,
          Buffer.from(messagingEnvironment.PLATFORM_MFA_KEY, "base64"),
          {
            mode: messagingEnvironment.PLATFORM_LOGIN_MODE ?? "",
            localPasswordOnly:
              messagingEnvironment.PLATFORM_LOCAL_PASSWORD_ONLY ?? "false",
            nodeEnv: config.nodeEnv,
            origin: messagingEnvironment.PLATFORM_ORIGIN,
          },
        ),
        origin: messagingEnvironment.PLATFORM_ORIGIN,
        secureCookies: config.consoleCookieSecure,
        chatwoot: integrationRuntime.chatwoot,
        provisioner: integrationRuntime.provisioner,
      };
      app.addHook("onClose", async () => platformPool.end());
    }
    flows = {
      jwtSecret: config.jwtSecret,
      authenticateApiKey: apiKeys.authenticateApiKey,
      resolveCurrentRole: createMessagingMembershipResolver(pools.authPool),
      service: createFlowService({transact:(org,work)=>withOrganizationTransaction(pools.appPool,org,work)}),
      ...(integrationRuntime.flowChatwoot ? { chatwoot: integrationRuntime.flowChatwoot } : {}),
    };
    const automationRepository=createPostgresAutomationRepository();
    const automationOptions={transact:<T>(org:string,work:Parameters<typeof withOrganizationTransaction<T>>[2])=>withOrganizationTransaction(pools.appPool,org,work),repository:automationRepository,enabled:config.automationRuntimeV2Enabled};
    automations={
      jwtSecret:config.jwtSecret,
      authenticateApiKey:apiKeys.authenticateApiKey,
      resolveCurrentRole:createMessagingMembershipResolver(pools.authPool),
      service:createAutomationService(automationOptions),
      executions:createExecutionService(automationOptions),
      migration:createLegacyFlowMigrationService(automationOptions),
    };
    observability={jwtSecret:config.jwtSecret,authenticateApiKey:apiKeys.authenticateApiKey,resolveCurrentRole:createMessagingMembershipResolver(pools.authPool),service:createObservabilityService({transact:automationOptions.transact,probeRedis:async()=>redisClient.isReady&&(await redisClient.ping())==='PONG',schemaCurrent:async()=>Boolean((await pools.appPool.query("select to_regclass('public.operational_heartbeats') is not null as ready")).rows[0]?.ready)})};
    const vaultKeys=messagingEnvironment.CREDENTIAL_VAULT_KEYS_JSON??(messagingEnvironment.INTEGRATION_ENCRYPTION_KEY?JSON.stringify({1:messagingEnvironment.INTEGRATION_ENCRYPTION_KEY}):undefined);
    if(config.automationRuntimeV2Enabled&&!vaultKeys)throw new Error('CREDENTIAL_VAULT_KEYS_REQUIRED');
    if(vaultKeys){const credentialService=createCredentialService({transact:automationOptions.transact,vault:createCredentialVault(vaultKeys),tester:createCredentialTester()}),membership=createMessagingMembershipResolver(pools.authPool),authentication={jwtSecret:config.jwtSecret,authenticateApiKey:apiKeys.authenticateApiKey,resolveCurrentRole:membership};
      credentials={...authentication,service:credentialService};
      automationWebhooks={...authentication,service:createWebhookService({pool:pools.appPool,transact:automationOptions.transact,credentials:credentialService,router:createEventRouter(automationOptions)})};
      automationImports={...authentication,service:createAutomationImporter({transact:automationOptions.transact,keyring:vaultKeys})};
    }
    messaging = {
      resolveCurrentRole: createMessagingMembershipResolver(pools.authPool),
      jwtSecret: config.jwtSecret,
      authenticateApiKey: apiKeys.authenticateApiKey,
      service: createMessagingService({
        ...(integrationRuntime.media
          ? { media: integrationRuntime.media }
          : {}),
        repository: createPostgresMessagingRepository(),
        runInOrganizationTransaction: (organizationId, operation) =>
          withOrganizationTransaction(pools.appPool, organizationId, operation),
        resolveMetaClient: createMetaClientResolver(
          messagingEnvironment,
          metaOnboardingService.resolveCredential,
        ),
        resolveTypebotClient: createTypebotClientResolver(
          options.environment ?? process.env,
        ),
      }),
    };
    if (
      messagingEnvironment.META_APP_SECRET ||
      messagingEnvironment.META_WEBHOOK_VERIFY_TOKEN
    ) {
      if (
        !messagingEnvironment.META_APP_SECRET ||
        !messagingEnvironment.META_WEBHOOK_VERIFY_TOKEN
      )
        throw new Error("INCOMPLETE_META_WEBHOOK_CONFIGURATION");
      metaWebhooks = {
        appSecret: messagingEnvironment.META_APP_SECRET,
        verifyToken: messagingEnvironment.META_WEBHOOK_VERIFY_TOKEN,
        ingest: createMetaOnboardingWebhook({
          accountUpdated: metaOnboardingService.accountUpdated,
          async findWaba(wabaId) {
            const rows = await pools.appPool.query<{
              organization_id: string;
              id: string;
            }>("SELECT * FROM resolve_meta_waba($1)", [wabaId]);
            return rows.rows.map((row) => ({
              organizationId: row.organization_id,
              id: row.id,
            }));
          },
          ingestMessages: createMetaIngestor({
            repository: createPostgresMessagingRepository(),
            bindings: loadMetaAssetBindings(
              messagingEnvironment.META_ASSET_BINDINGS_JSON ?? "{}",
            ),
            async resolveBinding(phoneNumberId, wabaId) {
              const result = await pools.appPool.query<{
                organization_id: string;
                channel_id: string;
              }>("SELECT * FROM resolve_meta_asset($1,$2)", [
                phoneNumberId,
                wabaId,
              ]);
              const row = result.rows[0];
              return row
                ? {
                    organizationId: row.organization_id,
                    channelId: row.channel_id,
                  }
                : undefined;
            },
            transact: (organizationId, operation) =>
              withOrganizationTransaction(
                pools.appPool,
                organizationId,
                operation,
              ),
          }),
        }),
      };
    }
    app.addHook("onReady", async () => {
      await redisClient.connect();
      const [appRole, authRole] = await Promise.all([
        pools.appPool.query<{ currentUser: string }>(
          'SELECT current_user AS "currentUser"',
        ),
        pools.authPool.query<{ currentUser: string }>(
          'SELECT current_user AS "currentUser"',
        ),
      ]);
      if (
        appRole.rows[0]?.currentUser !== "jrc_app" ||
        authRole.rows[0]?.currentUser !== "jrc_auth"
      ) {
        throw new Error("Database runtime role verification failed");
      }
    });
    readinessCheck = async () => {
      if (!redisClient.isReady) throw new Error("DEPENDENCY_UNAVAILABLE");
      const [result] = await Promise.all([
        pools.appPool.query(
          "SELECT to_regclass('public.messaging_media') IS NOT NULL AS ready",
        ),
        redisClient.ping(),
      ]);
      if (!result.rows[0]?.ready) throw new Error("MIGRATIONS_REQUIRED");
    };
    app.addHook("onClose", async () => {
      if (redisClient.isOpen) await redisClient.quit();
      await pools.close();
    });
  }

  app.decorate("passwordVerifier", null);
  app.addHook("onReady", async () => {
    app.passwordVerifier = await passwordVerifierInitializer();
  });

  app.addHook("onRequest", async (request) => {
    request.log.info({ req: request }, "request received");
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header(
      "Content-Security-Policy",
      resolveContentSecurityPolicy(
        request.url,
        runtimeConfig?.swaggerUiEnabled === true,
      ),
    );
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
  });
  app.addHook("onResponse", async (request, reply) => {
    const identity=request.authentication;
    request.log.info({ res: reply, correlationId: request.id, ...(identity?.organizationId?{organizationId:identity.organizationId}:{}) }, "request completed");
  });
  app.addHook("onError", async (request, reply, error) => {
    const identity=request.authentication;
    request.log.error({ err: error, res: reply, correlationId: request.id, ...(identity?.organizationId?{organizationId:identity.organizationId}:{}) }, "request failed");
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      reply.statusCode < 400
      || typeof payload !== "string"
      || !String(reply.getHeader("content-type") ?? "").toLowerCase().includes("json")
    ) {
      return payload;
    }
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return payload;
      reply.removeHeader("content-length");
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        requestId: request.id,
        correlationId: request.id,
      });
    } catch {
      return payload;
    }
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  void app.register(swagger, {
    openapi: {
      info: {
        title: "JRC WhatsApp Broker API",
        version: "0.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          embedSessionAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Sessão assinada de 5 minutos: tenant, destino, conta, inboxes, usuário externo, escopos, audiência e nonce; limitada a estado e pareamento.' },
          csrfHeaderAuth: {
            type: "apiKey",
            in: "header",
            name: "X-CSRF-Token",
            description:
              "Nonce assinado que deve coincidir com o cookie __Host-jrc_csrf.",
          },
          jrcApiKeyAuth: {
            type: "apiKey",
            in: "header",
            name: "X-JRC-API-Key",
          },
          refreshCookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "__Host-jrc_refresh",
            description:
              "Cookie de produção HttpOnly, Secure, SameSite=Strict, Path=/; nunca integra o JSON.",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  if (runtimeConfig?.swaggerUiEnabled === true) {
    void app.register(swaggerUi, {
      routePrefix: "/documentation",
      uiConfig: { deepLinking: false },
    });
  }

  if (auth) {
    const configuredAuth = auth;
    void app.register(async (scope) =>
      registerAuthRoutes(scope, {
        ...configuredAuth,
        nodeEnv,
        getPasswordVerifier() {
          if (!app.passwordVerifier) {
            throw new Error("Password verifier is not initialized");
          }
          return app.passwordVerifier;
        },
      }),
    );
  }

  if (apiKeys) {
    const configuredApiKeys = apiKeys;
    void app.register(async (scope) =>
      registerApiKeyRoutes(scope, configuredApiKeys),
    );
  }

  if (consoleAuth) {
    const configuredConsoleAuth = consoleAuth;
    void app.register(async (scope) =>
      registerConsoleAuthRoutes(scope, {
        ...configuredConsoleAuth,
        nodeEnv,
      }),
    );
  }

  if (providerAccounts) {
    const configuredProviderAccounts = providerAccounts;
    void app.register(async (scope) =>
      registerProviderAccountRoutes(scope, configuredProviderAccounts),
    );
  }

  if (instances) {
    const configuredInstances = instances;
    void app.register(async (scope) =>
      registerInstanceRoutes(scope, configuredInstances),
    );
  }

  if (channels) {
    const configuredChannels = channels;
    void app.register(async (scope) =>
      registerChannelRoutes(scope, configuredChannels),
    );
  }

  if (instanceWorkspace) {
    const configured = instanceWorkspace;
    void app.register(async (scope) =>
      registerInstanceWorkspaceRoutes(scope, configured),
    );
  }
  if (flows) {
    const configuredFlows=flows;
    app.register(scope=>registerFlowRoutes(scope,configuredFlows));
  }
  if (automations) {
    const configured=automations;
    app.register(scope=>registerAutomationRoutes(scope,configured));
  }
  if (observability) {
    const configured=observability;
    app.register(scope=>registerObservabilityRoutes(scope,configured));
  }
  if (credentials) {
    const configured=credentials;
    app.register(scope=>registerCredentialRoutes(scope,configured));
  }
  if (automationWebhooks) {
    const configured=automationWebhooks;
    app.register(scope=>registerAutomationWebhookRoutes(scope,configured));
  }
  if (automationImports) {
    const configured=automationImports;
    app.register(scope=>registerAutomationImportRoutes(scope,configured));
  }
  if (messaging) {
    const configuredMessaging = messaging;
    void app.register(async (scope) =>
      registerMessagingRoutes(scope, configuredMessaging),
    );
  }
  if (metaWebhooks) {
    const configuredWebhooks = metaWebhooks;
    void app.register(async (scope) =>
      registerMetaWebhookRoutes(scope, configuredWebhooks),
    );
  }
  if (platform) {
    const configured = platform;
    void app.register(async (scope) =>
      registerPlatformRoutes(scope, configured),
    );
  }
  if (metaOnboarding) {
    const configured = metaOnboarding;
    void app.register(async (scope) =>
      registerMetaOnboardingRoutes(scope, configured),
    );
  }
  if (tenantOperations) {
    const configured = tenantOperations;
    void app.register(async (scope) =>
      registerTenantOperationsRoutes(scope, configured),
    );
  }
  if (integrations) {
    const configured = integrations;
    void app.register(async (scope) =>
      registerIntegrationRoutes(scope, configured),
    );
  }
  if (chatwootControl) {
    const configured = chatwootControl;
    void app.register(scope => registerChatwootControlRoutes(scope, configured));
  }
  if (chatwootEmbed) {
    const configured = chatwootEmbed;
    void app.register(scope => registerChatwootEmbedRoutes(scope, configured));
  }

  app.get("/health", { schema: { hide: true } }, async () => ({
    status: "ok" as const,
  }));
  app.get("/ready", { schema: { hide: true } }, async (_request, reply) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        readinessCheck?.() ?? Promise.resolve(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("TIMEOUT")), 3000);
          timer.unref();
        }),
      ]);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  return app;
}
