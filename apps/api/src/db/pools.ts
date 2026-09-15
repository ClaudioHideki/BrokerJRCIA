import { Pool, type PoolConfig } from 'pg';

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
  const appPool = new Pool({ ...config.app });
  const authPool = new Pool({ ...config.auth });
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
