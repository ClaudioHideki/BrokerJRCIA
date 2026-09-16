import type { Pool } from "pg";
import { z } from "zod";
import { withOrganizationTransaction } from "../../db/tenant-transaction.js";
import {
  createQrMessagingService,
  type QrServiceOptions,
} from "../messaging/qr-service.js";
import {
  createChatwootService,
  chatwootEnvironment,
  type ChatwootOptions,
} from "./chatwoot-service.js";
import { createChatwootWorker } from "./chatwoot-worker.js";
import { createChatwootProvisioner } from "./chatwoot-provisioner.js";
import { createMediaStore, type MediaStore } from "../messaging/media-store.js";
import { createPostgresMessagingRepository } from "../messaging/repository.js";
import {
  readChatwootAccount,
  readChatwootConnection,
} from "./chatwoot-service.js";
import { MediaError, type MetaCloudClient } from "@jrc/providers";
import type { MessagingChannel, OutboxClaim } from "../messaging/types.js";

type QrConfig = Pick<
  QrServiceOptions,
  "baseUrl" | "apiKey" | "webhookOrigin" | "signingKey"
>;
type ChatwootConfig = Pick<
  ChatwootOptions,
  "baseUrl" | "publicOrigin" | "encryptionKey" | "platformToken" | "allowLocal" | "externalDestinationsEnabled"
