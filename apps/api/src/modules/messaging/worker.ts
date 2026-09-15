import { randomUUID } from "node:crypto";
import type { MetaCloudClient, TypebotClient } from "@jrc/providers";
import type { OrganizationTransaction } from "../../db/tenant-transaction.js";
import type { MessagingRepository } from "./repository.js";
import type { MessagingChannel } from "./types.js";
import { dispatchClaim, type DispatchPorts } from "./dispatcher.js";
import { runBotTurn } from "./bot-runner.js";

export interface MessagingWorkerOptions {
  prepareMedia?: DispatchPorts["prepareMedia"];
  repository: MessagingRepository;
  transact<T>(
    organizationId: string,
    operation: OrganizationTransaction<T>,
  ): Promise<T>;
  resolveMetaClient(
    channel: MessagingChannel,
  ): Promise<
    Pick<MetaCloudClient, "sendText" | "sendTemplate" | "listTemplates">
  >;
  resolveQrClient?(
    channel: MessagingChannel,
  ): Promise<
    Pick<MetaCloudClient, "sendText" | "sendTemplate" | "listTemplates">
  >;
  resolveTypebotClient(
    originReference: string,
    organizationId: string,
  ): Promise<Pick<TypebotClient, "startChat" | "continueChat">>;
}
export function createMessagingWorker(options: MessagingWorkerOptions) {
  const { repository, transact } = options;
  return {
    async runOnce(organizationId: string): Promise<void> {
      const botClaim = await transact(organizationId, (tx) =>
        repository.claimBotTurn(tx, {
          organizationId,
          workerId: randomUUID(),
          now: new Date(),
          leaseMs: 120_000,
        }),
      );
      if (botClaim) {
        const key = {
          organizationId,
          messageId: botClaim.message.id,
          leaseToken: botClaim.leaseToken,
        };
        const conversation = botClaim.conversation;
        if (
          conversation.botPublicId &&
          conversation.botOriginReference &&
          botClaim.message.content.type === "TEXT"
        ) {
          let client:
            | Pick<TypebotClient, "startChat" | "continueChat">
            | undefined;
          try {
            client = await options.resolveTypebotClient(
              conversation.botOriginReference,
              organizationId,
            );
          } catch {
            await transact(organizationId, (tx) =>
              repository.failBotTurn(tx, {
                ...key,
                canonicalErrorCode: "TYPEBOT_NOT_CONFIGURED",
                uncertain: false,
              }),
            );
          }
          const resolvedClient = client;
          if (resolvedClient)
            await runBotTurn(
              {
                publicId: conversation.botPublicId,
                sessionId: conversation.typebotSessionId,
                text: botClaim.message.content.text,
              },
              {
                startChat: (id, text) => resolvedClient.startChat(id, text),
                continueChat: (id, text) =>
                  resolvedClient.continueChat(id, text),
                async complete(result) {
                  await transact(organizationId, (tx) =>
                    repository.completeBotTurn(tx, {
                      ...key,
                      sessionId: result.sessionId,
                      texts: result.texts,
                    }),
                  );
                },
                async fail(canonicalErrorCode, uncertain) {
                  await transact(organizationId, (tx) =>
                    repository.failBotTurn(tx, {
                      ...key,
                      canonicalErrorCode,
                      uncertain,
                    }),
                  );
                },
              },
            );
        } else
          await transact(organizationId, (tx) =>
            repository.failBotTurn(tx, {
              ...key,
              canonicalErrorCode: "TYPEBOT_NOT_CONFIGURED",
              uncertain: false,
            }),
          );
      }
      // Lease only work that can start immediately; a serial batch can expire before its turn.
      const claims = await transact(organizationId, (tx) =>
        repository.claimOutgoing(tx, {
          organizationId,
          workerId: randomUUID(),
          now: new Date(),
          leaseMs: 120_000,
          limit: 1,
        }),
      );
      for (const claim of claims) {
        await dispatchClaim(claim, {
          ...(options.prepareMedia
            ? { prepareMedia: options.prepareMedia }
            : {}),
          resolveClient: (current) =>
            current.channel.provider === "BAILEYS"
              ? (options.resolveQrClient?.(current.channel) ??
                Promise.reject(new Error("QR_CHANNEL_UNAVAILABLE")))
              : options.resolveMetaClient(current.channel),
          async validate(current) {
            const result = await transact(organizationId, (tx) =>
              repository.validateClaim(tx, {
                organizationId,
                messageId: current.message.id,
                leaseToken: current.leaseToken,
              }),
            );
            return result.eligible;
          },
          async complete(current, outcome) {
            await transact(organizationId, (tx) =>
              repository.completeSend(tx, {
                organizationId,
                messageId: current.message.id,
                leaseToken: current.leaseToken,
                outcome,
              }),
            );
          },
        });
      }
    },
  };
}
