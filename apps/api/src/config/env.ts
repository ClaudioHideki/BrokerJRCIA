import { z } from 'zod';

const SecretSchema = z.string().min(32);
const BrowserCsrfSecretSchema = z.string().refine(
  (value) => Buffer.byteLength(value, 'utf8') >= 32,
  'Browser CSRF secret must contain at least 32 bytes',
);

const INSECURE_EXAMPLE_SECRETS = new Set([
  'dev-only-evolution-platform-key-change-000001',
  'dev-only-jwt-secret-change-me-0000000001',
  'dev-only-refresh-hash-change-me-0000002',
  'dev-only-api-key-hmac-change-me-0000003',
  'dev-only-ip-rate-hmac-change-me-000004',
  'dev-only-identity-rate-change-me-00005',
  'dev-only-challenge-key-change-me-000006',
  'dev-only-browser-csrf-change-me-00000007',
]);

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().url(),
  AUTH_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1_000).default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1).max(86_400_000).default(60_000),
  AUTH_PROGRESSIVE_DELAY_BASE_MS: z.coerce.number().int().min(0).max(10_000).default(100),
  AUTH_PROGRESSIVE_DELAY_MAX_MS: z.coerce.number().int().min(0).max(10_000).default(2_000),
  AUTH_RATE_LIMIT_REDIS_DEADLINE_MS: z.coerce.number().int().min(1).max(10_000).default(500),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(1_000),
  REDIS_RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(2),
  REDIS_RECONNECT_DELAY_MS: z.coerce.number().int().min(0).max(5_000).default(100),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  SWAGGER_UI_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SWAGGER_UI_INTERNAL_BIND: z.enum(['127.0.0.1', '::1']).optional(),
  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_API_KEY: SecretSchema,
  JWT_SECRET: SecretSchema,
  REFRESH_TOKEN_HASH_SECRET: SecretSchema,
  API_KEY_HMAC_SECRET: SecretSchema,
  IP_RATE_LIMIT_HMAC_SECRET: SecretSchema,
  IDENTITY_RATE_LIMIT_HMAC_SECRET: SecretSchema,
  CHALLENGE_ENCRYPTION_KEY: SecretSchema,
  BROWSER_CSRF_SECRET: BrowserCsrfSecretSchema,
  CONSOLE_ALLOWED_ORIGINS: z.string().min(1),
  CONSOLE_COOKIE_SECURE: z.enum(['true', 'false'])
    .optional()
    .transform((value) => value === undefined ? undefined : value === 'true'),
}).superRefine((environment, context) => {
  if (environment.AUTH_PROGRESSIVE_DELAY_MAX_MS < environment.AUTH_PROGRESSIVE_DELAY_BASE_MS) {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_PROGRESSIVE_DELAY_MAX_MS'],
      message: 'Progressive delay maximum must be greater than or equal to its base',
    });
  }
  if (
    environment.NODE_ENV === 'production'
    && environment.SWAGGER_UI_ENABLED
    && environment.SWAGGER_UI_INTERNAL_BIND === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['SWAGGER_UI_INTERNAL_BIND'],
      message: 'Swagger UI in production requires an explicit internal bind',
    });
  }
  if (new URL(environment.DATABASE_URL).username !== 'jrc_app') {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL must authenticate as jrc_app',
    });
  }
  if (new URL(environment.AUTH_DATABASE_URL).username !== 'jrc_auth') {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_DATABASE_URL'],
      message: 'AUTH_DATABASE_URL must authenticate as jrc_auth',
    });
  }
  if (environment.NODE_ENV === 'production' && environment.CONSOLE_COOKIE_SECURE === false) {
    context.addIssue({
      code: 'custom',
      path: ['CONSOLE_COOKIE_SECURE'],
      message: 'Console cookies must be Secure in production',
    });
  }
  const origins = environment.CONSOLE_ALLOWED_ORIGINS
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (origins.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['CONSOLE_ALLOWED_ORIGINS'],
      message: 'At least one console origin is required',
    });
  }
  for (const origin of origins) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['CONSOLE_ALLOWED_ORIGINS'],
        message: 'Console origins must be valid absolute origins',
      });
      continue;
    }
    if (
      origin.includes('*')
      || !['http:', 'https:'].includes(parsedOrigin.protocol)
      || parsedOrigin.origin !== origin
      || parsedOrigin.username !== ''
      || parsedOrigin.password !== ''
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CONSOLE_ALLOWED_ORIGINS'],
        message: 'Console origins must contain only an exact HTTP(S) origin',
      });
    }
    if (parsedOrigin.protocol === 'http:') {
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname);
      if (environment.NODE_ENV === 'production' || !isLocal) {
        context.addIssue({
          code: 'custom',
          path: ['CONSOLE_ALLOWED_ORIGINS'],
          message: 'HTTP console origins are allowed only for local development and tests',
        });
      }
    }
  }
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  authDatabaseUrl: string;
  redisUrl: string;
  authRateLimit: { limit: number; ttlMs: number };
  authProgressiveDelay: { baseDelayMs: number; maximumDelayMs: number };
  redisFailurePolicy: {
    commandDeadlineMs: number;
    connectTimeoutMs: number;
    reconnectMaxAttempts: number;
    reconnectDelayMs: number;
  };
  trustedProxyCidrs: string[];
  swaggerUiEnabled: boolean;
  swaggerUiInternalBind: string | null;
  evolutionBaseUrl: string;
  evolutionApiKey: string;
  jwtSecret: string;
  refreshTokenHashSecret: string;
  apiKeyHmacSecret: string;
  ipRateLimitHmacSecret: string;
  identityRateLimitHmacSecret: string;
  challengeEncryptionKey: string;
  browserCsrfSecret: string;
  consoleAllowedOrigins: string[];
  consoleCookieSecure: boolean;
}

