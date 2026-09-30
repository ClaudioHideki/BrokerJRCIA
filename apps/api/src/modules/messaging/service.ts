import { createHash, randomUUID } from "node:crypto";
import {
  ConfigureBotRequestSchema,
  CreateTextTemplateRequestSchema,
  SendTemplateRequestSchema,
  type MessageView,
  type TemplateView,
} from "@jrc/contracts";
import type { MetaCloudClient, MetaMessageTemplate, TypebotClient } from "@jrc/providers";
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
import {
  claimIdempotency,
  completeIdempotencyRecord,
  hashIdempotencyRequest,
} from "../instances/idempotency.js";

export interface MessagingServiceOptions {
  media?: MediaStore;
  repository: MessagingRepository;
  runInOrganizationTransaction<T>(
    organizationId: string,
    operation: OrganizationTransaction<T>,
  ): Promise<T>;
  resolveMetaClient(
    channel: MessagingChannel,
  ): Promise<Pick<MetaCloudClient, "listTemplates" | "findTemplateByName" | "createTextTemplate">>;
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
function templateView(template: MetaMessageTemplate): TemplateView {
  const { id, name, language, status, category } = template;
  const componentValidation = inspectTemplateComponents(template);
  return { id, name, language, status, category,
    bodyVariableCount: typeof componentValidation === "number" ? componentValidation : null };
}
const TEMPLATE_CLIENT_ROUTE = "POST /v1/messaging/channels/:id/templates";
const TEMPLATE_IDENTITY_ROUTE = "META_TEMPLATE_WABA_NAME_LANGUAGE";
const TEMPLATE_RESERVATION_MS = 7 * 24 * 60 * 60 * 1000;
function templateError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}
function fixedTextBodyMatches(template: MetaMessageTemplate, body: string): boolean {
  return template.components.length === 1 && template.components.some(component =>
    typeof component === "object" && component !== null &&
    (component as Record<string, unknown>).type === "BODY" &&
    (component as Record<string, unknown>).text === body,
  );
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
          ownerRevision: channel.ownerRevision ?? 0,
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
      return { data: templates.map(templateView) };
    },
    async getTemplateStatus(organizationId, channelId, templateId) {
      const channel = await findChannel(organizationId, channelId);
      if (channel.provider !== "META" || !channel.wabaId)
        throw Object.assign(new Error("META_CHANNEL_REQUIRED"), { code: "META_CHANNEL_REQUIRED", status: 422 });
      // Query the channel's WABA, never Graph's global template-ID endpoint: the
      // latter can resolve another WABA accessible to the same service token.
      const templates = await (await options.resolveMetaClient(channel)).listTemplates();
      const template = templates.find(item => item.id === templateId);
      const checkedAt = new Date().toISOString();
      return template
        ? { observation: "OBSERVED" as const, id: templateId, checkedAt, template: templateView(template) }
        : { observation: "NOT_OBSERVED" as const, id: templateId, checkedAt };
    },
    async createTextTemplate(organizationId, channelId, rawInput, idempotencyKey) {
      const input = CreateTextTemplateRequestSchema.parse(rawInput);
      const channel = await transact(organizationId, async tx => {
        await requireActiveOrganization(tx, organizationId);
        const found = await repository.findChannel(tx, organizationId, channelId);
        if (!found || found.organizationId !== organizationId)
          throw new MessagingRepositoryError("CHANNEL_NOT_FOUND", 404);
        if (found.provider !== "META" || !found.wabaId)
          throw templateError("META_CHANNEL_REQUIRED", 422);
        return found;
      });
      // A failure before Graph POST has no remote side effect. Fetch the WABA-scoped
      // observation before reserving an idempotency key, so configuration or GET
      // outages do not strand the name for the reservation lifetime.
      let client: Awaited<ReturnType<MessagingServiceOptions["resolveMetaClient"]>>;
      let observed: MetaMessageTemplate | undefined;
      try {
        client = await options.resolveMetaClient(channel);
        observed = await client.findTemplateByName(input.name, input.language);
      } catch {
        throw templateError("META_TEMPLATE_SUBMISSION_UNKNOWN", 503);
      }
      const reservation = await transact(organizationId, async tx => {
        await requireActiveOrganization(tx, organizationId);
        const current = await repository.findChannel(tx, organizationId, channelId);
        if (!current || current.organizationId !== organizationId)
          throw new MessagingRepositoryError("CHANNEL_NOT_FOUND", 404);
        if (current.provider !== "META" || !current.wabaId)
          throw templateError("META_CHANNEL_REQUIRED", 422);
        if (current.wabaId !== channel.wabaId)
          throw templateError("META_CHANNEL_REQUIRED", 409);
        const expiresAt = new Date(Date.now() + TEMPLATE_RESERVATION_MS);
        const client = await claimIdempotency(tx, {
          organizationId,
          route: TEMPLATE_CLIENT_ROUTE,
          key: idempotencyKey,
          requestHash: hashIdempotencyRequest({ channelId, input }),
          expiresAt,
        });
        if (client.kind === "REPLAY" && client.record.status === "FAILED"
          && client.record.responseMetadata.errorCode === "META_TEMPLATE_REJECTED")
          return { identity: null, client };
        const identityKey = hashIdempotencyRequest({ wabaId: current.wabaId,
          name: input.name, language: input.language });
        // A definitive provider rejection did not create a template. Release an
        // identity reserved by an earlier build so a corrected body can retry.
        await tx.query(`DELETE FROM idempotency_records
          WHERE organization_id=$1 AND route=$2 AND idempotency_key=$3
            AND status='FAILED' AND response_metadata->>'errorCode'='META_TEMPLATE_REJECTED'`,
        [organizationId, TEMPLATE_IDENTITY_ROUTE, identityKey]);
        const identity = await claimIdempotency(tx, {
          organizationId,
          route: TEMPLATE_IDENTITY_ROUTE,
          key: identityKey,
          requestHash: hashIdempotencyRequest({ wabaId: current.wabaId, input }),
          expiresAt,
        });
        return { identity, client };
      });
      if (!reservation.identity) throw templateError("META_TEMPLATE_REJECTED", 422);
      const identity = reservation.identity;
      const recordId = (claim: typeof identity) =>
        claim.kind === "CLAIMED" ? claim.recordId : claim.record.id;
      const storeOutcome = async (status: "COMPLETED" | "FAILED", responseMetadata: Record<string, unknown>) =>
        transact(organizationId, async tx => {
          if (status === "FAILED") {
            await completeIdempotencyRecord(tx, {
              organizationId, recordId: recordId(reservation.client), status, responseMetadata,
            });
            // Only the reservation made by this POST may be released. An
            // uncertain POST retains its identity and is never resent blindly.
            if (identity.kind === "CLAIMED") await tx.query(
              `DELETE FROM idempotency_records WHERE organization_id=$1 AND id=$2 AND status='IN_PROGRESS'`,
              [organizationId, identity.recordId],
            );
            return;
          }
          for (const claim of [identity, reservation.client]) {
            await completeIdempotencyRecord(tx, {
              organizationId, recordId: recordId(claim), status, responseMetadata,
            });
          }
        });
      if (observed) {
        if (!fixedTextBodyMatches(observed, input.body))
          throw templateError("META_TEMPLATE_NAME_CONFLICT", 409);
        await storeOutcome("COMPLETED", { templateId: observed.id });
        return { id: observed.id, name: observed.name, language: observed.language,
          category: observed.category, status: observed.status };
      }
      const replay = [identity, reservation.client].find(claim => claim.kind === "REPLAY");
      if (replay?.kind === "REPLAY") {
        const metadata = replay.record.responseMetadata;
        if (replay.record.status === "FAILED" && metadata.errorCode === "META_TEMPLATE_REJECTED")
          throw templateError("META_TEMPLATE_REJECTED", 422);
        if (replay.record.status === "COMPLETED" && typeof metadata.templateId === "string")
          return { id: metadata.templateId, name: input.name, language: input.language,
            category: input.category, status: "STATUS_NOT_RETURNED" };
        throw templateError("META_TEMPLATE_SUBMISSION_UNKNOWN", 503);
      }
      try {
        const created = await client.createTextTemplate(input);
        await storeOutcome("COMPLETED", { templateId: created.id });
        return { id: created.id, name: input.name, language: input.language,
          category: created.category ?? input.category, status: created.status ?? "STATUS_NOT_RETURNED" };
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "META_REQUEST_REJECTED") {
          await storeOutcome("FAILED", { errorCode: "META_TEMPLATE_REJECTED" });
          throw templateError("META_TEMPLATE_REJECTED", 422);
        }
        throw templateError("META_TEMPLATE_SUBMISSION_UNKNOWN", 503);
      }
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
          expectedOwnerRevision: input.expectedOwnerRevision,
        }),
      );
      return {
        id: channel.id,
        ownerRevision: channel.ownerRevision ?? 0,
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
