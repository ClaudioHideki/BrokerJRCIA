import { isOrganizationActive } from "../tenancy/operational-limits.js";
import type { QueryResultRow } from "pg";

import type { TenantTransaction } from "../../db/tenant-transaction.js";
import type {
  BotTurnClaim,
  BotTurnCompletion,
  ClaimValidation,
  ClaimIneligibilityReason,
  CompleteSendOutcome,
  ConsentStatus,
  Conversation,
  ConversationListItem,
  ConversationMode,
  Message,
  MessageContent,
  MessageState,
  MessagingChannel,
  MessagingContact,
  OutboxClaim,
  OutgoingMessageSource,
} from "./types.js";

export type MessagingRepositoryErrorCode =
  | "PROVIDER_ACCOUNT_NOT_FOUND"
  | "INVALID_BOT_CONFIGURATION"
  | "FLOW_INBOX_HAS_AUTOMATION"
  | "TYPEBOT_NOT_CONFIGURED"
  | "CHANNEL_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND"
  | "CONTACT_SUPPRESSED"
  | "CONTACT_CONSENT_REQUIRED"
  | "CONVERSATION_PAUSED"
  | "IDEMPOTENCY_CONFLICT"
  | "BOT_OWNERSHIP_CONFLICT"
  | "MESSAGE_NOT_FOUND"
  | "INVALID_MESSAGE_TRANSITION"
  | "INVALID_OUTBOX_CLAIM";

export class MessagingRepositoryError extends Error {
  constructor(
    readonly code: MessagingRepositoryErrorCode,
    readonly status: 404 | 409 | 422,
  ) {
    super(code);
    this.name = "MessagingRepositoryError";
  }
}

const FORWARD_TRANSITIONS: Readonly<
  Record<MessageState, ReadonlySet<MessageState>>
> = {
  ACCEPTED: new Set(["ACCEPTED", "SENDING", "FAILED"]),
  SENDING: new Set(["SENDING", "SENT", "FAILED", "UNKNOWN"]),
  SENT: new Set(["SENT", "DELIVERED", "READ", "FAILED"]),
  DELIVERED: new Set(["DELIVERED", "READ"]),
  READ: new Set(["READ"]),
  FAILED: new Set(["FAILED"]),
  UNKNOWN: new Set(["UNKNOWN", "SENT", "DELIVERED", "READ", "FAILED"]),
};

export function canAdvanceMessageState(
  from: MessageState,
  to: MessageState,
): boolean {
  return FORWARD_TRANSITIONS[from].has(to);
}

export function isCustomerServiceWindowOpen(
  latestIncomingAt: Date | null,
  now: Date,
): boolean {
  if (!latestIncomingAt || latestIncomingAt.getTime() > now.getTime())
    return false;
  return latestIncomingAt.getTime() > now.getTime() - 24 * 60 * 60 * 1_000;
}

export interface EnqueueOutgoingInput {
  id: string;
  organizationId: string;
  channelId: string;
  conversationId: string;
  source: OutgoingMessageSource;
  content: MessageContent;
  idempotencyKey: string;
  bodyHash: string;
  policy: { requireOptIn: boolean };
}

interface MessageDatabaseRow extends QueryResultRow, Message {
  idempotencyBodyHash?: string;
}

interface EnqueuePolicyRow extends QueryResultRow {
  consentStatus: ConsentStatus;
  suppressedAt: Date | null;
  mode: ConversationMode;
}

interface ChannelDatabaseRow extends QueryResultRow, MessagingChannel {}
interface ContactDatabaseRow extends QueryResultRow, MessagingContact {}
interface ConversationDatabaseRow extends QueryResultRow, Conversation {}
interface ClaimDatabaseRow extends QueryResultRow {
  message?: Message;
  contact?: MessagingContact;
  channel?: MessagingChannel;
  leaseToken: string;
  attemptCount: number;
  messageId?: string;
  messageOrganizationId?: string;
  messageChannelId?: string;
  messageConversationId?: string;
  messageDirection?: Message["direction"];
  messageSource?: Message["source"];
  messageUpstreamMessageId?: string | null;
  messageContent?: MessageContent;
  messageState?: MessageState;
  messageCanonicalErrorCode?: string | null;
  messageCreatedAt?: Date;
  messageUpdatedAt?: Date;
  contactId?: string;
  contactOrganizationId?: string;
  contactExternalId?: string;
  contactDisplayName?: string | null;
  contactConsentStatus?: ConsentStatus;
  contactConsentUpdatedAt?: Date | null;
  contactSuppressedAt?: Date | null;
  contactCreatedAt?: Date;
  contactUpdatedAt?: Date;
  channelId?: string;
  channelOrganizationId?: string;
  channelProviderAccountId?: string;
  channelProvider?: "META" | "BAILEYS";
  channelInstanceId?: string | null;
  channelPhoneNumberId?: string;
  channelWabaId?: string;
  channelCredentialReference?: string;
  channelBotPublicId?: string | null;
  channelBotOriginReference?: string | null;
  channelCreatedAt?: Date;
  channelUpdatedAt?: Date;
  metaChannelReady?: boolean;
  requiresOptIn?: boolean;
  mode?: ConversationMode;
}

interface BotClaimDatabaseRow extends ClaimDatabaseRow {
  conversation?: Conversation;
  conversationId?: string;
  conversationOrganizationId?: string;
  conversationChannelId?: string;
  conversationContactId?: string;
  conversationMode?: ConversationMode;
  conversationBotPublicId?: string | null;
  conversationBotOriginReference?: string | null;
  conversationTypebotSessionId?: string | null;
  conversationCreatedAt?: Date;
  conversationUpdatedAt?: Date;
}

const MESSAGE_COLUMNS = `
  id, organization_id AS "organizationId", channel_id AS "channelId",
  conversation_id AS "conversationId", direction, source,
  upstream_message_id AS "upstreamMessageId", content, state,
  canonical_error_code AS "canonicalErrorCode",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const QUALIFIED_MESSAGE_COLUMNS = `
  message.id, message.organization_id AS "organizationId",
  message.channel_id AS "channelId", message.conversation_id AS "conversationId",
  message.direction, message.source,
  message.upstream_message_id AS "upstreamMessageId", message.content, message.state,
  message.canonical_error_code AS "canonicalErrorCode",
  message.created_at AS "createdAt", message.updated_at AS "updatedAt"
`;

const CHANNEL_COLUMNS = `
  id, organization_id AS "organizationId", provider_account_id AS "providerAccountId",
  provider, instance_id AS "instanceId",
  phone_number_id AS "phoneNumberId", waba_id AS "wabaId",
  credential_reference AS "credentialReference", bot_public_id AS "botPublicId",
  bot_origin_reference AS "botOriginReference",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const CONTACT_COLUMNS = `
  id, organization_id AS "organizationId", external_id AS "externalId",
  display_name AS "displayName", consent_status AS "consentStatus",
  consent_updated_at AS "consentUpdatedAt", suppressed_at AS "suppressedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const CONVERSATION_COLUMNS = `
  id, organization_id AS "organizationId", channel_id AS "channelId",
  contact_id AS "contactId", mode, bot_public_id AS "botPublicId",
  bot_origin_reference AS "botOriginReference",
  typebot_session_id AS "typebotSessionId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const CLAIM_COLUMNS = `
  message.id AS "messageId", message.organization_id AS "messageOrganizationId",
  message.channel_id AS "messageChannelId", message.conversation_id AS "messageConversationId",
  message.direction AS "messageDirection", message.source AS "messageSource",
  message.upstream_message_id AS "messageUpstreamMessageId",
  message.content AS "messageContent", message.state AS "messageState",
  message.canonical_error_code AS "messageCanonicalErrorCode",
  message.created_at AS "messageCreatedAt", message.updated_at AS "messageUpdatedAt",
  contact.id AS "contactId", contact.organization_id AS "contactOrganizationId",
  contact.external_id AS "contactExternalId", contact.display_name AS "contactDisplayName",
  contact.consent_status AS "contactConsentStatus",
  contact.consent_updated_at AS "contactConsentUpdatedAt",
  contact.suppressed_at AS "contactSuppressedAt",
  contact.created_at AS "contactCreatedAt", contact.updated_at AS "contactUpdatedAt",
  channel.id AS "channelId", channel.organization_id AS "channelOrganizationId",
  channel.provider_account_id AS "channelProviderAccountId",
  channel.provider AS "channelProvider", channel.instance_id AS "channelInstanceId",
  channel.phone_number_id AS "channelPhoneNumberId", channel.waba_id AS "channelWabaId",
  channel.credential_reference AS "channelCredentialReference",
  channel.bot_public_id AS "channelBotPublicId",
  channel.bot_origin_reference AS "channelBotOriginReference",
  channel.created_at AS "channelCreatedAt", channel.updated_at AS "channelUpdatedAt",
  outbox.lease_token AS "leaseToken", outbox.attempt_count AS "attemptCount"
