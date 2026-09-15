import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { z } from 'zod';
import type { OrganizationTransaction } from '../db/tenant-transaction.js';
import { withOrganizationTransaction } from '../db/tenant-transaction.js';
import {
  createPostgresMessagingRepository,
  type MessagingRepository,
} from '../modules/messaging/repository.js';
import type { MessagingChannel } from '../modules/messaging/types.js';

const channelConfigurationSchema = z.strictObject({
  organizationId: z.uuid(),
  providerAccountId: z.uuid(),
  phoneNumberId: z.string().regex(/^[1-9]\d{4,63}$/),
  wabaId: z.string().regex(/^[1-9]\d{4,63}$/),
  credentialReference: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export type MessagingChannelCreateConfiguration = z.infer<typeof channelConfigurationSchema>;

export function loadMessagingChannelCreateConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { databaseUrl: string; channel: MessagingChannelCreateConfiguration } {
  const databaseUrl = z.string().url().parse(environment.DATABASE_URL);
  if (new URL(databaseUrl).username !== 'jrc_app') {
    throw new Error('CHANNEL_CREATE_REQUIRES_APP_ROLE');
  }
  try {
    const serialized = environment.MESSAGING_CHANNEL_JSON ?? '';
    if (Buffer.byteLength(serialized) > 1_048_576) throw new Error();
    return { databaseUrl, channel: channelConfigurationSchema.parse(JSON.parse(serialized)) };
  } catch {
    throw new Error('INVALID_MESSAGING_CHANNEL_CONFIGURATION');
  }
}

export interface MessagingChannelCreateDependencies {
  repository: Pick<MessagingRepository, 'createChannel'>;
  transact<T>(organizationId: string, operation: OrganizationTransaction<T>): Promise<T>;
  createId?: () => string;
}

/**
 * Registers server-preprovisioned Meta asset identifiers against an existing tenant-owned
 * META provider account. This performs no provider HTTP call and does not claim the assets
 * were verified by Meta.
 */
export function createMessagingChannelFromConfig(
  configuration: MessagingChannelCreateConfiguration,
  dependencies: MessagingChannelCreateDependencies,
): Promise<MessagingChannel> {
  return dependencies.transact(configuration.organizationId, transaction => (
    dependencies.repository.createChannel(transaction, {
      id: (dependencies.createId ?? randomUUID)(),
      ...configuration,
      botPublicId: null,
      botOriginReference: null,
    })
  ));
}

export async function runMessagingChannelCreate(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<MessagingChannel> {
  const { databaseUrl, channel } = loadMessagingChannelCreateConfig(environment);
  const pool = new Pool({ connectionString: databaseUrl, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
  try {
    return await createMessagingChannelFromConfig(channel, {
      repository: createPostgresMessagingRepository(),
      transact: (organizationId, operation) => withOrganizationTransaction(pool, organizationId, operation),
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMessagingChannelCreate(process.env).then(channel => {
    process.stdout.write(`MESSAGING_CHANNEL_CREATED ${channel.id}\n`);
  }).catch(() => {
    process.stderr.write('MESSAGING_CHANNEL_CREATE_FAILED\n');
    process.exitCode = 1;
  });
}
