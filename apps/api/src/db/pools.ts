import { Pool, type PoolConfig } from 'pg';
import { loadDatabasePoolBudget } from './pool-budget.js';

export interface DatabasePoolsConfig {
  app: Readonly<PoolConfig>;
  auth: Readonly<PoolConfig>;
}

export interface DatabasePools {
  appPool: Pool;
  authPool: Pool;
  close(): Promise<void>;
}

export function createDatabasePools(config: DatabasePoolsConfig): DatabasePools {
  const appPool = new Pool({ ...loadDatabasePoolBudget({}, 'API_APP'), ...config.app });
  const authPool = new Pool({ ...loadDatabasePoolBudget({}, 'API_AUTH'), ...config.auth });
  let closing: Promise<void> | undefined;

  return {
    appPool,
    authPool,
    close() {
      closing ??= Promise.all([
        appPool.end(),
        authPool.end(),
      ]).then(() => undefined);
      return closing;
    },
  };
}
