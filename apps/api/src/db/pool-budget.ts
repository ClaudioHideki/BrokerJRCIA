import { z } from 'zod';

export type DatabasePoolProfile = 'API_APP' | 'API_AUTH' | 'API_PLATFORM' | 'MESSAGING_WORKER' | 'MESSAGING_AUTH' |
  'AUTOMATION_WORKER' | 'AUTOMATION_IO_WORKER' | 'SCHEDULER_WORKER' | 'LIFECYCLE_WORKER';

export interface DatabasePoolBudget {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
}

const defaults: Record<DatabasePoolProfile, DatabasePoolBudget> = {
  API_APP: { max: 10, connectionTimeoutMillis: 0, idleTimeoutMillis: 10000 },
  API_AUTH: { max: 10, connectionTimeoutMillis: 0, idleTimeoutMillis: 10000 },
  API_PLATFORM: { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
  MESSAGING_WORKER: { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
  MESSAGING_AUTH: { max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
  AUTOMATION_WORKER: { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
  AUTOMATION_IO_WORKER: { max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
  SCHEDULER_WORKER: { max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
  LIFECYCLE_WORKER: { max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 },
};

/** Per-process input bounds are validation guards, not a server capacity budget. */
export function loadDatabasePoolBudget(
  environment: Record<string, string | undefined>, profile: DatabasePoolProfile,
): DatabasePoolBudget {
  const current = defaults[profile];
  const read = (suffix: string, fallback: number, minimum: number, maximum: number): number => {
    const name = `${profile}_DB_POOL_${suffix}`;
    const value = environment[name];
    if (value === undefined) return fallback;
    const result = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(minimum).max(maximum)).safeParse(value);
    if (!result.success) throw new Error(`INVALID_DATABASE_POOL_CONFIGURATION: ${name} must be an integer from ${minimum} to ${maximum}`);
    return result.data;
  };
  return {
    max: read('MAX', current.max, 1, 100),
    connectionTimeoutMillis: read('CONNECT_TIMEOUT_MS', current.connectionTimeoutMillis, 0, 120000),
    idleTimeoutMillis: read('IDLE_TIMEOUT_MS', current.idleTimeoutMillis, 0, 3600000),
  };
}
