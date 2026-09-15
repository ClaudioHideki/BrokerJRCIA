import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EvolutionMessagingClient } from "@jrc/providers";
import type {
  OrganizationTransaction,
  TenantTransaction,
} from "../../db/tenant-transaction.js";
import { createPostgresMessagingRepository } from "./repository.js";
import { normalizeQrEvent } from "./qr-events.js";
import type { MessagingChannel } from "./types.js";
import { requireActiveOrganization } from "../tenancy/operational-limits.js";
import { registerPendingMedia } from "./media-store.js";
import type { MessageContent } from "./types.js";

const error = (code: string, status = 422) =>
  Object.assign(new Error(code), { code, status });
export interface QrServiceOptions {
  baseUrl: string;
  apiKey: string;
  webhookOrigin: string;
  signingKey: string;
  transact<T>(org: string, operation: OrganizationTransaction<T>): Promise<T>;
  resolveChannel(
    id: string,
  ): Promise<{ organizationId: string; instanceId: string } | undefined>;
}
export async function ensureQrChannel(
  tx: TenantTransaction,
  org: string,
  instanceId: string,
): Promise<MessagingChannel> {
  await requireActiveOrganization(tx, org);
  const instance = (
    await tx.query<{ id: string; provider_account_id: string }>(
      `SELECT i.id,i.provider_account_id FROM instances i JOIN provider_accounts p
       ON p.organization_id=i.organization_id AND p.id=i.provider_account_id
     WHERE i.organization_id=$1 AND i.id=$2 AND p.provider='BAILEYS' AND i.status NOT IN ('PROVISIONING','PROVISIONING_FAILED') FOR UPDATE OF i`,
      [org, instanceId],
    )
  ).rows[0];
  if (!instance) throw error("QR_INSTANCE_NOT_FOUND", 404);
  await tx.query(
    `INSERT INTO messaging_channels(organization_id,provider_account_id,provider,instance_id,credential_reference)
    VALUES($1,$2,'BAILEYS',$3,'qr-engine') ON CONFLICT(organization_id,instance_id) WHERE instance_id IS NOT NULL DO NOTHING`,
    [org, instance.provider_account_id, instance.id],
  );
  const result = await tx.query<{ id: string }>(
    "SELECT id FROM messaging_channels WHERE organization_id=$1 AND instance_id=$2",
    [org, instanceId],
  );
  return (await createPostgresMessagingRepository().findChannel(
    tx,
    org,
    result.rows[0]!.id,
  ))!;
}
export function createQrMessagingService(options: QrServiceOptions) {
  if (options.signingKey.length < 32) throw error("INVALID_QR_SIGNING_KEY");
  const repository = createPostgresMessagingRepository();
  const secret = (org: string, channel: string) =>
    createHmac("sha256", options.signingKey)
      .update(`qr-webhook\0${org}\0${channel}`)
      .digest("base64url");
  async function instance(channel: MessagingChannel) {
    if (channel.provider !== "BAILEYS" || !channel.instanceId)
      throw error("QR_INSTANCE_NOT_FOUND", 404);
    return options.transact(channel.organizationId, async (tx) => {
      const row = (
        await tx.query<{ upstream_instance_key: string; status: string }>(
          "SELECT upstream_instance_key,status FROM instances WHERE organization_id=$1 AND id=$2 AND provider_account_id=$3",
          [
            channel.organizationId,
            channel.instanceId,
            channel.providerAccountId,
          ],
        )
      ).rows[0];
      if (!row) throw error("QR_INSTANCE_NOT_FOUND", 404);
      return row;
    });
  }
  return {
    async activate(org: string, instanceId: string) {
      const channel = await options.transact(org, (tx) =>
        ensureQrChannel(tx, org, instanceId),
      );
      const info = await instance(channel);
      const client = new EvolutionMessagingClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        instanceKey: info.upstream_instance_key,
      });
      const webhookUrl = new URL(
        `/v1/webhooks/whatsapp/${channel.id}`,
        options.webhookOrigin,
      ).toString();
      await client.configureWebhook(webhookUrl, secret(org, channel.id));
      return {
        id: channel.id,
        provider: "BAILEYS" as const,
        botPublicId: channel.botPublicId,
      };
    },
    async resolveClient(channel: MessagingChannel) {
      const info = await instance(channel);
      if (info.status !== "CONNECTED") throw error("QR_CHANNEL_DISCONNECTED");
      return new EvolutionMessagingClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        instanceKey: info.upstream_instance_key,
      });
    },
    async downloadMedia(channel: MessagingChannel, messageId: string) {
      const info = await instance(channel);
      return new EvolutionMessagingClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        instanceKey: info.upstream_instance_key,
      }).downloadMedia(messageId);
    },
    async ingest(
      channelId: string,
      authorization: string | undefined,
      payload: unknown,
    ) {
      const binding = await options.resolveChannel(channelId);
      if (!binding) throw error("QR_WEBHOOK_UNAUTHORIZED", 401);
      const expected = Buffer.from(
        `Bearer ${secret(binding.organizationId, channelId)}`,
      );
      const received = Buffer.from(authorization ?? "");
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      )
        throw error("QR_WEBHOOK_UNAUTHORIZED", 401);
      await options.transact(binding.organizationId, async (tx) => {
        const channel = await repository.findChannel(
          tx,
          binding.organizationId,
          channelId,
        );
        const row = (
          await tx.query<{ upstream_instance_key: string }>(
            "SELECT upstream_instance_key FROM instances WHERE organization_id=$1 AND id=$2",
            [binding.organizationId, binding.instanceId],
          )
        ).rows[0];
        if (!channel || !row || channel.instanceId !== binding.instanceId)
          throw error("QR_WEBHOOK_UNAUTHORIZED", 401);
        for (const event of normalizeQrEvent(
          payload,
          row.upstream_instance_key,
        )) {
          if (event.kind === "connection") {
            await tx.query(
              "UPDATE instances SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 AND status NOT IN ('PROVISIONING','PROVISIONING_FAILED')",
              [binding.organizationId, binding.instanceId, event.state],
            );
            continue;
          }
          if (event.kind === "status") {
            await repository.recordStatusEvent(tx, {
              organizationId: binding.organizationId,
              channelId,
              upstreamMessageId: event.upstreamMessageId,
              state: event.state,
            });
            continue;
          }
          const contact = await repository.upsertContact(tx, {
            id: randomUUID(),
            organizationId: binding.organizationId,
            externalId: event.externalId,
            displayName: event.displayName,
            consentStatus: "UNKNOWN",
            consentUpdatedAt: null,
          });
          const conversation = await repository.getOrCreateConversation(tx, {
            id: randomUUID(),
            organizationId: binding.organizationId,
            channelId,
            contactId: contact.id,
          });
          const content: MessageContent =
            event.kind === "media"
              ? {
                  type: "MEDIA",
                  mediaId: await registerPendingMedia(
                    tx,
                    binding.organizationId,
                    channelId,
                    event.media,
                  ),
                  kind: event.media.kind,
                  fileName: event.media.fileName,
                  caption: event.caption,
                }
              : event.content;
          await repository.recordIncoming(tx, {
            id: randomUUID(),
            organizationId: binding.organizationId,
            channelId,
            conversationId: conversation.id,
            webhookEventKey: `qr:${event.upstreamMessageId}`,
            upstreamMessageId: event.upstreamMessageId,
            content,
            occurredAt: event.occurredAt,
          });
        }
      });
    },
  };
}
