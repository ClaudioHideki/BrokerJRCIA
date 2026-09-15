import { z } from 'zod';

export type EvolutionSmokeEnvironment =
  | { enabled: false }
  | {
      enabled: true;
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
    };

const EnabledEnvironmentSchema = z.object({
  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_SMOKE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(120_000).default(90_000),
});

export function loadEvolutionSmokeEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): EvolutionSmokeEnvironment {
  if (environment.EVOLUTION_SMOKE_ENABLED !== 'true') return { enabled: false };

  const result = EnabledEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error('Incomplete or invalid Evolution smoke configuration');
  }
  const endpoint = new URL(result.data.EVOLUTION_BASE_URL);
  if (!new Set(['127.0.0.1', '::1', '[::1]', 'localhost']).has(endpoint.hostname)) {
    throw new Error('Evolution smoke endpoint must be local');
  }
  return {
    enabled: true,
    baseUrl: result.data.EVOLUTION_BASE_URL,
    apiKey: result.data.EVOLUTION_API_KEY,
    timeoutMs: result.data.EVOLUTION_SMOKE_TIMEOUT_MS,
  };
}
