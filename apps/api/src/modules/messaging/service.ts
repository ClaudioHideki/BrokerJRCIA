import { createHash, randomUUID } from "node:crypto";
import {
  ConfigureBotRequestSchema,
  SendTemplateRequestSchema,
  type MessageView,
} from "@jrc/contracts";
import type { MetaCloudClient, TypebotClient } from "@jrc/providers";
import type { OrganizationTransaction } from "../../db/tenant-transaction.js";
import type { MessagingService } from "../../http/routes/messaging.js";
import { inspectTemplateComponents } from "./dispatcher.js";
import {
  MessagingRepositoryError,
  type MessagingRepository,
} from "./repository.js";
import type { Message, MessagingChannel } from "./types.js";
import { SendTextRequestSchema } from "@jrc/contracts";
import { MediaError } from "@jrc/providers";
import type { MediaStore } from "./media-store.js";
import { integrationAudit } from "../integrations/chatwoot-service.js";
import { requireActiveOrganization } from "../tenancy/operational-limits.js";

export interface MessagingServiceOptions {
  media?: MediaStore;
  repository: MessagingRepository;
  runInOrganizationTransaction<T>(
    organizationId: string,
    operation: OrganizationTransaction<T>,
  ): Promise<T>;
  resolveMetaClient(
    channel: MessagingChannel,
  ): Promise<Pick<MetaCloudClient, "listTemplates">>;
  resolveTypebotClient(
    originReference: string,
    organizationId: string,
  ): Promise<Pick<TypebotClient, "startChat" | "continueChat">>;
}
export function messageView(message: Message): MessageView {
  return {
    id: message.id,
    direction: message.direction,
    state: message.state,
    ...(message.retrySafe !== undefined
      ? { retrySafe: message.retrySafe }
      : {}),
    ...(message.canonicalErrorCode
      ? { errorCode: message.canonicalErrorCode }
      : {}),
    ...(message.content.type === "MEDIA"
      ? {
          media: {
            id: message.content.mediaId,
            kind: message.content.kind,
            fileName: message.content.fileName,
          },
        }
      : {}),
    text:
      message.content.type === "TEXT"
        ? message.content.text
        : message.content.type === "MEDIA"
          ? message.content.caption || message.content.fileName
          : message.content.name,
  };
}
export function createMessagingService(
  options: MessagingServiceOptions,
): MessagingService {
  const repository = options.repository;
  const transact = options.runInOrganizationTransaction;
  async function findChannel(organizationId: string, id: string) {
    const channel = await transact(organizationId, (tx) =>
      repository.findChannel(tx, organizationId, id),
    );
    if (!channel || channel.organizationId !== organizationId)
      throw new MessagingRepositoryError("CHANNEL_NOT_FOUND", 404);
    return channel;
  }
  return {
    async retryMessage(organizationId, id, reason, actorId) {
      return transact(organizationId, async (tx) => {
        await requireActiveOrganization(tx, organizationId);
        const message = await repository.retrySafeFailure(tx, {
          organizationId,
          messageId: id,
          notBefore: new Date(),
        });
        await tx.query(
          "UPDATE messaging_outbox SET attempt_count=0 WHERE organization_id=$1 AND message_id=$2",
          [organizationId, id],
        );
        await integrationAudit(
          tx,
          organizationId,
          "SAFE_MESSAGE_RETRIED",
          id,
          reason,
          actorId,
        );
        return messageView(message);
      });
    },
    async readMedia(organizationId, id) {
      if (!options.media) throw new MediaError("MEDIA_NOT_CONFIGURED");
      return options.media.read(organizationId, id);
    },
    async sendText(organizationId, channelId, rawInput, idempotencyKey) {
      const input = SendTextRequestSchema.parse(rawInput);
      await findChannel(organizationId, channelId);
      const content = { type: "TEXT" as const, text: input.text };
      const result = await transact(organizationId, async (tx) => {
        await repository.setConversationMode(tx, {
          organizationId,
          conversationId: input.conversationId,
          mode: "HUMAN",
        });
        return repository.enqueueOutgoing(tx, {
          id: randomUUID(),
          organizationId,
          channelId,
          conversationId: input.conversationId,
          source: "OPERATOR",
          content,
          idempotencyKey,
          bodyHash: createHash("sha256")
            .update(
              JSON.stringify({ conversationId: input.conversationId, content }),
            )
            .digest("hex"),
          policy: { requireOptIn: false },
        });
      });
      return messageView(result.message);
    },
    async listChannels(organizationId) {
      const channels = await transact(organizationId, (tx) =>
        repository.listChannels(tx, organizationId),
      );
      return {
        data: channels.map((channel) => ({
          id: channel.id,
          provider: channel.provider ?? "META",
          botPublicId: channel.botPublicId,
        })),
      };
    },
    async listTemplates(organizationId, channelId) {
      const channel = await findChannel(organizationId, channelId);
      if (channel.provider === "BAILEYS") return { data: [] };
      const client = await options.resolveMetaClient(channel);
      const templates = await client.listTemplates();
      return {
        data: templates.map((template) => {
          const { id, name, language, status, category } = template;
          const componentValidation = inspectTemplateComponents(template);
          return {
            id,
            name,
            language,
            status,
            category,
            bodyVariableCount:
              typeof componentValidation === "number"
                ? componentValidation
                : null,
          };
        }),
      };
    },
    async listConversations(organizationId, channelId) {
      await findChannel(organizationId, channelId);
      const conversations = await transact(organizationId, (tx) =>
        repository.listConversations(tx, organizationId, channelId, 100),
      );
      return {
        data: conversations.map(({ id, channelId, contactId, mode }) => ({
          id,
          channelId,
          contactId,
          mode,
        })),
      };
    },
    async listMessages(organizationId, conversationId) {
      return transact(organizationId, async (tx) => {
        const conversation = await repository.findConversation(
          tx,
          organizationId,
          conversationId,
        );
        if (!conversation)
          throw new MessagingRepositoryError("CONVERSATION_NOT_FOUND", 404);
        return {
          data: (
            await repository.listConversationMessages(
              tx,
              organizationId,
              conversationId,
              100,
            )
          ).map(messageView),
        };
      });
    },
    async sendTemplate(organizationId, channelId, rawInput, idempotencyKey) {
      const input = SendTemplateRequestSchema.parse(rawInput);
      await findChannel(organizationId, channelId);
      const content = {
        type: "TEMPLATE" as const,
        name: input.name,
        language: input.language,
        variables: input.variables,
      };
      const bodyHash = createHash("sha256")
        .update(
          JSON.stringify({ conversationId: input.conversationId, content }),
        )
        .digest("hex");
      const result = await transact(organizationId, (tx) =>
        repository.enqueueOutgoing(tx, {
          id: randomUUID(),
          organizationId,
          channelId,
          conversationId: input.conversationId,
          source: "OPERATOR",
          content,
          idempotencyKey,
          bodyHash,
          policy: { requireOptIn: true },
        }),
      );
      return messageView(result.message);
    },
    async configureBot(organizationId, channelId, rawInput) {
      const input = ConfigureBotRequestSchema.parse(rawInput);
      await findChannel(organizationId, channelId);
      // Resolving the server-owned reference validates allowlist membership without an HTTP call.
      try {
        await options.resolveTypebotClient(
          input.originReference,
          organizationId,
        );
      } catch {
        throw new MessagingRepositoryError("TYPEBOT_NOT_CONFIGURED", 422);
      }
      const channel = await transact(organizationId, (tx) =>
        repository.setChannelBot(tx, {
          organizationId,
          channelId,
          botPublicId: input.publicId,
          botOriginReference: input.originReference,
        }),
      );
      return {
        id: channel.id,
        provider: channel.provider ?? "META",
        botPublicId: channel.botPublicId,
      };
    },
    async setMode(organizationId, conversationId, mode) {
      const value = await transact(organizationId, (tx) =>
        repository.setConversationMode(tx, {
          organizationId,
          conversationId,
          mode,
        }),
      );
      return {
        id: value.id,
        channelId: value.channelId,
        contactId: value.contactId,
        mode: value.mode,
      };
    },
  };
}