`;

const BOT_CLAIM_COLUMNS = `
  ${CLAIM_COLUMNS},
  conversation.id AS "conversationId",
  conversation.organization_id AS "conversationOrganizationId",
  conversation.channel_id AS "conversationChannelId",
  conversation.contact_id AS "conversationContactId",
  conversation.mode AS "conversationMode",
  conversation.bot_public_id AS "conversationBotPublicId",
  conversation.bot_origin_reference AS "conversationBotOriginReference",
  conversation.typebot_session_id AS "conversationTypebotSessionId",
  conversation.created_at AS "conversationCreatedAt",
  conversation.updated_at AS "conversationUpdatedAt"
`;

function first<T>(result: { rows: T[] }): T | null {
  return result.rows[0] ?? null;
}

async function lockMetaStatusKey(
  transaction: TenantTransaction,
  organizationId: string,
  channelId: string,
  upstreamMessageId: string,
): Promise<void> {
  await transaction.query(
    `SELECT pg_advisory_xact_lock(
              hashtextextended(concat_ws(chr(31), $1::text, $2::text, $3::text), 0)
            )`,
    [organizationId, channelId, upstreamMessageId],
  );
}

function asMessage(row: MessageDatabaseRow): Message {
  const { idempotencyBodyHash: _idempotencyBodyHash, ...message } = row;
  return message;
}

function asClaim(row: ClaimDatabaseRow): OutboxClaim {
  if (row.message && row.contact && row.channel) {
    return {
      message: row.message,
      contact: row.contact,
      channel: row.channel,
      leaseToken: row.leaseToken,
      attemptCount: row.attemptCount,
    };
  }
  return {
    message: {
      id: row.messageId!,
      organizationId: row.messageOrganizationId!,
      channelId: row.messageChannelId!,
      conversationId: row.messageConversationId!,
      direction: row.messageDirection!,
      source: row.messageSource!,
      upstreamMessageId: row.messageUpstreamMessageId ?? null,
      content: row.messageContent!,
      state: row.messageState!,
      canonicalErrorCode: row.messageCanonicalErrorCode ?? null,
      createdAt: row.messageCreatedAt!,
      updatedAt: row.messageUpdatedAt!,
    },
    contact: {
      id: row.contactId!,
      organizationId: row.contactOrganizationId!,
      externalId: row.contactExternalId!,
      displayName: row.contactDisplayName ?? null,
      consentStatus: row.contactConsentStatus!,
      consentUpdatedAt: row.contactConsentUpdatedAt ?? null,
      suppressedAt: row.contactSuppressedAt ?? null,
      createdAt: row.contactCreatedAt!,
      updatedAt: row.contactUpdatedAt!,
    },
    channel: {
      id: row.channelId!,
      organizationId: row.channelOrganizationId!,
      provider: row.channelProvider ?? "META",
      instanceId: row.channelInstanceId ?? null,
      providerAccountId: row.channelProviderAccountId!,
      phoneNumberId: row.channelPhoneNumberId!,
      wabaId: row.channelWabaId!,
      credentialReference: row.channelCredentialReference!,
      botPublicId: row.channelBotPublicId ?? null,
      botOriginReference: row.channelBotOriginReference ?? null,
      createdAt: row.channelCreatedAt!,
      updatedAt: row.channelUpdatedAt!,
    },
    leaseToken: row.leaseToken,
    attemptCount: row.attemptCount,
  };
}

function asBotClaim(row: BotClaimDatabaseRow): BotTurnClaim {
  if (row.message && row.conversation && row.contact && row.channel) {
    return {
      message: row.message,
      conversation: row.conversation,
      contact: row.contact,
      channel: row.channel,
      leaseToken: row.leaseToken,
    };
  }
  const claim = asClaim(row);
  return {
    message: claim.message,
    contact: claim.contact,
    channel: claim.channel,
    leaseToken: row.leaseToken,
    conversation: {
      id: row.conversationId!,
      organizationId: row.conversationOrganizationId!,
      channelId: row.conversationChannelId!,
      contactId: row.conversationContactId!,
      mode: row.conversationMode!,
      botPublicId: row.conversationBotPublicId ?? null,
      botOriginReference: row.conversationBotOriginReference ?? null,
      typebotSessionId: row.conversationTypebotSessionId ?? null,
      createdAt: row.conversationCreatedAt!,
      updatedAt: row.conversationUpdatedAt!,
    },
  };
}

export interface MessagingRepository {
  createChannel(
    transaction: TenantTransaction,
    input: {
      id: string;
      organizationId: string;
      providerAccountId: string;
      phoneNumberId: string;
      wabaId: string;
      credentialReference: string;
      botPublicId: string | null;
      botOriginReference: string | null;
    },
  ): Promise<MessagingChannel>;
  listChannels(
    transaction: TenantTransaction,
    organizationId: string,
  ): Promise<MessagingChannel[]>;
  findChannel(
    transaction: TenantTransaction,
    organizationId: string,
    channelId: string,
  ): Promise<MessagingChannel | null>;
  setChannelBot(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      channelId: string;
      botPublicId: string | null;
      botOriginReference: string | null;
    },
  ): Promise<MessagingChannel>;
  upsertContact(
    transaction: TenantTransaction,
    input: {
      id: string;
      organizationId: string;
      externalId: string;
      displayName: string | null;
      consentStatus: ConsentStatus;
      consentUpdatedAt: Date | null;
    },
  ): Promise<MessagingContact>;
  setContactMessagingPolicy(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      contactId: string;
      consentStatus: ConsentStatus;
      consentUpdatedAt: Date | null;
      suppressedAt: Date | null;
    },
  ): Promise<MessagingContact>;
  getOrCreateConversation(
    transaction: TenantTransaction,
    input: {
      id: string;
      organizationId: string;
      channelId: string;
      contactId: string;
    },
  ): Promise<Conversation>;
  findConversation(
    transaction: TenantTransaction,
    organizationId: string,
    conversationId: string,
  ): Promise<Conversation | null>;
  listConversations(
    transaction: TenantTransaction,
    organizationId: string,
    channelId: string,
    limit: number,
  ): Promise<ConversationListItem[]>;
  listConversationMessages(
    transaction: TenantTransaction,
    organizationId: string,
    conversationId: string,
    limit: number,
  ): Promise<Message[]>;
  findMessageByUpstream(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      channelId: string;
      upstreamMessageId: string;
    },
  ): Promise<Message | null>;
  setConversationMode(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      conversationId: string;
      mode: ConversationMode;
    },
  ): Promise<Conversation>;
  enqueueOutgoing(
    transaction: TenantTransaction,
    input: EnqueueOutgoingInput,
  ): Promise<{ kind: "created" | "replayed"; message: Message }>;
  recordIncoming(
    transaction: TenantTransaction,
    input: {
      id: string;
      organizationId: string;
      channelId: string;
      conversationId: string;
      webhookEventKey: string;
      upstreamMessageId: string;
      content: MessageContent;
      occurredAt?: Date;
    },
  ): Promise<{
    kind: "created" | "duplicate";
    message: Message;
    botScheduled: boolean;
  }>;
  recordStatusEvent(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      channelId: string;
      upstreamMessageId: string;
      state: "SENT" | "DELIVERED" | "READ" | "FAILED";
      canonicalErrorCode?: string | null;
      occurredAt?: Date;
    },
  ): Promise<{ kind: "recorded" | "duplicate"; message: Message | null }>;
  bindTypebotSession(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      conversationId: string;
      botPublicId: string;
      botOriginReference: string;
      typebotSessionId: string;
    },
  ): Promise<Conversation>;
  claimOutgoing(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      workerId: string;
      now: Date;
      leaseMs: number;
      limit: number;
    },
  ): Promise<OutboxClaim[]>;
  validateClaim(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      messageId: string;
      leaseToken: string;
      now?: Date;
    },
  ): Promise<ClaimValidation>;
  completeSend(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      messageId: string;
      leaseToken: string;
      outcome: CompleteSendOutcome;
    },
  ): Promise<Message>;
  retrySafeFailure(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      messageId: string;
      notBefore: Date;
    },
  ): Promise<Message>;
  advanceMessageState(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      messageId: string;
      state: MessageState;
      canonicalErrorCode?: string | null;
    },
  ): Promise<Message>;
  claimBotTurn(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      workerId: string;
      now: Date;
      leaseMs: number;
    },
  ): Promise<BotTurnClaim | null>;
  completeBotTurn(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      messageId: string;
      leaseToken: string;
      sessionId: string;
      texts: string[];
      now?: Date;
    },
  ): Promise<BotTurnCompletion>;
  failBotTurn(
    transaction: TenantTransaction,
    input: {
      organizationId: string;
      messageId: string;
      leaseToken: string;
      canonicalErrorCode: string;
      uncertain?: boolean;
    },
  ): Promise<"FAILED" | "UNKNOWN">;
}

export function createPostgresMessagingRepository(): MessagingRepository {
  return {
    async createChannel(transaction, input) {
      const result = await transaction.query<ChannelDatabaseRow>(
        `INSERT INTO messaging_channels
           (id, organization_id, provider_account_id, phone_number_id, waba_id,
            credential_reference, bot_public_id, bot_origin_reference)
         SELECT $1, $2, account.id, $4, $5, $6, $7, $8
           FROM provider_accounts account
          WHERE account.organization_id = $2 AND account.id = $3
            AND account.provider = 'META'
            AND account.credential_reference = $6
         RETURNING ${CHANNEL_COLUMNS}`,
        [
          input.id,
          input.organizationId,
          input.providerAccountId,
          input.phoneNumberId,
          input.wabaId,
          input.credentialReference,
          input.botPublicId,
          input.botOriginReference,
        ],
      );
      const row = first(result);
      if (!row)
        throw new MessagingRepositoryError("PROVIDER_ACCOUNT_NOT_FOUND", 404);
      return row;
    },

    async listChannels(transaction, organizationId) {
      return (
        await transaction.query<ChannelDatabaseRow>(
          `SELECT ${CHANNEL_COLUMNS} FROM messaging_channels
          WHERE organization_id = $1 ORDER BY created_at DESC, id DESC`,
          [organizationId],
        )
      ).rows;
    },

    async findChannel(transaction, organizationId, channelId) {
      return first(
        await transaction.query<ChannelDatabaseRow>(
          `SELECT ${CHANNEL_COLUMNS} FROM messaging_channels
          WHERE organization_id = $1 AND id = $2`,
          [organizationId, channelId],
        ),
      );
    },

    async setChannelBot(transaction, input) {
      if (input.botPublicId !== null) {
        await transaction.query("select pg_advisory_xact_lock(hashtextextended('flow-inbox:'||$1,0))", [input.organizationId]);
        const conflict = await transaction.query(`select 1 from flow_chatwoot_bindings b join chatwoot_connections c
          on c.organization_id=b.organization_id and c.inbox_id=b.inbox_id
          where c.organization_id=$1 and c.channel_id=$2 and c.status<>'DISABLED' and b.status<>'DISABLED'`, [input.organizationId, input.channelId]);
        if (conflict.rowCount) throw new MessagingRepositoryError('FLOW_INBOX_HAS_AUTOMATION', 409);
      }
      if (
        (input.botPublicId === null) !==
        (input.botOriginReference === null)
      ) {
        throw new MessagingRepositoryError("INVALID_BOT_CONFIGURATION", 422);
      }
      const current = first(
        await transaction.query<ChannelDatabaseRow>(
          `SELECT ${CHANNEL_COLUMNS} FROM messaging_channels
          WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [input.organizationId, input.channelId],
        ),
      );
      if (!current)
        throw new MessagingRepositoryError("CHANNEL_NOT_FOUND", 404);
      if (
        current.botPublicId === input.botPublicId &&
        current.botOriginReference === input.botOriginReference
      ) {
        return current;
      }
      const updated = first(
        await transaction.query<ChannelDatabaseRow>(
          `UPDATE messaging_channels
            SET bot_public_id = $3, bot_origin_reference = $4, updated_at = now()
          WHERE organization_id = $1 AND id = $2
        RETURNING ${CHANNEL_COLUMNS}`,
          [
            input.organizationId,
            input.channelId,
            input.botPublicId,
            input.botOriginReference,
          ],
        ),
      );
      await transaction.query(
        `UPDATE messaging_conversations
            SET bot_public_id = $3, bot_origin_reference = $4,
                typebot_session_id = NULL, updated_at = now()
          WHERE organization_id = $1 AND channel_id = $2`,
        [
          input.organizationId,
          input.channelId,
          input.botPublicId,
          input.botOriginReference,
        ],
      );
      await transaction.query(
        `UPDATE messaging_bot_jobs job
            SET status = CASE
                  WHEN job.status = 'RUNNING' THEN 'UNKNOWN'::messaging_bot_job_status
                  ELSE 'PAUSED'::messaging_bot_job_status
                END,
                lease_token = NULL, lease_expires_at = NULL,
                canonical_error_code = 'BOT_CONFIGURATION_CHANGED', updated_at = now()
           FROM messaging_conversations conversation
          WHERE job.organization_id = $1
            AND job.status IN ('PENDING', 'RUNNING')
            AND conversation.organization_id = job.organization_id
            AND conversation.id = job.conversation_id
            AND conversation.channel_id = $2`,
        [input.organizationId, input.channelId],
      );
      return updated!;
    },

    async upsertContact(transaction, input) {
      const result = await transaction.query<ContactDatabaseRow>(
        `INSERT INTO messaging_contacts
           (id, organization_id, external_id, display_name, consent_status, consent_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, external_id) DO UPDATE
           SET display_name = COALESCE(EXCLUDED.display_name, messaging_contacts.display_name),
               updated_at = now()
         RETURNING ${CONTACT_COLUMNS}`,
        [
          input.id,
          input.organizationId,
          input.externalId,
          input.displayName,
          input.consentStatus,
          input.consentUpdatedAt,
        ],
      );
      return first(result)!;
    },

    async setContactMessagingPolicy(transaction, input) {
      const result = await transaction.query<ContactDatabaseRow>(
        `UPDATE messaging_contacts
            SET consent_status = $3, consent_updated_at = $4,
                suppressed_at = $5, updated_at = now()
          WHERE organization_id = $1 AND id = $2
        RETURNING ${CONTACT_COLUMNS}`,
        [
          input.organizationId,
          input.contactId,
          input.consentStatus,
          input.consentUpdatedAt,
          input.suppressedAt,
        ],
      );
      const row = first(result);
      if (!row)
        throw new MessagingRepositoryError("CONVERSATION_NOT_FOUND", 404);
      return row;
    },

    async getOrCreateConversation(transaction, input) {
      const result = await transaction.query<ConversationDatabaseRow>(
        `INSERT INTO messaging_conversations
           (id, organization_id, channel_id, contact_id, bot_public_id, bot_origin_reference)
         SELECT $1, $2, channel.id, contact.id,
                channel.bot_public_id, channel.bot_origin_reference
           FROM messaging_channels channel
           JOIN messaging_contacts contact ON contact.organization_id = channel.organization_id
          WHERE channel.organization_id = $2 AND channel.id = $3 AND contact.id = $4
         ON CONFLICT (organization_id, channel_id, contact_id) DO UPDATE
           SET updated_at = messaging_conversations.updated_at
         RETURNING ${CONVERSATION_COLUMNS}`,
        [input.id, input.organizationId, input.channelId, input.contactId],
      );
      const row = first(result);
      if (!row) throw new MessagingRepositoryError("CHANNEL_NOT_FOUND", 404);
      return row;
    },

    async findConversation(transaction, organizationId, conversationId) {
      return first(
        await transaction.query<ConversationDatabaseRow>(
          `SELECT ${CONVERSATION_COLUMNS} FROM messaging_conversations
          WHERE organization_id = $1 AND id = $2`,
          [organizationId, conversationId],
        ),
      );
    },

    async listConversations(transaction, organizationId, channelId, limit) {
      const result = await transaction.query<
        ConversationDatabaseRow &
          QueryResultRow & {
            contact: MessagingContact;
            lastMessageAt: Date | null;
          }
      >(
        `SELECT conversation.id, conversation.organization_id AS "organizationId",
                conversation.channel_id AS "channelId", conversation.contact_id AS "contactId",
                conversation.mode, conversation.bot_public_id AS "botPublicId",
                conversation.bot_origin_reference AS "botOriginReference",
                conversation.typebot_session_id AS "typebotSessionId",
                conversation.created_at AS "createdAt", conversation.updated_at AS "updatedAt",
                jsonb_build_object(
                  'id', contact.id, 'organizationId', contact.organization_id,
                  'externalId', contact.external_id, 'displayName', contact.display_name,
                  'consentStatus', contact.consent_status,
                  'consentUpdatedAt', contact.consent_updated_at,
                  'suppressedAt', contact.suppressed_at,
                  'createdAt', contact.created_at, 'updatedAt', contact.updated_at
                ) AS contact,
                latest.created_at AS "lastMessageAt"
           FROM messaging_conversations conversation
           JOIN messaging_contacts contact
             ON contact.organization_id = conversation.organization_id
            AND contact.id = conversation.contact_id
           LEFT JOIN LATERAL (
             SELECT created_at FROM messaging_messages message
              WHERE message.organization_id = conversation.organization_id
                AND message.conversation_id = conversation.id
              ORDER BY sequence_number DESC LIMIT 1
           ) latest ON true
          WHERE conversation.organization_id = $1 AND conversation.channel_id = $2
          ORDER BY latest.created_at DESC NULLS LAST, conversation.updated_at DESC, conversation.id DESC
          LIMIT $3`,
        [organizationId, channelId, limit],
      );
      return result.rows;
    },

    async listConversationMessages(
      transaction,
      organizationId,
      conversationId,
      limit,
    ) {
      return (
        await transaction.query<MessageDatabaseRow>(
          `SELECT ${MESSAGE_COLUMNS}, EXISTS(SELECT 1 FROM messaging_outbox o WHERE o.organization_id=message_page.organization_id AND o.message_id=message_page.id AND o.retry_safe AND message_page.state='FAILED') AS "retrySafe"
           FROM (
             SELECT * FROM messaging_messages
              WHERE organization_id = $1 AND conversation_id = $2
              ORDER BY sequence_number DESC LIMIT $3
           ) message_page
          ORDER BY sequence_number`,
          [organizationId, conversationId, limit],
        )
      ).rows.map(asMessage);
    },

    async findMessageByUpstream(transaction, input) {
      const row = first(
        await transaction.query<MessageDatabaseRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messaging_messages
          WHERE organization_id = $1 AND channel_id = $2 AND upstream_message_id = $3`,
          [input.organizationId, input.channelId, input.upstreamMessageId],
        ),
      );
      return row ? asMessage(row) : null;
    },

    async setConversationMode(transaction, input) {
      const result = await transaction.query<ConversationDatabaseRow>(
        `UPDATE messaging_conversations SET mode = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2
        RETURNING ${CONVERSATION_COLUMNS}`,
        [input.organizationId, input.conversationId, input.mode],
      );
      const row = first(result);
      if (!row)
        throw new MessagingRepositoryError("CONVERSATION_NOT_FOUND", 404);
      if (input.mode === "HUMAN") {
        await transaction.query(
          `WITH cancelled AS (
             UPDATE messaging_messages
                SET state = 'FAILED', canonical_error_code = 'CONVERSATION_PAUSED',
                    updated_at = now()
              WHERE organization_id = $1 AND conversation_id = $2
                AND direction = 'OUTGOING' AND source = 'AUTOMATION'
                AND state = 'ACCEPTED'
             RETURNING organization_id, id
           )
           DELETE FROM messaging_outbox outbox
            USING cancelled
            WHERE outbox.organization_id = cancelled.organization_id
              AND outbox.message_id = cancelled.id`,
          [input.organizationId, input.conversationId],
        );
      }
      return row;
    },

    async enqueueOutgoing(transaction, input) {
      const requireOptIn =
        input.content.type === "TEMPLATE" || input.policy.requireOptIn;
      const existingResult = await transaction.query<MessageDatabaseRow>(
        `SELECT ${MESSAGE_COLUMNS}, idempotency_body_hash AS "idempotencyBodyHash"
           FROM messaging_messages
          WHERE organization_id = $1 AND channel_id = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [input.organizationId, input.channelId, input.idempotencyKey],
      );
      const existing = first(existingResult);
      if (existing) {
        if (existing.idempotencyBodyHash !== input.bodyHash) {
          throw new MessagingRepositoryError("IDEMPOTENCY_CONFLICT", 409);
        }
        return { kind: "replayed", message: asMessage(existing) };
      }

      const policyResult = await transaction.query<EnqueuePolicyRow>(
        `SELECT contact.consent_status AS "consentStatus",
                contact.suppressed_at AS "suppressedAt", conversation.mode
           FROM messaging_conversations conversation
           JOIN messaging_contacts contact
             ON contact.organization_id = conversation.organization_id
            AND contact.id = conversation.contact_id
          WHERE conversation.organization_id = $1
            AND conversation.id = $2
            AND conversation.channel_id = $3
          FOR UPDATE OF conversation, contact`,
        [input.organizationId, input.conversationId, input.channelId],
      );
      const policy = first(policyResult);
      if (!policy)
        throw new MessagingRepositoryError("CONVERSATION_NOT_FOUND", 404);
      if (policy.suppressedAt) {
        throw new MessagingRepositoryError("CONTACT_SUPPRESSED", 422);
      }
      if (
        policy.consentStatus === "OPTED_OUT" ||
        (requireOptIn && policy.consentStatus !== "OPTED_IN")
      ) {
        throw new MessagingRepositoryError("CONTACT_CONSENT_REQUIRED", 422);
      }
      if (input.source === "AUTOMATION" && policy.mode === "HUMAN") {
        throw new MessagingRepositoryError("CONVERSATION_PAUSED", 422);
      }

      const insertedResult = await transaction.query<MessageDatabaseRow>(
        `WITH inserted_message AS (
           INSERT INTO messaging_messages
             (id, organization_id, channel_id, conversation_id, direction, source,
              content, state, idempotency_key, idempotency_body_hash,
              requires_opt_in)
           VALUES ($1, $2, $3, $4, 'OUTGOING', $5, $6::jsonb, 'ACCEPTED', $7, $8, $9)
           ON CONFLICT (organization_id, channel_id, idempotency_key)
             WHERE idempotency_key IS NOT NULL
           DO NOTHING
           RETURNING *
         ), inserted_outbox AS (
           INSERT INTO messaging_outbox (organization_id, message_id)
           SELECT organization_id, id FROM inserted_message
         )
         SELECT ${MESSAGE_COLUMNS} FROM inserted_message`,
        [
          input.id,
          input.organizationId,
          input.channelId,
          input.conversationId,
          input.source,
          JSON.stringify(input.content),
          input.idempotencyKey,
          input.bodyHash,
          requireOptIn,
        ],
      );
      const inserted = first(insertedResult);
      if (!inserted) {
        const racedResult = await transaction.query<MessageDatabaseRow>(
          `SELECT ${MESSAGE_COLUMNS}, idempotency_body_hash AS "idempotencyBodyHash"
             FROM messaging_messages
            WHERE organization_id = $1 AND channel_id = $2 AND idempotency_key = $3`,
          [input.organizationId, input.channelId, input.idempotencyKey],
        );
        const raced = first(racedResult);
        if (!raced || raced.idempotencyBodyHash !== input.bodyHash) {
          throw new MessagingRepositoryError("IDEMPOTENCY_CONFLICT", 409);
        }
        return { kind: "replayed", message: asMessage(raced) };
      }
      return { kind: "created", message: asMessage(inserted) };
    },

    async recordIncoming(transaction, input) {
      const eventResult = await transaction.query<
        { id: string } & QueryResultRow
      >(
        `INSERT INTO messaging_inbox_events
           (organization_id, channel_id, event_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, channel_id, event_key) DO NOTHING
         RETURNING id`,
        [input.organizationId, input.channelId, input.webhookEventKey],
      );
      if (eventResult.rows.length === 0) {
        const duplicateResult = await transaction.query<MessageDatabaseRow>(
          `SELECT ${QUALIFIED_MESSAGE_COLUMNS}
             FROM messaging_inbox_events event
             JOIN messaging_messages message
               ON message.organization_id = event.organization_id
              AND message.channel_id = event.channel_id
              AND message.id = event.message_id
            WHERE event.organization_id = $1
              AND event.channel_id = $2
              AND event.event_key = $3`,
          [input.organizationId, input.channelId, input.webhookEventKey],
        );
        const duplicate = first(duplicateResult);
        if (!duplicate)
          throw new MessagingRepositoryError("MESSAGE_NOT_FOUND", 404);
        const scheduled = await transaction.query(
          `SELECT 1 FROM messaging_bot_jobs WHERE organization_id = $1 AND message_id = $2`,
          [input.organizationId, duplicate.id],
        );
        return {
          kind: "duplicate",
          message: asMessage(duplicate),
          botScheduled: scheduled.rows.length === 1,
        };
      }
      const insertedResult = await transaction.query<MessageDatabaseRow>(
        `INSERT INTO messaging_messages
           (id, organization_id, channel_id, conversation_id, direction, source,
            upstream_message_id, content, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'INCOMING', 'CONTACT', $5, $6::jsonb, 'DELIVERED',
                 COALESCE($7::timestamptz, now()), COALESCE($7::timestamptz, now()))
         ON CONFLICT (organization_id, channel_id, upstream_message_id)
           WHERE upstream_message_id IS NOT NULL
         DO NOTHING
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          input.id,
          input.organizationId,
          input.channelId,
          input.conversationId,
          input.upstreamMessageId,
          JSON.stringify(input.content),
          input.occurredAt ?? null,
        ],
      );
      let message = first(insertedResult);
      let kind: "created" | "duplicate" = "created";
      if (!message) {
        kind = "duplicate";
        message = first(
          await transaction.query<MessageDatabaseRow>(
            `SELECT ${MESSAGE_COLUMNS} FROM messaging_messages
            WHERE organization_id = $1 AND channel_id = $2 AND upstream_message_id = $3`,
            [input.organizationId, input.channelId, input.upstreamMessageId],
          ),
        );
      }
      if (!message)
        throw new MessagingRepositoryError("MESSAGE_NOT_FOUND", 404);
      await transaction.query(
        `UPDATE messaging_inbox_events SET message_id = $4
          WHERE organization_id = $1 AND channel_id = $2 AND event_key = $3`,
        [
          input.organizationId,
          input.channelId,
          input.webhookEventKey,
          message.id,
        ],
      );
      const scheduled = await transaction.query<
        { scheduled: boolean } & QueryResultRow
      >(
        `INSERT INTO messaging_bot_jobs (organization_id, message_id, conversation_id)
         SELECT message.organization_id, message.id, conversation.id
           FROM messaging_messages message
           JOIN messaging_conversations conversation
             ON conversation.organization_id = message.organization_id
            AND conversation.id = message.conversation_id
          WHERE message.organization_id = $1 AND message.id = $2
            AND conversation.mode = 'BOT'
            AND conversation.bot_public_id IS NOT NULL
            AND conversation.bot_origin_reference IS NOT NULL
            AND message.content->>'type' = 'TEXT'
         ON CONFLICT (organization_id, message_id) DO NOTHING
         RETURNING true AS scheduled`,
        [input.organizationId, message.id],
      );
      return {
        kind,
        message: asMessage(message),
        botScheduled: scheduled.rows.length === 1,
      };
    },

    async recordStatusEvent(transaction, input) {
      await lockMetaStatusKey(
        transaction,
        input.organizationId,
        input.channelId,
        input.upstreamMessageId,
      );
      const inserted = await transaction.query<{ id: string } & QueryResultRow>(
        `INSERT INTO messaging_status_events
           (organization_id, channel_id, upstream_message_id, state,
            canonical_error_code, occurred_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
         ON CONFLICT (organization_id, channel_id, upstream_message_id, state) DO NOTHING
         RETURNING id`,
        [
          input.organizationId,
          input.channelId,
          input.upstreamMessageId,
          input.state,
          input.canonicalErrorCode ?? null,
          input.occurredAt ?? null,
        ],
      );
      const kind =
        inserted.rows.length === 1
          ? ("recorded" as const)
          : ("duplicate" as const);
      const current = first(
        await transaction.query<MessageDatabaseRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messaging_messages
          WHERE organization_id = $1 AND channel_id = $2 AND upstream_message_id = $3
          FOR UPDATE`,
          [input.organizationId, input.channelId, input.upstreamMessageId],
        ),
      );
      if (!current) return { kind, message: null };
      if (
        !canAdvanceMessageState(current.state, input.state) ||
        current.state === input.state
      ) {
        return { kind, message: asMessage(current) };
      }
      const updated = first(
        await transaction.query<MessageDatabaseRow>(
          `UPDATE messaging_messages
            SET state = $4, canonical_error_code = $5, updated_at = now()
          WHERE organization_id = $1 AND channel_id = $2 AND id = $3
        RETURNING ${MESSAGE_COLUMNS}`,
          [
            input.organizationId,
            input.channelId,
            current.id,
            input.state,
            input.canonicalErrorCode ?? null,
          ],
        ),
      );
      return { kind, message: asMessage(updated!) };
    },

    async bindTypebotSession(transaction, input) {
      const updatedResult = await transaction.query<
        Conversation & QueryResultRow
      >(
        `UPDATE messaging_conversations
            SET bot_public_id = $3, bot_origin_reference = $4,
                typebot_session_id = $5, updated_at = now()
          WHERE organization_id = $1 AND id = $2
            AND (
              (bot_public_id IS NULL AND bot_origin_reference IS NULL)
              OR (bot_public_id = $3 AND bot_origin_reference = $4)
            )
        RETURNING id, organization_id AS "organizationId", channel_id AS "channelId",
                  contact_id AS "contactId", mode,
                  bot_public_id AS "botPublicId",
                  bot_origin_reference AS "botOriginReference",
                  typebot_session_id AS "typebotSessionId",
                  created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          input.organizationId,
          input.conversationId,
          input.botPublicId,
          input.botOriginReference,
          input.typebotSessionId,
        ],
      );
      const updated = first(updatedResult);
      if (updated) return updated;

      const currentResult = await transaction.query<
        Pick<Conversation, "botPublicId" | "botOriginReference"> &
          QueryResultRow
      >(
        `SELECT bot_public_id AS "botPublicId",
                bot_origin_reference AS "botOriginReference"
           FROM messaging_conversations
          WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.conversationId],
      );
      if (!first(currentResult)) {
        throw new MessagingRepositoryError("CONVERSATION_NOT_FOUND", 404);
      }
      throw new MessagingRepositoryError("BOT_OWNERSHIP_CONFLICT", 409);
    },

    async claimOutgoing(transaction, input) {
      if (!(await isOrganizationActive(transaction, input.organizationId)))
        return [];
      await transaction.query(
        `WITH retry AS (
        UPDATE messaging_outbox o SET retry_safe=false,available_at=$2,updated_at=$2 FROM messaging_messages m
        WHERE o.organization_id=$1 AND m.organization_id=o.organization_id AND m.id=o.message_id AND m.state='FAILED'
        AND o.retry_safe AND o.attempt_count<6 AND o.lease_token IS NULL
        AND o.updated_at<= $2::timestamptz - (LEAST(300,5*power(2,o.attempt_count))*interval '1 second')
        RETURNING o.organization_id,o.message_id
      ) UPDATE messaging_messages m SET state='ACCEPTED',canonical_error_code=NULL,updated_at=$2 FROM retry
        WHERE m.organization_id=retry.organization_id AND m.id=retry.message_id`,
        [input.organizationId, input.now],
      );
      await transaction.query(
        `WITH expired AS (
           SELECT outbox.organization_id, outbox.message_id
             FROM messaging_outbox outbox
             JOIN messaging_messages message
               ON message.organization_id = outbox.organization_id AND message.id = outbox.message_id
            WHERE outbox.organization_id = $1 AND outbox.lease_expires_at <= $2
              AND message.state = 'SENDING'
            FOR UPDATE OF outbox SKIP LOCKED
         ), marked AS (
           UPDATE messaging_messages message
              SET state = 'UNKNOWN', canonical_error_code = 'SEND_LEASE_EXPIRED', updated_at = $2
             FROM expired
            WHERE message.organization_id = expired.organization_id AND message.id = expired.message_id
           RETURNING message.organization_id, message.id
         )
         DELETE FROM messaging_outbox outbox USING marked
          WHERE outbox.organization_id = marked.organization_id AND outbox.message_id = marked.id`,
        [input.organizationId, input.now],
      );
      await transaction.query(
        `UPDATE messaging_outbox outbox
            SET lease_token = NULL, lease_expires_at = NULL, updated_at = $2
           FROM messaging_messages message
          WHERE outbox.organization_id = $1 AND outbox.lease_expires_at <= $2
            AND message.organization_id = outbox.organization_id
            AND message.id = outbox.message_id AND message.state = 'ACCEPTED'`,
        [input.organizationId, input.now],
      );
      await transaction.query(
        `WITH invalid AS (
           SELECT outbox.organization_id, outbox.message_id,
                  CASE WHEN contact.suppressed_at IS NOT NULL THEN 'CONTACT_SUPPRESSED'
                       WHEN contact.consent_status = 'OPTED_OUT'
                         THEN 'CONTACT_CONSENT_REQUIRED'
                       WHEN message.requires_opt_in AND contact.consent_status <> 'OPTED_IN'
                         THEN 'CONTACT_CONSENT_REQUIRED'
                       ELSE 'CUSTOMER_SERVICE_WINDOW_CLOSED' END AS error_code
             FROM messaging_outbox outbox
             JOIN messaging_messages message
               ON message.organization_id = outbox.organization_id AND message.id = outbox.message_id
             JOIN messaging_conversations conversation
               ON conversation.organization_id = message.organization_id AND conversation.id = message.conversation_id
             JOIN messaging_contacts contact
               ON contact.organization_id = conversation.organization_id AND contact.id = conversation.contact_id
            WHERE outbox.organization_id = $1 AND outbox.lease_token IS NULL
              AND message.state = 'ACCEPTED'
              AND (contact.suppressed_at IS NOT NULL
                   OR contact.consent_status = 'OPTED_OUT'
                   OR (message.requires_opt_in AND contact.consent_status <> 'OPTED_IN')
                   OR (
                     message.content->>'type' <> 'TEMPLATE'
                     AND EXISTS (SELECT 1 FROM messaging_channels c WHERE c.organization_id=message.organization_id AND c.id=message.channel_id AND c.provider='META')
                     AND NOT EXISTS (
                       SELECT 1 FROM messaging_messages inbound
                        WHERE inbound.organization_id = message.organization_id
                          AND inbound.conversation_id = message.conversation_id
                          AND inbound.direction = 'INCOMING'
                          AND inbound.created_at <= $2
                          AND inbound.created_at > $2 - interval '24 hours'
                     )
                   ))
            FOR UPDATE OF outbox SKIP LOCKED
         ), marked AS (
           UPDATE messaging_messages message
              SET state = 'FAILED', canonical_error_code = invalid.error_code, updated_at = $2
             FROM invalid
            WHERE message.organization_id = invalid.organization_id AND message.id = invalid.message_id
           RETURNING message.organization_id, message.id
         )
         DELETE FROM messaging_outbox outbox USING marked
          WHERE outbox.organization_id = marked.organization_id AND outbox.message_id = marked.id`,
        [input.organizationId, input.now],
      );
      const result = await transaction.query<ClaimDatabaseRow>(
        `WITH candidates AS (
           SELECT outbox.organization_id, outbox.message_id
             FROM messaging_outbox outbox
             JOIN messaging_messages message
               ON message.organization_id = outbox.organization_id AND message.id = outbox.message_id
             JOIN messaging_conversations conversation
               ON conversation.organization_id = message.organization_id AND conversation.id = message.conversation_id
             JOIN messaging_contacts contact
               ON contact.organization_id = conversation.organization_id AND contact.id = conversation.contact_id
            WHERE outbox.organization_id = $1 AND outbox.lease_token IS NULL
              AND outbox.available_at <= $3 AND message.state = 'ACCEPTED'
              AND (message.content->>'type'<>'MEDIA' OR EXISTS(SELECT 1 FROM messaging_media asset WHERE asset.organization_id=message.organization_id AND asset.id=message.media_id AND asset.status IN ('READY','FAILED')))
              AND contact.suppressed_at IS NULL
              AND contact.consent_status <> 'OPTED_OUT'
              AND (NOT message.requires_opt_in OR contact.consent_status = 'OPTED_IN')
              AND (
                message.content->>'type' = 'TEMPLATE'
                OR EXISTS (SELECT 1 FROM messaging_channels c WHERE c.organization_id=message.organization_id AND c.id=message.channel_id AND c.provider='BAILEYS')
                OR EXISTS (
                  SELECT 1 FROM messaging_messages inbound
                   WHERE inbound.organization_id = message.organization_id
                     AND inbound.conversation_id = message.conversation_id
                     AND inbound.direction = 'INCOMING'
                     AND inbound.created_at <= $3
                     AND inbound.created_at > $3 - interval '24 hours'
                )
              )
              AND (message.source <> 'AUTOMATION' OR conversation.mode = 'BOT')
              AND chatwoot_channel_identity_ready(message.organization_id,message.channel_id)
              AND NOT EXISTS (
                SELECT 1 FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
                 WHERE c.organization_id=message.organization_id AND c.id=message.channel_id AND c.provider='BAILEYS' AND i.status<>'CONNECTED'
              )
              AND NOT EXISTS (
                SELECT 1 FROM messaging_messages earlier
                 LEFT JOIN messaging_outbox earlier_outbox
                   ON earlier_outbox.organization_id = earlier.organization_id
                  AND earlier_outbox.message_id = earlier.id
                WHERE earlier.organization_id = message.organization_id
                  AND earlier.conversation_id = message.conversation_id
                  AND earlier.direction = 'OUTGOING'
                  AND earlier.sequence_number < message.sequence_number
                  AND (
                    earlier.state IN ('ACCEPTED', 'SENDING', 'UNKNOWN')
                    OR earlier_outbox.message_id IS NOT NULL
                  )
              )
            ORDER BY outbox.available_at, message.sequence_number
            FOR UPDATE OF outbox SKIP LOCKED LIMIT $5
         ), leased AS (
           UPDATE messaging_outbox outbox
              SET lease_token = $2, lease_expires_at = $3 + ($4 * interval '1 millisecond'),
                  attempt_count = outbox.attempt_count + 1, updated_at = $3
             FROM candidates
            WHERE outbox.organization_id = candidates.organization_id
              AND outbox.message_id = candidates.message_id
           RETURNING outbox.*
         )
         SELECT ${CLAIM_COLUMNS}
           FROM leased outbox
           JOIN messaging_messages message
             ON message.organization_id = outbox.organization_id AND message.id = outbox.message_id
           JOIN messaging_conversations conversation
             ON conversation.organization_id = message.organization_id AND conversation.id = message.conversation_id
           JOIN messaging_contacts contact
             ON contact.organization_id = conversation.organization_id AND contact.id = conversation.contact_id
           JOIN messaging_channels channel
             ON channel.organization_id = message.organization_id AND channel.id = message.channel_id
          ORDER BY outbox.available_at, message.sequence_number`,
        [
          input.organizationId,
          input.workerId,
          input.now,
          input.leaseMs,
          input.limit,
        ],
      );
      return result.rows.map(asClaim);
    },

    async validateClaim(transaction, input) {
      if (!(await isOrganizationActive(transaction, input.organizationId))) {
        await transaction.query(
          "UPDATE messaging_outbox SET lease_token=NULL, lease_expires_at=NULL WHERE organization_id=$1 AND message_id=$2 AND lease_token=$3",
          [input.organizationId, input.messageId, input.leaseToken],
        );
        return { eligible: false, reason: "ORGANIZATION_NOT_ACTIVE" };
      }
      const selected = first(
        await transaction.query<ClaimDatabaseRow>(
          `SELECT ${CLAIM_COLUMNS}, message.requires_opt_in AS "requiresOptIn",                (channel.credential_reference NOT LIKE 'meta-db:%' OR EXISTS (
                  SELECT 1 FROM meta_connections connection
                   WHERE connection.organization_id=channel.organization_id
                     AND connection.channel_id=channel.id
                     AND 'meta-db:' || connection.id::text=channel.credential_reference
                     AND connection.phone_number_id=channel.phone_number_id
                     AND connection.waba_id=channel.waba_id
                     AND connection.status='READY' AND connection.encrypted_token IS NOT NULL
                     AND (connection.token_expires_at IS NULL OR connection.token_expires_at>now())
                )) AS "metaChannelReady",
                (channel.provider <> 'BAILEYS' OR EXISTS(SELECT 1 FROM instances i WHERE i.organization_id=channel.organization_id AND i.id=channel.instance_id AND i.status='CONNECTED')) AS "qrChannelReady",
                chatwoot_channel_identity_ready(channel.organization_id,channel.id) AS "identityReady",
                flow_output_allowed(message.organization_id,message.id) AS "flowAllowed",
                conversation.mode,
                (channel.provider = 'BAILEYS' OR message.content->>'type' = 'TEMPLATE' OR EXISTS (
                  SELECT 1 FROM messaging_messages inbound
                   WHERE inbound.organization_id = message.organization_id
                     AND inbound.conversation_id = message.conversation_id
                     AND inbound.direction = 'INCOMING'
                     AND inbound.created_at <= COALESCE($4::timestamptz, now())
                     AND inbound.created_at > COALESCE($4::timestamptz, now()) - interval '24 hours'
                )) AS "customerServiceWindowOpen"
           FROM messaging_outbox outbox
           JOIN messaging_messages message
             ON message.organization_id = outbox.organization_id AND message.id = outbox.message_id
           JOIN messaging_conversations conversation
             ON conversation.organization_id = message.organization_id AND conversation.id = message.conversation_id
           JOIN messaging_contacts contact
             ON contact.organization_id = conversation.organization_id AND contact.id = conversation.contact_id
           JOIN messaging_channels channel
             ON channel.organization_id = message.organization_id AND channel.id = message.channel_id
          WHERE outbox.organization_id = $1 AND outbox.message_id = $2
            AND outbox.lease_token = $3 AND outbox.lease_expires_at > now()
            AND message.state = 'ACCEPTED'
          FOR UPDATE OF outbox, message, conversation, contact`,
          [
            input.organizationId,
            input.messageId,
            input.leaseToken,
            input.now ?? null,
          ],
        ),
      );
      if (!selected) return { eligible: false, reason: "INVALID_OUTBOX_CLAIM" };
      const claim = asClaim(selected);
      let reason: ClaimIneligibilityReason;
      if (
        (selected as ClaimDatabaseRow & { qrChannelReady?: boolean })
          .qrChannelReady === false
      )
        reason = "QR_CHANNEL_DISCONNECTED";
      else if ((selected as ClaimDatabaseRow & { identityReady?: boolean }).identityReady === false)
        reason = 'IDENTITY_CONFIRMATION_REQUIRED';
      else if (selected.metaChannelReady === false)
        reason = "META_CHANNEL_NOT_READY";
      else if (claim.contact.suppressedAt) reason = "CONTACT_SUPPRESSED";
      else if (
        claim.contact.consentStatus === "OPTED_OUT" ||
        (selected.requiresOptIn && claim.contact.consentStatus !== "OPTED_IN")
      )
        reason = "CONTACT_CONSENT_REQUIRED";
      else if (
        (selected as ClaimDatabaseRow & { customerServiceWindowOpen?: boolean })
          .customerServiceWindowOpen === false
      ) {
        reason = "CUSTOMER_SERVICE_WINDOW_CLOSED";
      } else if (
        claim.message.source === "AUTOMATION" &&
        selected.mode === "HUMAN"
      )
        reason = "CONVERSATION_PAUSED";
      else if ((selected as ClaimDatabaseRow & {flowAllowed?:boolean}).flowAllowed===false)
        reason = "FLOW_REVOKED";
      else {
        const updated = first(
          await transaction.query<MessageDatabaseRow>(
            `UPDATE messaging_messages SET state = 'SENDING', updated_at = now()
            WHERE organization_id = $1 AND id = $2 AND state = 'ACCEPTED'
          RETURNING ${MESSAGE_COLUMNS}`,
            [input.organizationId, input.messageId],
          ),
        );
        if (!updated)
          return { eligible: false, reason: "INVALID_OUTBOX_CLAIM" };
        return {
          eligible: true,
          claim: { ...claim, message: asMessage(updated) },
        };
      }

      if (
        reason === 'IDENTITY_CONFIRMATION_REQUIRED' || reason === "CONVERSATION_PAUSED" ||
        reason === "QR_CHANNEL_DISCONNECTED"
      ) {
        await transaction.query(
          `UPDATE messaging_outbox SET lease_token = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE organization_id = $1 AND message_id = $2 AND lease_token = $3`,
          [input.organizationId, input.messageId, input.leaseToken],
        );
      } else {
        await transaction.query(
          `WITH marked AS (
             UPDATE messaging_messages SET state = 'FAILED', canonical_error_code = $4, updated_at = now()
              WHERE organization_id = $1 AND id = $2 AND state = 'ACCEPTED' RETURNING id
           ) DELETE FROM messaging_outbox
              WHERE organization_id = $1 AND message_id IN (SELECT id FROM marked) AND lease_token = $3`,
          [input.organizationId, input.messageId, input.leaseToken, reason],
        );
      }
      return { eligible: false, reason };
    },

    async completeSend(transaction, input) {
      if (input.outcome.state === "SENT") {
        const messageKey = first(
          await transaction.query<
            {
              channelId: string;
            } & QueryResultRow
          >(
            `SELECT channel_id AS "channelId" FROM messaging_messages
            WHERE organization_id = $1 AND id = $2`,
            [input.organizationId, input.messageId],
          ),
        );
        if (!messageKey)
          throw new MessagingRepositoryError("INVALID_OUTBOX_CLAIM", 409);
        await lockMetaStatusKey(
          transaction,
          input.organizationId,
          messageKey.channelId,
          input.outcome.upstreamMessageId,
        );
      }
      const owned = first(
        await transaction.query<MessageDatabaseRow>(
          `SELECT ${QUALIFIED_MESSAGE_COLUMNS} FROM messaging_messages message
           JOIN messaging_outbox outbox
             ON outbox.organization_id = message.organization_id AND outbox.message_id = message.id
          WHERE message.organization_id = $1 AND message.id = $2
            AND (
              message.state = 'SENDING'
              OR (message.state = 'ACCEPTED' AND $4::boolean)
            )
            AND outbox.lease_token = $3
          FOR UPDATE OF message, outbox`,
          [
            input.organizationId,
            input.messageId,
            input.leaseToken,
            input.outcome.state === "FAILED",
          ],
        ),
      );
      if (!owned)
        throw new MessagingRepositoryError("INVALID_OUTBOX_CLAIM", 409);
      const retrySafe =
        input.outcome.state === "FAILED" && input.outcome.retrySafe;
      const upstreamMessageId =
        input.outcome.state === "SENT" ? input.outcome.upstreamMessageId : null;
      const canonicalErrorCode =
        input.outcome.state === "SENT"
          ? null
          : input.outcome.canonicalErrorCode;
      const updated = first(
        await transaction.query<MessageDatabaseRow>(
          `UPDATE messaging_messages
            SET state = $3, upstream_message_id = COALESCE($4, upstream_message_id),
                canonical_error_code = $5, updated_at = now()
          WHERE organization_id = $1 AND id = $2
        RETURNING ${MESSAGE_COLUMNS}`,
          [
            input.organizationId,
            input.messageId,
            input.outcome.state,
            upstreamMessageId,
            canonicalErrorCode,
          ],
        ),
      );
      let completed = updated!;
      if (input.outcome.state === "SENT") {
        const pendingStatuses = await transaction.query<
          { state: MessageState } & QueryResultRow
        >(
          `SELECT state FROM messaging_status_events
            WHERE organization_id = $1 AND channel_id = $2 AND upstream_message_id = $3
            ORDER BY occurred_at, id`,
          [
            input.organizationId,
            owned.channelId,
            input.outcome.upstreamMessageId,
          ],
        );
        let reconciledState: MessageState = "SENT";
        for (const statusEvent of pendingStatuses.rows) {
          if (canAdvanceMessageState(reconciledState, statusEvent.state)) {
            reconciledState = statusEvent.state;
          }
        }
        if (reconciledState !== "SENT") {
          completed = first(
            await transaction.query<MessageDatabaseRow>(
              `UPDATE messaging_messages SET state = $3, updated_at = now()
              WHERE organization_id = $1 AND id = $2
            RETURNING ${MESSAGE_COLUMNS}`,
              [input.organizationId, input.messageId, reconciledState],
            ),
          )!;
        }
      }
      if (retrySafe) {
        await transaction.query(
          `UPDATE messaging_outbox
              SET retry_safe = true, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE organization_id = $1 AND message_id = $2`,
          [input.organizationId, input.messageId],
        );
      } else {
        await transaction.query(
          `DELETE FROM messaging_outbox WHERE organization_id = $1 AND message_id = $2`,
          [input.organizationId, input.messageId],
        );
      }
      return asMessage(completed);
    },

    async retrySafeFailure(transaction, input) {
      const result = await transaction.query<MessageDatabaseRow>(
        `WITH retry AS (
           UPDATE messaging_outbox SET retry_safe = false, available_at = $3,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE organization_id = $1 AND message_id = $2 AND retry_safe
           RETURNING organization_id, message_id
         )
         UPDATE messaging_messages message
            SET state = 'ACCEPTED', canonical_error_code = NULL, updated_at = now()
           FROM retry
          WHERE message.organization_id = retry.organization_id AND message.id = retry.message_id
            AND message.state = 'FAILED'
         RETURNING ${QUALIFIED_MESSAGE_COLUMNS}`,
        [input.organizationId, input.messageId, input.notBefore],
      );
      const row = first(result);
      if (!row)
        throw new MessagingRepositoryError("INVALID_MESSAGE_TRANSITION", 409);
      return asMessage(row);
    },

    async advanceMessageState(transaction, input) {
      const current = first(
        await transaction.query<MessageDatabaseRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messaging_messages
          WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [input.organizationId, input.messageId],
        ),
      );
      if (!current)
        throw new MessagingRepositoryError("MESSAGE_NOT_FOUND", 404);
      if (!canAdvanceMessageState(current.state, input.state)) {
        throw new MessagingRepositoryError("INVALID_MESSAGE_TRANSITION", 409);
      }
      if (current.state === input.state) return asMessage(current);
      const updated = first(
        await transaction.query<MessageDatabaseRow>(
          `UPDATE messaging_messages
            SET state = $3, canonical_error_code = $4, updated_at = now()
          WHERE organization_id = $1 AND id = $2
        RETURNING ${MESSAGE_COLUMNS}`,
          [
            input.organizationId,
            input.messageId,
            input.state,
            input.canonicalErrorCode ?? null,
          ],
        ),
      );
      return asMessage(updated!);
    },

    async claimBotTurn(transaction, input) {
      if (!(await isOrganizationActive(transaction, input.organizationId)))
        return null;
      await transaction.query(
        `UPDATE messaging_bot_jobs
            SET status = 'UNKNOWN', lease_token = NULL, lease_expires_at = NULL,
                canonical_error_code = 'BOT_LEASE_EXPIRED', updated_at = $2
          WHERE organization_id = $1 AND status = 'RUNNING' AND lease_expires_at <= $2`,
        [input.organizationId, input.now],
      );
      await transaction.query(
        `UPDATE messaging_bot_jobs job
            SET status = 'PAUSED', updated_at = $2
           FROM messaging_conversations conversation
          WHERE job.organization_id = $1 AND job.status = 'PENDING'
            AND conversation.organization_id = job.organization_id
            AND conversation.id = job.conversation_id
            AND conversation.mode = 'HUMAN'`,
        [input.organizationId, input.now],
      );
      await transaction.query(
        `UPDATE messaging_bot_jobs job
            SET status = 'FAILED', lease_token = NULL, lease_expires_at = NULL,
                canonical_error_code = CASE
                  WHEN contact.suppressed_at IS NOT NULL THEN 'CONTACT_SUPPRESSED'
                  WHEN contact.consent_status = 'OPTED_OUT' THEN 'CONTACT_OPTED_OUT'
                  ELSE 'CUSTOMER_SERVICE_WINDOW_CLOSED'
                END,
                updated_at = $2
           FROM messaging_conversations conversation
           JOIN messaging_contacts contact
             ON contact.organization_id = conversation.organization_id
            AND contact.id = conversation.contact_id
           JOIN messaging_messages message
             ON message.organization_id = conversation.organization_id
            AND message.conversation_id = conversation.id
          WHERE job.organization_id = $1 AND job.status = 'PENDING'
            AND conversation.organization_id = job.organization_id
            AND conversation.id = job.conversation_id
            AND message.id = job.message_id
            AND (
              contact.suppressed_at IS NOT NULL
              OR contact.consent_status = 'OPTED_OUT'
              OR message.created_at > $2
              OR (message.created_at <= $2 - interval '24 hours' AND EXISTS (SELECT 1 FROM messaging_channels channel WHERE channel.organization_id=message.organization_id AND channel.id=message.channel_id AND channel.provider='META'))
            )`,
        [input.organizationId, input.now],
      );
      const result = await transaction.query<BotClaimDatabaseRow>(
        `WITH candidate AS (
           SELECT job.organization_id, job.message_id
             FROM messaging_bot_jobs job
             JOIN messaging_messages job_message
               ON job_message.organization_id = job.organization_id AND job_message.id = job.message_id
            WHERE job.organization_id = $1 AND job.status = 'PENDING'
              AND job_message.created_at <= $3
              AND (job_message.created_at > $3 - interval '24 hours' OR EXISTS (SELECT 1 FROM messaging_channels channel WHERE channel.organization_id=job_message.organization_id AND channel.id=job_message.channel_id AND channel.provider='BAILEYS'))
              AND NOT EXISTS (
                SELECT 1 FROM messaging_bot_jobs blocker
                 WHERE blocker.organization_id = job.organization_id
                   AND blocker.conversation_id = job.conversation_id
                   AND blocker.status IN ('RUNNING', 'UNKNOWN')
              )
              AND NOT EXISTS (
                SELECT 1 FROM messaging_bot_jobs earlier
                 WHERE earlier.organization_id = job.organization_id
                   AND earlier.conversation_id = job.conversation_id
                   AND earlier.status = 'PENDING'
                   AND EXISTS (
                     SELECT 1 FROM messaging_messages earlier_message
                      WHERE earlier_message.organization_id = earlier.organization_id
                        AND earlier_message.id = earlier.message_id
                        AND earlier_message.sequence_number < job_message.sequence_number
                   )
              )
            ORDER BY job_message.sequence_number
            FOR UPDATE OF job SKIP LOCKED LIMIT 1
         ), claimed AS (
           UPDATE messaging_bot_jobs job
              SET status = 'RUNNING', lease_token = $2,
                  lease_expires_at = $3 + ($4 * interval '1 millisecond'), updated_at = $3
             FROM candidate
            WHERE job.organization_id = candidate.organization_id
              AND job.message_id = candidate.message_id
           RETURNING job.*
         )
         SELECT ${BOT_CLAIM_COLUMNS}
           FROM claimed bot_job
           JOIN messaging_messages message
             ON message.organization_id = bot_job.organization_id AND message.id = bot_job.message_id
           JOIN messaging_conversations conversation
             ON conversation.organization_id = bot_job.organization_id AND conversation.id = bot_job.conversation_id
           JOIN messaging_contacts contact
             ON contact.organization_id = conversation.organization_id AND contact.id = conversation.contact_id
           JOIN messaging_channels channel
             ON channel.organization_id = conversation.organization_id AND channel.id = conversation.channel_id
           CROSS JOIN LATERAL (
             SELECT bot_job.lease_token, 0::integer AS attempt_count
           ) outbox`,
        [input.organizationId, input.workerId, input.now, input.leaseMs],
      );
      const row = first(result);
      return row ? asBotClaim(row) : null;
    },

    async completeBotTurn(transaction, input) {
      const owner = first(
        await transaction.query<
          QueryResultRow & {
            mode: ConversationMode;
            suppressedAt: Date | null;
            consentStatus: ConsentStatus;
            incomingOccurredAt: Date;
            provider: "META" | "BAILEYS";
          }
        >(
          `SELECT conversation.mode, (SELECT provider FROM messaging_channels channel WHERE channel.organization_id=message.organization_id AND channel.id=message.channel_id) AS provider, contact.suppressed_at AS "suppressedAt",
                contact.consent_status AS "consentStatus",
                message.created_at AS "incomingOccurredAt"
           FROM messaging_bot_jobs job
           JOIN messaging_conversations conversation
             ON conversation.organization_id = job.organization_id AND conversation.id = job.conversation_id
           JOIN messaging_contacts contact
             ON contact.organization_id = conversation.organization_id AND contact.id = conversation.contact_id
           JOIN messaging_messages message
             ON message.organization_id = job.organization_id AND message.id = job.message_id
          WHERE job.organization_id = $1 AND job.message_id = $2
            AND job.status = 'RUNNING' AND job.lease_token = $3
          FOR UPDATE OF job, conversation, contact`,
          [input.organizationId, input.messageId, input.leaseToken],
        ),
      );
      if (!owner)
        throw new MessagingRepositoryError("INVALID_OUTBOX_CLAIM", 409);
      const completionNow = input.now ?? new Date();
      const policyFailure = owner.suppressedAt
        ? "CONTACT_SUPPRESSED"
        : owner.consentStatus === "OPTED_OUT"
          ? "CONTACT_OPTED_OUT"
          : owner.provider !== "BAILEYS" &&
              !isCustomerServiceWindowOpen(
                owner.incomingOccurredAt,
                completionNow,
              )
            ? "CUSTOMER_SERVICE_WINDOW_CLOSED"
            : null;
      if (owner.mode === "HUMAN" || policyFailure) {
        await transaction.query(
          `UPDATE messaging_bot_jobs
              SET status = $5::messaging_bot_job_status,
                  lease_token = NULL, lease_expires_at = NULL,
                  canonical_error_code = $4, updated_at = now()
            WHERE organization_id = $1 AND message_id = $2 AND lease_token = $3`,
          [
            input.organizationId,
            input.messageId,
            input.leaseToken,
            owner.mode === "HUMAN" ? "CONVERSATION_PAUSED" : policyFailure,
            owner.mode === "HUMAN" ? "PAUSED" : "FAILED",
          ],
        );
        return { kind: "paused", messages: [] };
      }

      const messages = await transaction.query<MessageDatabaseRow>(
        `WITH bound AS (
           UPDATE messaging_conversations conversation
              SET typebot_session_id = $4, updated_at = now()
             FROM messaging_bot_jobs job
            WHERE job.organization_id = $1 AND job.message_id = $2
              AND job.lease_token = $3 AND job.status = 'RUNNING'
              AND conversation.organization_id = job.organization_id
              AND conversation.id = job.conversation_id
           RETURNING conversation.organization_id, conversation.channel_id, conversation.id
         ), outputs AS (
           SELECT text, ordinality::integer AS ordinal
             FROM unnest($5::text[]) WITH ORDINALITY AS generated(text, ordinality)
            WHERE btrim(text) <> ''
         ), inserted AS (
           INSERT INTO messaging_messages
             (organization_id, channel_id, conversation_id, direction, source, content, state,
              idempotency_key, idempotency_body_hash, requires_opt_in)
           SELECT bound.organization_id, bound.channel_id, bound.id,
                  'OUTGOING', 'AUTOMATION', jsonb_build_object('type', 'TEXT', 'text', outputs.text),
                  'ACCEPTED', 'bot:' || $2::text || ':' || outputs.ordinal::text,
                  encode(digest(convert_to(outputs.text, 'UTF8'), 'sha256'), 'hex'), false
             FROM bound CROSS JOIN outputs
            ORDER BY outputs.ordinal
           ON CONFLICT (organization_id, channel_id, idempotency_key)
             WHERE idempotency_key IS NOT NULL
           DO NOTHING
           RETURNING *
         ), queued AS (
           INSERT INTO messaging_outbox (organization_id, message_id)
           SELECT organization_id, id FROM inserted
         )
         SELECT ${MESSAGE_COLUMNS} FROM inserted ORDER BY sequence_number`,
        [
          input.organizationId,
          input.messageId,
          input.leaseToken,
          input.sessionId,
          input.texts,
        ],
      );
      await transaction.query(
        `UPDATE messaging_bot_jobs
            SET status = 'COMPLETED', lease_token = NULL, lease_expires_at = NULL,
                canonical_error_code = NULL, updated_at = now()
          WHERE organization_id = $1 AND message_id = $2
            AND status = 'RUNNING' AND lease_token = $3`,
        [input.organizationId, input.messageId, input.leaseToken],
      );
      return { kind: "completed", messages: messages.rows.map(asMessage) };
    },

    async failBotTurn(transaction, input) {
      const status =
        input.uncertain === false ? ("FAILED" as const) : ("UNKNOWN" as const);
      const result = await transaction.query<
        { messageId: string } & QueryResultRow
      >(
        `UPDATE messaging_bot_jobs
            SET status = $5::messaging_bot_job_status,
                lease_token = NULL, lease_expires_at = NULL,
                canonical_error_code = $4, updated_at = now()
          WHERE organization_id = $1 AND message_id = $2
            AND status = 'RUNNING' AND lease_token = $3
        RETURNING message_id AS "messageId"`,
        [
          input.organizationId,
          input.messageId,
          input.leaseToken,
          input.canonicalErrorCode,
          status,
        ],
      );
      if (result.rows.length !== 1) {
        throw new MessagingRepositoryError("INVALID_OUTBOX_CLAIM", 409);
      }
      return status;
    },
  };
}

export type {
  BotTurnClaim,
  BotTurnCompletion,
  CompleteSendOutcome,
  ClaimValidation,
  ConsentStatus,
  Conversation,
  ConversationListItem,
  ConversationMode,
  Message,
  MessageContent,
  MessageState,
  MessagingChannel,
  MessagingContact,
  OutboxClaim,
  OutgoingMessageSource,
};
