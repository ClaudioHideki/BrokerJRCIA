import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createIntegrationRuntime } from "../modules/integrations/runtime.js";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { z } from "zod";
import { withOrganizationTransaction } from "../db/tenant-transaction.js";
import { createPostgresMessagingRepository } from "../modules/messaging/repository.js";
import {
  createMetaClientResolver,
  createTypebotClientResolver,
} from "../modules/messaging/credentials.js";
import { createMessagingWorker } from "../modules/messaging/worker.js";
import { createMetaOnboardingService } from "../modules/meta-onboarding/service.js";
import { writeFile } from "node:fs/promises";

export function loadWorkerConfig(environment: NodeJS.ProcessEnv) {
  const databaseUrl = z.string().url().parse(environment.DATABASE_URL);
  if (new URL(databaseUrl).username !== "jrc_app")
    throw new Error("WORKER_REQUIRES_APP_ROLE");
  const mode = z
    .enum(["allowlist", "automatic"])
    .parse(environment.MESSAGING_WORKER_MODE || "allowlist");
  const shards = z.coerce
    .number()
    .int()
    .min(1)
    .max(128)
    .parse(environment.MESSAGING_WORKER_SHARDS || 1);
  const shard = z.coerce
    .number()
    .int()
    .min(0)
    .max(shards - 1)
    .parse(environment.MESSAGING_WORKER_SHARD || 0);
  const organizations =
    mode === "automatic"
      ? []
      : z
          .array(z.string().uuid())
          .min(1)
          .max(1000)
          .parse(
            (environment.MESSAGING_WORKER_ORGANIZATIONS ?? "")
              .split(",")
              .map((value) => value.trim()),
          );
  return {
    databaseUrl,
    mode,
    shard,
    shards,
    organizations: [...new Set(organizations)],
  };
}

export function belongsToWorkerShard(
  org: string,
  shard: number,
  shards: number,
): boolean {
  return (
    createHash("sha256").update(org).digest().readUInt32BE(0) % shards === shard
  );
}
/** The discovery function returns only bounded organization IDs; all work still uses tenant RLS. */
export async function runMessagingWorker(
  environment: NodeJS.ProcessEnv = process.env,
  watch = false,
): Promise<void> {
  const config = loadWorkerConfig(environment);
  const resolveTypebotClient = createTypebotClientResolver(environment);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });
  const metaOnboarding = createMetaOnboardingService({
    environment,
    transact: (organizationId, operation) =>
      withOrganizationTransaction(pool, organizationId, operation),
  });
  const resolveMetaClient = createMetaClientResolver(
    environment,
    metaOnboarding.resolveCredential,
  );
  const integrations = createIntegrationRuntime(
    environment,
    pool,
    resolveMetaClient,
  );
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const worker = createMessagingWorker({
      repository: createPostgresMessagingRepository(),
      transact: (organizationId, operation) =>
        withOrganizationTransaction(pool, organizationId, operation),
      resolveMetaClient,
      resolveTypebotClient,
      prepareMedia: integrations.prepareMedia,
      ...(integrations.qr
        ? { resolveQrClient: integrations.qr.resolveClient }
        : {}),
    });
    do {
      if (environment.WORKER_HEARTBEAT_FILE)
        await writeFile(environment.WORKER_HEARTBEAT_FILE, String(Date.now()), {
          mode: 0o600,
        });
      let cursor: string | null = null;
      let more = true;
      while (more && !shutdown.signal.aborted) {
        const organizations: string[] =
          config.mode === "automatic"
            ? (
                await pool.query<{ organization_id: string }>(
                  "SELECT * FROM messaging_worker_organizations($1,$2)",
                  [cursor, 100],
                )
              ).rows.map((row) => row.organization_id)
            : config.organizations;
        more = config.mode === "automatic" && organizations.length === 100;
        cursor = organizations.at(-1) ?? cursor;
        for (const organizationId of organizations) {
          if (shutdown.signal.aborted) break;
          if (
            !belongsToWorkerShard(organizationId, config.shard, config.shards)
          )
            continue;
          try {
            await integrations.media?.runOnce(organizationId);
            await worker.runOnce(organizationId);
            await integrations.chatwootWorker?.runOnce(organizationId);
            if (environment.WORKER_HEARTBEAT_FILE)
              await writeFile(
                environment.WORKER_HEARTBEAT_FILE,
                String(Date.now()),
                { mode: 0o600 },
              );
          } catch {
            if (!watch) throw new Error("MESSAGING_WORKER_TICK_FAILED");
            process.stderr.write("MESSAGING_WORKER_TICK_FAILED\n");
          }
        }
      }
      if (watch && !shutdown.signal.aborted) {
        await setTimeout(1000, undefined, { signal: shutdown.signal }).catch(
          () => undefined,
        );
      }
    } while (watch && !shutdown.signal.aborted);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.end();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runMessagingWorker(process.env, process.argv.includes("--watch")).catch(
    () => {
      process.stderr.write("MESSAGING_WORKER_FAILED\n");
      process.exitCode = 1;
    },
  );
}
