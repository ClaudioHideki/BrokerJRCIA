import { pathToFileURL } from 'node:url';

import { buildApp } from './app.js';
import { loadAppConfig, type AppConfig } from './config/env.js';

export function resolveListenHost(config: AppConfig): string {
  return config.swaggerUiEnabled ? config.swaggerUiInternalBind! : '0.0.0.0';
}

export async function startServer(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<ReturnType<typeof buildApp>> {
  const config = loadAppConfig(environment);
  const app = buildApp({ nodeEnv: config.nodeEnv, environment });

  const shutdown = async () => {
    await app.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  app.addHook('onClose', async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  });

  try {
    await app.listen({ host: resolveListenHost(config), port: config.port });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    await startServer();
  } catch {
    process.stderr.write('JRC API failed to start\n');
    process.exitCode = 1;
  }
}