>;
export function loadIntegrationConfig(environment: NodeJS.ProcessEnv): {
  qr?: QrConfig;
  chatwoot?: ChatwootConfig;
} {
  const config: { qr?: QrConfig; chatwoot?: ChatwootConfig } = {};
  if (environment.QR_WEBHOOK_SIGNING_KEY || environment.QR_WEBHOOK_ORIGIN) {
    const webhookOrigin = z
      .url()
      .parse(environment.QR_WEBHOOK_ORIGIN || environment.PUBLIC_ORIGIN);
    const origin = new URL(webhookOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== webhookOrigin
    )
      throw new Error("INVALID_QR_WEBHOOK_ORIGIN");
    config.qr = {
      baseUrl: z.url().parse(environment.EVOLUTION_BASE_URL),
      apiKey: z.string().min(32).parse(environment.EVOLUTION_API_KEY),
      webhookOrigin,
      signingKey: z.string().min(32).parse(environment.QR_WEBHOOK_SIGNING_KEY),
    };
  }
  const externalDestinationsEnabled = z.enum(['true', 'false']).default('false')
    .parse(environment.CHATWOOT_EXTERNAL_DESTINATIONS_ENABLED) === 'true';
  if (
    environment.CHATWOOT_BASE_URL ||
    environment.CHATWOOT_PLATFORM_TOKEN ||
    externalDestinationsEnabled ||
    (environment.INTEGRATION_ENCRYPTION_KEY && environment.PUBLIC_ORIGIN)
  ) {
    const chatwoot: ChatwootConfig = {
      ...(environment.CHATWOOT_BASE_URL ? { baseUrl: z.url().parse(environment.CHATWOOT_BASE_URL) } : {}),
      publicOrigin: z.url().parse(environment.PUBLIC_ORIGIN),
      encryptionKey: z
        .string()
        .min(1)
        .parse(environment.INTEGRATION_ENCRYPTION_KEY),
      allowLocal: environment.NODE_ENV !== "production",
      externalDestinationsEnabled,
      ...(environment.CHATWOOT_PLATFORM_TOKEN
        ? {
            platformToken: z
              .string()
              .min(8)
              .max(4096)
              .regex(/^[^\r\n]+$/)
              .parse(environment.CHATWOOT_PLATFORM_TOKEN),
          }
        : {}),
    };
    chatwootEnvironment({
      ...chatwoot,
      transact: async () => {
        throw new Error("CONFIGURATION_ONLY");
      },
      resolveIntegration: async () => undefined,
    });
    config.chatwoot = chatwoot;
  }
  return config;
}
export function createIntegrationRuntime(
  environment: NodeJS.ProcessEnv,
  pool: Pool,
  resolveMetaClient?: (channel: MessagingChannel) => Promise<MetaCloudClient>,
) {
  const config = loadIntegrationConfig(environment);
  const transact: ChatwootOptions["transact"] = (org, operation) =>
    withOrganizationTransaction(pool, org, operation);
  const qr = config.qr
    ? createQrMessagingService({
        ...config.qr,
        transact,
        async resolveChannel(id) {
          const row = (
            await pool.query<{ organization_id: string; instance_id: string }>(
              "SELECT * FROM resolve_qr_channel($1)",
              [id],
            )
          ).rows[0];
          return row
            ? {
                organizationId: row.organization_id,
                instanceId: row.instance_id,
              }
            : undefined;
        },
      })
    : undefined;
  const options: ChatwootOptions | undefined = config.chatwoot
    ? {
        ...config.chatwoot,
        transact,
        mediaOrigins: (environment.CHATWOOT_MEDIA_ORIGINS ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((value) => {
            const u = new URL(value);
            if (u.protocol !== "https:" || u.origin !== value)
              throw new Error("INVALID_CHATWOOT_MEDIA_ORIGIN");
            return value;
          }),
        ...(qr ? { activateQr: qr.activate } : {}),
        async resolveIntegration(id) {
          return (
            await pool.query<{ organization_id: string }>(
              "SELECT * FROM resolve_chatwoot_integration($1)",
              [id],
            )
          ).rows[0]?.organization_id;
        },
      }
    : undefined;
  const media: MediaStore | undefined = environment.INTEGRATION_ENCRYPTION_KEY
    ? createMediaStore({
        encryptionKey: environment.INTEGRATION_ENCRYPTION_KEY,
        maxStorageBytes: Number(
          environment.MEDIA_STORAGE_BYTES_PER_ORGANIZATION ?? 1073741824,
        ),
        transact,
        async download(asset) {
          const channel = await transact(asset.organization_id, (t) =>
            createPostgresMessagingRepository().findChannel(
              t,
              asset.organization_id,
              asset.channel_id,
            ),
          );
          if (!channel) throw new MediaError("MEDIA_CHANNEL_NOT_FOUND");
          if (asset.source === "QR") {
            if (!qr) throw new MediaError("MEDIA_NOT_CONFIGURED");
            return qr.downloadMedia(
              channel,
              String(asset.descriptor.messageId),
            );
          }
          if (asset.source === "META") {
            if (!resolveMetaClient)
              throw new MediaError("MEDIA_NOT_CONFIGURED");
            return (await resolveMetaClient(channel)).downloadMedia(
              String(asset.descriptor.mediaId),
            );
          }
          if (!options) throw new MediaError("MEDIA_NOT_CONFIGURED");
          const context = await transact(asset.organization_id, async (t) => ({
            account: await readChatwootAccount(t, asset.organization_id),
            connection: await readChatwootConnection(
              t,
              asset.organization_id,
              String(asset.descriptor.integrationId),
            ),
          }));
          if (
            !context.account ||
            context.connection?.channel_id !== channel.id ||
            !context.connection.inbox_id
          )
            throw new MediaError("CHATWOOT_BINDING_MISMATCH");
          return chatwootEnvironment(options)
            .client(context.account)
            .downloadAttachment(
              Number(context.account.account_id),
              Number(context.connection.inbox_id),
              Number(asset.descriptor.conversationId),
              Number(asset.descriptor.messageId),
              Number(asset.descriptor.attachmentId),
            );
        },
      })
    : undefined;
  if (options && media) options.media = media;
  async function prepareMedia(claim: OutboxClaim) {
    if (!media || claim.message.content.type !== "MEDIA")
      throw new MediaError("MEDIA_NOT_CONFIGURED");
    const content = claim.message.content;
    const file = {
      ...(await media.read(claim.message.organizationId, content.mediaId)),
      ...(content.caption ? { caption: content.caption } : {}),
    };
    if (claim.channel.provider === "BAILEYS") {
      if (!qr) throw new MediaError("MEDIA_NOT_CONFIGURED");
      const client = await qr.resolveClient(claim.channel);
      return () => client.sendMedia(claim.contact.externalId, file);
    }
    if (!resolveMetaClient) throw new MediaError("MEDIA_NOT_CONFIGURED");
    const client = await resolveMetaClient(claim.channel);
    const id = await client.uploadMedia(file);
    return () =>
      client.sendMedia(claim.contact.externalId, {
        id,
        kind: file.kind,
        fileName: content.fileName,
        ...(file.caption ? { caption: file.caption } : {}),
      });
  }
  return {
    qr,
    chatwoot: options ? createChatwootService(options) : undefined,
    chatwootWorker: options ? createChatwootWorker(options) : undefined,
    provisioner: options ? createChatwootProvisioner(options) : undefined,
    media,
    prepareMedia,
  };
}
