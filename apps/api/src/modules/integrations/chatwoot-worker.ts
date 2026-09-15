import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createPostgresMessagingRepository } from "../messaging/repository.js";
import { isOrganizationActive } from "../tenancy/operational-limits.js";
import { ChatwootError } from "./chatwoot-client.js";
import {
  chatwootEnvironment,
  IntegrationError,
  readChatwootAccount,
  readChatwootConnection,
  type ChatwootOptions,
} from "./chatwoot-service.js";
import { MediaError, type BinaryMedia } from "@jrc/providers";
import { registerPendingMedia } from "../messaging/media-store.js";
import type { MessageContent } from "../messaging/types.js";
import { MessagingRepositoryError } from "../messaging/repository.js";

interface Job {
  id: string;
  organization_id: string;
  integration_id: string;
  kind: "CHATWOOT_REPLY" | "MIRROR_MESSAGE";
  message_id: string | null;
  attempts: number;
  lease_token: string;
  payload: Record<string, unknown>;
}
interface ConversationMap {
  contact_id: string;
  source_id: string;
  remote_conversation_id: string;
}
const replySchema = z
  .object({
    messageId: z.number().int().positive(),
    conversationId: z.number().int().positive(),
    content: z
      .object({ type: z.literal("TEXT"), text: z.string().min(1).max(4096) })
      .optional(),
    caption: z.string().max(4096).optional(),
    attachments: z
      .array(
        z.object({
          id: z.number().int().positive(),
          kind: z.enum(["image", "audio", "video", "document"]),
        }),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .refine((x) => Boolean(x.content) !== Boolean(x.attachments));

export function createChatwootWorker(options: ChatwootOptions) {
  const env = chatwootEnvironment(options),
    repo = createPostgresMessagingRepository(),
    tx = options.transact;
  async function claim(org: string): Promise<Job | undefined> {
    return tx(org, async (t) => {
      // An expired POST might have succeeded remotely. Replies are local, idempotent transactions.
      await t.query(
        `UPDATE integration_jobs SET status=CASE WHEN kind='CHATWOOT_REPLY' THEN 'PENDING' ELSE 'UNKNOWN' END,
        lease_token=NULL,lease_expires_at=NULL,last_error='WORKER_LEASE_EXPIRED',updated_at=now()
        WHERE organization_id=$1 AND status='RUNNING' AND lease_expires_at<now()`,
        [org],
      );
      if (!(await isOrganizationActive(t, org))) return;
      const connection = (
        await t.query<{ id: string }>(
          `SELECT c.id FROM chatwoot_connections c
        JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
        WHERE c.organization_id=$1 AND c.status='READY' AND a.status='READY'
          AND EXISTS(SELECT 1 FROM integration_jobs j WHERE j.organization_id=c.organization_id AND j.integration_id=c.id AND j.status='PENDING' AND j.available_at<=now())
          AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.organization_id=c.organization_id AND j.integration_id=c.id AND j.status IN ('RUNNING','UNKNOWN'))
        ORDER BY c.updated_at,c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
          [org],
        )
      ).rows[0];
      if (!connection) return;
      const job = (
        await t.query<{ id: string }>(
          `SELECT id FROM integration_jobs WHERE organization_id=$1 AND integration_id=$2 AND status='PENDING' AND available_at<=now()
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [org, connection.id],
        )
      ).rows[0];
      if (!job) return;
      await t.query(
        "UPDATE chatwoot_connections SET updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, connection.id],
      );
      return (
        await t.query<Job>(
          `UPDATE integration_jobs SET status='RUNNING',attempts=attempts+1,lease_token=$3,lease_expires_at=now()+interval '3 minutes',updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
          [org, job.id, randomUUID()],
        )
      ).rows[0];
    });
  }
  async function progress(
    job: Job,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await tx(job.organization_id, async (t) => {
      const result = await t.query(
        `UPDATE integration_jobs SET payload=payload || $4::jsonb,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>now() RETURNING id`,
        [job.organization_id, job.id, job.lease_token, JSON.stringify(patch)],
      );
      if (!result.rowCount)
        throw new IntegrationError("INTEGRATION_LEASE_LOST", 409);
      Object.assign(job.payload, patch);
    });
  }
  async function beforeExternal(job: Job, operation: string) {
    await tx(job.organization_id, async (t) => {
      if (!(await isOrganizationActive(t, job.organization_id)))
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      const result = await t.query(
        `UPDATE integration_jobs j SET payload=payload||jsonb_build_object('operation',$4::text),updated_at=now()
       WHERE j.organization_id=$1 AND j.id=$2 AND j.lease_token=$3 AND j.status='RUNNING' AND j.lease_expires_at>now()+interval '20 seconds'
       AND EXISTS(SELECT 1 FROM chatwoot_connections c JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
        WHERE c.organization_id=j.organization_id AND c.id=j.integration_id AND c.status='READY' AND a.status='READY') RETURNING j.id`,
        [job.organization_id, job.id, job.lease_token, operation],
      );
      if (!result.rowCount)
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      job.payload.operation = operation;
    });
  }
  async function finish(job: Job): Promise<void> {
    await tx(job.organization_id, async (t) => {
      const result = await t.query(
        `UPDATE integration_jobs SET status='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' RETURNING id`,
        [job.organization_id, job.id, job.lease_token],
      );
      if (!result.rowCount)
        throw new IntegrationError("INTEGRATION_LEASE_LOST", 409);
    });
  }
  async function receiveReply(job: Job): Promise<void> {
    const data = replySchema.parse(job.payload);
    const binding = await tx(job.organization_id, async (t) => ({
      account: await readChatwootAccount(t, job.organization_id),
      connection: await readChatwootConnection(
        t,
        job.organization_id,
        job.integration_id,
      ),
      mapped: (
        await t.query(
          "SELECT 1 FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND remote_conversation_id=$3",
          [job.organization_id, job.integration_id, data.conversationId],
        )
      ).rowCount,
    }));
    let remote:
      | Awaited<ReturnType<ReturnType<typeof env.client>["conversation"]>>
      | undefined;
    let remoteSource: string | undefined;
    if (!binding.mapped) {
      if (
        !binding.account ||
        !binding.connection?.inbox_id ||
        binding.connection.status !== "READY"
      )
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      const client = env.client(binding.account);
      remote = await client.conversation(
        Number(binding.account.account_id),
        data.conversationId,
      );
      if (
        remote.account_id !== Number(binding.account.account_id) ||
        remote.inbox_id !== Number(binding.connection.inbox_id) ||
        !/^\+[1-9]\d{7,14}$/u.test(remote.meta.sender.phone_number ?? "")
      )
        throw new IntegrationError("CHATWOOT_BINDING_MISMATCH");
      const contact = await client.contact(
        Number(binding.account.account_id),
        remote.meta.sender.id,
      );
      if (
        contact.id !== remote.meta.sender.id ||
        contact.phone_number !== remote.meta.sender.phone_number
      )
        throw new IntegrationError("CHATWOOT_BINDING_MISMATCH");
      remoteSource = contact.contact_inboxes.find(
        (i) => i.inbox.id === remote!.inbox_id,
      )?.source_id;
      if (!remoteSource)
        throw new IntegrationError("CHATWOOT_CONVERSATION_NOT_BOUND");
    }
    await tx(job.organization_id, async (t) => {
      const lease = await t.query(
        "SELECT id FROM integration_jobs WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>now() FOR UPDATE",
        [job.organization_id, job.id, job.lease_token],
      );
      if (!lease.rowCount)
        throw new IntegrationError("INTEGRATION_LEASE_LOST", 409);
      const connection = await readChatwootConnection(
        t,
        job.organization_id,
        job.integration_id,
      );
      if (
        !connection ||
        connection.status !== "READY" ||
        !(await isOrganizationActive(t, job.organization_id))
      )
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      let map = (
        await t.query<{ conversation_id: string }>(
          "SELECT conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND remote_conversation_id=$3",
          [job.organization_id, job.integration_id, data.conversationId],
        )
      ).rows[0];
      if (!map && remote && remoteSource) {
        const contact = await repo.upsertContact(t, {
          id: randomUUID(),
          organizationId: job.organization_id,
          externalId: remote.meta.sender.phone_number!.slice(1),
          displayName: remote.meta.sender.name ?? null,
          consentStatus: "UNKNOWN",
          consentUpdatedAt: null,
        });
        const conversation = await repo.getOrCreateConversation(t, {
          id: randomUUID(),
          organizationId: job.organization_id,
          channelId: connection.channel_id,
          contactId: contact.id,
        });
        const inserted = await t.query(
          `INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING conversation_id`,
          [
            job.organization_id,
            job.integration_id,
            conversation.id,
            remote.meta.sender.id,
            remoteSource,
            data.conversationId,
          ],
        );
        if (!inserted.rowCount)
          throw new IntegrationError("CHATWOOT_CONVERSATION_ALREADY_BOUND");
        map = { conversation_id: conversation.id };
      }
      if (!map)
        throw new IntegrationError("CHATWOOT_CONVERSATION_NOT_BOUND", 409);
      await repo.setConversationMode(t, {
        organizationId: job.organization_id,
        conversationId: map.conversation_id,
        mode: "HUMAN",
      });
      const contents: MessageContent[] = [];
      if (data.content) contents.push(data.content);
      if (data.attachments) {
        if (data.caption && data.caption.length > 1024)
          contents.push({ type: "TEXT", text: data.caption });
        for (const [index, attachment] of data.attachments.entries()) {
          const mediaId = await registerPendingMedia(
            t,
            job.organization_id,
            connection.channel_id,
            {
              source: "CHATWOOT",
              sourceKey: `${job.integration_id}:${data.messageId}:${attachment.id}`,
              kind: attachment.kind,
              fileName: attachment.kind,
              descriptor: {
                integrationId: job.integration_id,
                conversationId: data.conversationId,
                messageId: data.messageId,
                attachmentId: attachment.id,
              },
            },
          );
          contents.push({
            type: "MEDIA",
            mediaId,
            kind: attachment.kind,
            fileName: attachment.kind,
            ...(index === 0 && data.caption && data.caption.length <= 1024
              ? { caption: data.caption }
              : {}),
          });
        }
      }
      let firstId: string | undefined;
      for (const [index, content] of contents.entries()) {
        const result = await repo.enqueueOutgoing(t, {
          id: randomUUID(),
          organizationId: job.organization_id,
          channelId: connection.channel_id,
          conversationId: map.conversation_id,
          source: "OPERATOR",
          content,
          idempotencyKey: data.content
            ? `chatwoot:${data.messageId}`
            : `chatwoot:${data.messageId}:${index}`,
          bodyHash: createHash("sha256")
            .update(JSON.stringify({ data, index }))
            .digest("hex"),
          policy: { requireOptIn: false },
        });
        firstId ??= result.message.id;
        await t.query(
          `INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(organization_id,integration_id,message_id) DO NOTHING`,
          [
            job.organization_id,
            job.integration_id,
            result.message.id,
            data.messageId,
          ],
        );
      }
      await t.query(
        "UPDATE integration_jobs SET status='SUCCEEDED',message_id=$4,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3",
        [job.organization_id, job.id, job.lease_token, firstId],
      );
    });
  }
  async function mirror(job: Job): Promise<void> {
    const org = job.organization_id;
    const context = await tx(org, async (t) => {
      const a = await readChatwootAccount(t, org),
        c = await readChatwootConnection(t, org, job.integration_id);
      if (!a || !c?.inbox_id || c.status !== "READY")
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      const message = (
        await t.query<{
          id: string;
          conversation_id: string;
          direction: string;
          content: MessageContent;
          state: string;
          canonical_error_code: string | null;
        }>(
          "SELECT id,conversation_id,direction,content,state,canonical_error_code FROM messaging_messages WHERE organization_id=$1 AND id=$2 AND channel_id=$3",
          [org, job.message_id, c.channel_id],
        )
      ).rows[0];
      if (!message)
        throw new IntegrationError("INTEGRATION_MESSAGE_NOT_FOUND", 404);
      const contact = (
        await t.query<{
          id: string;
          external_id: string;
          display_name: string | null;
        }>(
          `SELECT contact.id,contact.external_id,contact.display_name FROM messaging_contacts contact
        JOIN messaging_conversations conversation ON conversation.organization_id=contact.organization_id AND conversation.contact_id=contact.id WHERE conversation.organization_id=$1 AND conversation.id=$2`,
          [org, message.conversation_id],
        )
      ).rows[0];
      if (!contact)
        throw new IntegrationError("INTEGRATION_CONTACT_NOT_FOUND", 404);
      const map = (
        await t.query<ConversationMap>(
          "SELECT contact_id,source_id,remote_conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3",
          [org, c.id, message.conversation_id],
        )
      ).rows[0];
      const mappedMessage = (
        await t.query<{ remote_message_id: string }>(
          "SELECT remote_message_id FROM chatwoot_messages WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3",
          [org, c.id, message.id],
        )
      ).rows[0];
      return { a, c, message, contact, map, mappedMessage };
    });
    const { a, c, message, contact } = context;
    if (
      message.direction === "OUTGOING" &&
      ["ACCEPTED", "SENDING", "UNKNOWN"].includes(message.state)
    ) {
      await finish(job);
      return;
    }
    const client = env.client(a),
      accountId = Number(a.account_id),
      inboxId = Number(c.inbox_id);
    let media: BinaryMedia | undefined;
    if (
      !context.mappedMessage &&
      typeof job.payload.remoteMessageId !== "number" &&
      message.content.type === "MEDIA"
    ) {
      if (!options.media) throw new MediaError("MEDIA_NOT_CONFIGURED");
      media = {
        ...(await options.media.read(org, message.content.mediaId)),
        ...(message.content.caption
          ? { caption: message.content.caption }
          : {}),
      };
    }
    let map = context.map;
    if (!map) {
      let contactId =
        typeof job.payload.contactId === "number"
          ? job.payload.contactId
          : await client.findContact(accountId, contact.external_id);
      if (!contactId) {
        await beforeExternal(job, "CREATE_CONTACT");
        contactId = await client.createContact(accountId, {
          inboxId,
          phone: contact.external_id,
          name: contact.display_name ?? "+" + contact.external_id,
          identifier: `jrc-${org}-${contact.id}`,
        });
      }
      await progress(job, { contactId });
      if (typeof job.payload.sourceId !== "string")
        await beforeExternal(job, "LINK_CONTACT");
      const sourceId =
        typeof job.payload.sourceId === "string"
          ? job.payload.sourceId
          : await client.linkContactInbox(
              accountId,
              contactId,
              inboxId,
              `jrc-${contact.id}`,
            );
      await progress(job, { sourceId });
      if (typeof job.payload.conversationId !== "number")
        await beforeExternal(job, "CREATE_CONVERSATION");
      const conversationId =
        typeof job.payload.conversationId === "number"
          ? job.payload.conversationId
          : await client.createConversation(accountId, {
              inboxId,
              contactId,
              sourceId,
            });
      await progress(job, { conversationId });
      await tx(org, (t) =>
        t
          .query(
            `INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,integration_id,conversation_id) DO NOTHING`,
            [
              org,
              c.id,
              message.conversation_id,
              contactId,
              sourceId,
              conversationId,
            ],
          )
          .then(() => undefined),
      );
      map = {
        contact_id: String(contactId),
        source_id: sourceId,
        remote_conversation_id: String(conversationId),
      };
    }
    let remoteMessageId = context.mappedMessage
      ? Number(context.mappedMessage.remote_message_id)
      : typeof job.payload.remoteMessageId === "number"
        ? job.payload.remoteMessageId
        : undefined;
    if (!remoteMessageId) {
      const text =
        message.content.type === "TEXT"
          ? message.content.text
          : message.content.type === "TEMPLATE"
            ? message.content.name
            : undefined;
      if (!text && !media)
        throw new IntegrationError("CHATWOOT_CONTENT_UNSUPPORTED");
      await progress(job, {
        conversationId: Number(map.remote_conversation_id),
      });
      await beforeExternal(job, "SEND_MESSAGE");
      remoteMessageId = media
        ? await client.sendMedia(
            accountId,
            Number(map.remote_conversation_id),
            media,
            {
              incoming: message.direction === "INCOMING",
              brokerMessageId: message.id,
            },
          )
        : await client.sendMessage(
            accountId,
            Number(map.remote_conversation_id),
            {
              text: text!,
              incoming: message.direction === "INCOMING",
              brokerMessageId: message.id,
            },
          );
      await progress(job, { remoteMessageId });
    }
    await tx(org, (t) =>
      t
        .query(
          `INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(organization_id,integration_id,message_id) DO NOTHING`,
          [org, c.id, message.id, remoteMessageId],
        )
        .then(() => undefined),
    );
    if (
      message.direction === "OUTGOING" &&
      ["SENT", "DELIVERED", "READ", "FAILED"].includes(message.state)
    ) {
      const siblings = await tx(org, (t) =>
        t.query<{ state: string; canonical_error_code: string | null }>(
          `SELECT m.state,m.canonical_error_code FROM chatwoot_messages cm JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id WHERE cm.organization_id=$1 AND cm.integration_id=$2 AND cm.remote_message_id=$3`,
          [org, c.id, remoteMessageId],
        ),
      );
      const states = siblings.rows.map((m) => m.state);
      const state = states.includes("FAILED")
        ? "failed"
        : states.some((s) => ["ACCEPTED", "SENDING", "UNKNOWN"].includes(s))
          ? undefined
          : states.every((s) => s === "READ")
            ? "read"
            : states.every((s) => ["READ", "DELIVERED"].includes(s))
              ? "delivered"
              : "sent";
      if (!state) {
        await finish(job);
        return;
      }
      await beforeExternal(job, "UPDATE_STATUS");
      await client.updateMessageStatus(
        accountId,
        Number(map.remote_conversation_id),
        remoteMessageId,
        state,
        siblings.rows.find((m) => m.canonical_error_code)
          ?.canonical_error_code ?? undefined,
      );
    }
    await finish(job);
  }
  return {
    async runOnce(org: string): Promise<void> {
      const job = await claim(org);
      if (!job) return;
      try {
        if (job.kind === "CHATWOOT_REPLY") await receiveReply(job);
        else await mirror(job);
      } catch (error) {
        const uncertain =
          job.kind === "MIRROR_MESSAGE" &&
          (!(error instanceof IntegrationError) ||
            error.code === "INTEGRATION_LEASE_LOST") &&
          !(error instanceof MediaError) &&
          (!(error instanceof ChatwootError) || error.uncertain);
        const retry =
          (error instanceof IntegrationError &&
            error.code === "INTEGRATION_PAUSED") ||
          ((error instanceof ChatwootError || error instanceof MediaError) &&
            error.retrySafe &&
            job.attempts < 6);
        const code =
          error instanceof IntegrationError ||
          error instanceof ChatwootError ||
          error instanceof MediaError ||
          error instanceof MessagingRepositoryError
            ? error.code
            : "INTEGRATION_PROCESSING_FAILED";
        await tx(org, (t) =>
          t
            .query(
              `UPDATE integration_jobs SET status=$4,last_error=$5,lease_token=NULL,lease_expires_at=NULL,
          available_at=now()+($6*interval '1 second'),updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3`,
              [
                org,
                job.id,
                job.lease_token,
                uncertain ? "UNKNOWN" : retry ? "PENDING" : "FAILED",
                code,
                Math.min(300, 5 * 2 ** Math.min(job.attempts, 6)),
              ],
            )
            .then(() => undefined),
        );
      }
    },
  };
}