export function loadAppConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const secretValues = [
    parsed.EVOLUTION_API_KEY,
    parsed.JWT_SECRET,
    parsed.REFRESH_TOKEN_HASH_SECRET,
    parsed.API_KEY_HMAC_SECRET,
    parsed.IP_RATE_LIMIT_HMAC_SECRET,
    parsed.IDENTITY_RATE_LIMIT_HMAC_SECRET,
    parsed.CHALLENGE_ENCRYPTION_KEY,
    parsed.BROWSER_CSRF_SECRET,
  ];

  if (secretValues.some((secret) => INSECURE_EXAMPLE_SECRETS.has(secret))) {
    throw new Error('Insecure example secret is not allowed');
  }

  if (new Set(secretValues).size !== secretValues.length) {
    throw new Error('Security secrets must be distinct');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    authDatabaseUrl: parsed.AUTH_DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    authRateLimit: {
      limit: parsed.AUTH_RATE_LIMIT_MAX_ATTEMPTS,
      ttlMs: parsed.AUTH_RATE_LIMIT_WINDOW_MS,
    },
    authProgressiveDelay: {
      baseDelayMs: parsed.AUTH_PROGRESSIVE_DELAY_BASE_MS,
      maximumDelayMs: parsed.AUTH_PROGRESSIVE_DELAY_MAX_MS,
    },
    redisFailurePolicy: {
      commandDeadlineMs: parsed.AUTH_RATE_LIMIT_REDIS_DEADLINE_MS,
      connectTimeoutMs: parsed.REDIS_CONNECT_TIMEOUT_MS,
      reconnectMaxAttempts: parsed.REDIS_RECONNECT_MAX_ATTEMPTS,
      reconnectDelayMs: parsed.REDIS_RECONNECT_DELAY_MS,
    },
    trustedProxyCidrs: parsed.TRUSTED_PROXY_CIDRS
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    swaggerUiEnabled: parsed.SWAGGER_UI_ENABLED,
    swaggerUiInternalBind: parsed.SWAGGER_UI_INTERNAL_BIND ?? null,
    evolutionBaseUrl: parsed.EVOLUTION_BASE_URL,
    evolutionApiKey: parsed.EVOLUTION_API_KEY,
    jwtSecret: parsed.JWT_SECRET,
    refreshTokenHashSecret: parsed.REFRESH_TOKEN_HASH_SECRET,
    apiKeyHmacSecret: parsed.API_KEY_HMAC_SECRET,
    ipRateLimitHmacSecret: parsed.IP_RATE_LIMIT_HMAC_SECRET,
    identityRateLimitHmacSecret: parsed.IDENTITY_RATE_LIMIT_HMAC_SECRET,
    challengeEncryptionKey: parsed.CHALLENGE_ENCRYPTION_KEY,
    browserCsrfSecret: parsed.BROWSER_CSRF_SECRET,
    consoleAllowedOrigins: parsed.CONSOLE_ALLOWED_ORIGINS
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    consoleCookieSecure: parsed.CONSOLE_COOKIE_SECURE ?? parsed.NODE_ENV === 'production',
  };
}
