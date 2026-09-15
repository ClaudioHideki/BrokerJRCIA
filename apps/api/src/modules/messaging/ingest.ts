import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OrganizationTransaction } from "../../db/tenant-transaction.js";
import type { MessagingRepository } from "./repository.js";
import { registerPendingMedia } from "./media-store.js";
import type { MessageContent } from "./types.js";
import { safeMediaName } from "@jrc/providers";

const incomingBase = z.object({
  id: z.string().min(1).max(256),
  from: z.string().regex(/^[1-9]\d{7,14}$/),
  timestamp: z.string().regex(/^\d{1,12}$/),
});
const mediaSchema = z.object({
  id: z.string().regex(/^[1-9]\d{4,63}$/),
  caption: z.string().max(1024).optional(),
  filename: z.string().max(256).optional(),
});
const incomingSchema = z.discriminatedUnion("type", [
  incomingBase.extend({
    type: z.literal("text"),
    text: z.object({ body: z.string().min(1).max(4096) }),
  }),
  incomingBase.extend({ type: z.literal("image"), image: mediaSchema }),
  incomingBase.extend({ type: z.literal("audio"), audio: mediaSchema }),
  incomingBase.extend({ type: z.literal("video"), video: mediaSchema }),
  incomingBase.extend({ type: z.literal("document"), document: mediaSchema }),
  incomingBase.extend({ type: z.literal("sticker"), sticker: mediaSchema }),
]);
const envelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        changes: z
          .array(
            z.object({
              field: z.literal("messages"),
              value: z.object({
                metadata: z.object({
                  phone_number_id: z.string().min(1).max(64),
                }),
                messages: z.array(incomingSchema).max(100).default([]),
                statuses: z
                  .array(
                    z.object({
                      id: z.string().min(1).max(256),
                      timestamp: z.string().regex(/^\d{1,12}$/),
                      status: z.enum(["sent", "delivered", "read", "failed"]),
                    }),
                  )
                  .max(100)
                  .default([]),
              }),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});
export interface MetaAssetBinding {
  organizationId: string;
  channelId: string;
}
export function loadMetaAssetBindings(
  serialized: string,
): Record<string, MetaAssetBinding> {
  try {
    if (Buffer.byteLength(serialized) > 1_048_576) throw new Error();
    return z
      .record(
        z.string().regex(/^[1-9]\d{4,63}$/),
        z.strictObject({ organizationId: z.uuid(), channelId: z.uuid() }),
      )
      .parse(JSON.parse(serialized));
  } catch {
    throw new Error("INVALID_META_ASSET_BINDINGS");
  }
}
export interface MetaIngestOptions {
  repository: MessagingRepository;
  bindings: Readonly<Record<string, MetaAssetBinding>>;
  resolveBinding?(
    phoneId: string,
    wabaId: string,
  ): Promise<MetaAssetBinding | undefined>;
  transact<T>(
    organizationId: string,
    operation: OrganizationTransaction<T>,
  ): Promise<T>;
}
/** Call only after raw-byte signature verification. Media descriptors contain IDs, never remote URLs. */
export function createMetaIngestor(options: MetaIngestOptions) {
  return async (rawPayload: unknown): Promise<void> => {
    const parsed = envelopeSchema.safeParse(rawPayload);
    if (!parsed.success) throw new Error("META_EVENT_UNSUPPORTED");
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        const phoneId = change.value.metadata.phone_number_id;
        const binding =
          (await options.resolveBinding?.(phoneId, entry.id)) ??
          (Object.hasOwn(options.bindings, phoneId)
            ? options.bindings[phoneId]
            : undefined);
        if (!binding) throw new Error("META_ASSET_NOT_BOUND");
        await options.transact(binding.organizationId, async (tx) => {
          const channel = await options.repository.findChannel(
            tx,
            binding.organizationId,
            binding.channelId,
          );
          if (
            !channel ||
            channel.phoneNumberId !== phoneId ||
            channel.wabaId !== entry.id
          )
            throw new Error("META_ASSET_NOT_BOUND");
          for (const message of change.value.messages) {
            const occurredAt = new Date(Number(message.timestamp) * 1000);
            if (
              !Number.isFinite(occurredAt.getTime()) ||
              occurredAt.getTime() > Date.now() + 300_000
            )
              throw new Error("INVALID_META_TIMESTAMP");
            const contact = await options.repository.upsertContact(tx, {
              id: randomUUID(),
              organizationId: binding.organizationId,
              externalId: message.from,
              displayName: null,
              consentStatus: "UNKNOWN",
              consentUpdatedAt: null,
            });
            const conversation =
              await options.repository.getOrCreateConversation(tx, {
                id: randomUUID(),
                organizationId: binding.organizationId,
                channelId: channel.id,
                contactId: contact.id,
              });
            let content: MessageContent;
            if (message.type === "text")
              content = { type: "TEXT", text: message.text.body };
            else {
              const media =
                message.type === "image"
                  ? message.image
                  : message.type === "audio"
                    ? message.audio
                    : message.type === "video"
                      ? message.video
                      : message.type === "sticker"
                        ? message.sticker
                        : message.document;
              const fileName = safeMediaName(media.filename ?? message.type);
              const mediaId = await registerPendingMedia(
                tx,
                binding.organizationId,
                channel.id,
                {
                  source: "META",
                  sourceKey: media.id,
                  kind: message.type,
                  fileName,
                  descriptor: { mediaId: media.id },
                },
              );
              content = {
                type: "MEDIA",
                mediaId,
                kind: message.type,
                fileName,
                ...(media.caption ? { caption: media.caption } : {}),
              };
            }
            await options.repository.recordIncoming(tx, {
              id: randomUUID(),
              organizationId: binding.organizationId,
              channelId: binding.channelId,
              conversationId: conversation.id,
              webhookEventKey: `meta:${message.id}`,
              upstreamMessageId: message.id,
              content,
              occurredAt,
            });
          }
          for (const status of change.value.statuses) {
            const occurredAt = new Date(Number(status.timestamp) * 1000);
            if (
              !Number.isFinite(occurredAt.getTime()) ||
              occurredAt.getTime() > Date.now() + 300_000
            )
              throw new Error("INVALID_META_TIMESTAMP");
            const states = {
              sent: "SENT",
              delivered: "DELIVERED",
              read: "READ",
              failed: "FAILED",
            } as const;
            await options.repository.recordStatusEvent(tx, {
              organizationId: binding.organizationId,
              channelId: binding.channelId,
              upstreamMessageId: status.id,
              state: states[status.status],
              occurredAt,
            });
          }
        });
      }
    }
  };
}
