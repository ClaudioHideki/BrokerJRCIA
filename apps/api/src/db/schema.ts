import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  index,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const organizationStatus = pgEnum("organization_status", [
  "ACTIVE",
  "SUSPENDED",
  "DISABLED",
]);
export const userStatus = pgEnum("user_status", ["ACTIVE", "DISABLED"]);
export const membershipRole = pgEnum("membership_role", [
  "OWNER",
  "ADMIN",
  "OPERATOR",
  "VIEWER",
]);
export const membershipStatus = pgEnum("membership_status", [
  "ACTIVE",
  "DISABLED",
]);
export const providerKind = pgEnum("provider_kind", ["BAILEYS", "META"]);
export const instanceStatus = pgEnum("instance_status", [
  "PROVISIONING",
  "CREATED",
  "PROVISIONING_FAILED",
  "CONNECTING",
  "AWAITING_ACTION",
  "CONNECTED",
  "DISCONNECTING",
  "DISCONNECTED",
  "ERROR",
]);
export const providerOperationStatus = pgEnum("provider_operation_status", [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);
export const idempotencyStatus = pgEnum("idempotency_status", [
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
]);
export const messagingConversationMode = pgEnum("messaging_conversation_mode", [
  "BOT",
  "HUMAN",
]);
export const messagingConsentStatus = pgEnum("messaging_consent_status", [
  "UNKNOWN",
  "OPTED_IN",
  "OPTED_OUT",
]);
export const messagingMessageDirection = pgEnum("messaging_message_direction", [
  "INCOMING",
  "OUTGOING",
]);
export const messagingMessageSource = pgEnum("messaging_message_source", [
  "CONTACT",
  "OPERATOR",
  "AUTOMATION",
]);
export const messagingMessageState = pgEnum("messaging_message_state", [
  "ACCEPTED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "UNKNOWN",
]);
export const messagingBotJobStatus = pgEnum("messaging_bot_job_status", [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "UNKNOWN",
  "PAUSED",
  "FAILED",
]);
export const messagingMessageOrderSequence = pgSequence(
  "messaging_message_order_seq",
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull().default("STANDARD"),
    status: organizationStatus("status").notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    unique("organizations_slug_unique").on(table.slug),
    check(
      "organizations_plan_check",
      sql`length(${table.plan}) BETWEEN 1 AND 80`,
    ),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: userStatus("status").notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    unique("users_email_unique").on(table.email),
    check(
      "users_email_normalized",
      sql`${table.email} = lower(btrim(${table.email}))`,
    ),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
    status: membershipStatus("status").notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: "memberships_pkey",
      columns: [table.organizationId, table.userId],
    }),
  ],
);

export const loginSessions = pgTable(
  "login_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("login_sessions_token_hash_unique").on(table.tokenHash)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("refresh_tokens_org_id_unique").on(table.organizationId, table.id),
    unique("refresh_tokens_token_hash_unique").on(table.tokenHash),
    foreignKey({
      name: "refresh_tokens_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "refresh_tokens_replacement_fk",
      columns: [table.organizationId, table.replacedById],
      foreignColumns: [table.organizationId, table.id],
    }),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHmac: text("key_hmac").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("api_keys_org_id_unique").on(table.organizationId, table.id),
    unique("api_keys_org_name_unique").on(table.organizationId, table.name),
    unique("api_keys_prefix_global_unique").on(table.prefix),
  ],
);

export const securityAuditLogs = pgTable("security_audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventType: text("event_type").notNull(),
  requestId: uuid("request_id"),
  identityDigest: text("identity_digest"),
  ipDigest: text("ip_digest"),
  outcome: text("outcome").notNull(),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    requestId: uuid("request_id"),
    outcome: text("outcome").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("audit_logs_org_id_unique").on(table.organizationId, table.id),
  ],
);

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: providerKind("provider").notNull(),
    name: text("name").notNull(),
    externalReference: text("external_reference"),
    credentialReference: text("credential_reference"),
    ...timestamps,
  },
  (table) => [
    unique("provider_accounts_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("provider_accounts_org_provider_unique").on(
      table.organizationId,
      table.provider,
    ),
    unique("provider_accounts_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export const instances = pgTable(
  "instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    providerAccountId: uuid("provider_account_id").notNull(),
    name: text("name").notNull(),
    upstreamInstanceKey: text("upstream_instance_key").notNull(),
    externalReference: text("external_reference"),
    status: instanceStatus("status").notNull().default("PROVISIONING"),
    capabilities: jsonb("capabilities")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (table) => [
    unique("instances_org_id_unique").on(table.organizationId, table.id),
    unique("instances_org_name_unique").on(table.organizationId, table.name),
    unique("instances_upstream_instance_key_unique").on(
      table.upstreamInstanceKey,
    ),
    foreignKey({
      name: "instances_provider_account_fk",
      columns: [table.organizationId, table.providerAccountId],
      foreignColumns: [providerAccounts.organizationId, providerAccounts.id],
    }).onDelete("restrict"),
  ],
);

export const providerOperations = pgTable(
  "provider_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    instanceId: uuid("instance_id").notNull(),
    operationType: text("operation_type").notNull(),
    status: providerOperationStatus("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    canonicalErrorCode: text("canonical_error_code"),
    reconciliationRequired: boolean("reconciliation_required")
      .notNull()
      .default(false),
    ...timestamps,
  },
  (table) => [
    unique("provider_operations_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      name: "provider_operations_instance_fk",
      columns: [table.organizationId, table.instanceId],
      foreignColumns: [instances.organizationId, instances.id],
    }).onDelete("cascade"),
    check(
      "provider_operations_attempt_count_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export const connectionChallenges = pgTable(
  "connection_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    instanceId: uuid("instance_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    challengeType: text("challenge_type").notNull(),
    algorithm: text("algorithm").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("connection_challenges_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      name: "connection_challenges_instance_fk",
      columns: [table.organizationId, table.instanceId],
      foreignColumns: [instances.organizationId, instances.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "connection_challenges_operation_fk",
      columns: [table.organizationId, table.operationId],
      foreignColumns: [
        providerOperations.organizationId,
        providerOperations.id,
      ],
    }).onDelete("cascade"),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    operationId: uuid("operation_id"),
    status: idempotencyStatus("status").notNull().default("IN_PROGRESS"),
    responseMetadata: jsonb("response_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique("idempotency_records_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("idempotency_records_org_route_key_unique").on(
      table.organizationId,
      table.route,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "idempotency_records_operation_fk",
      columns: [table.organizationId, table.operationId],
      foreignColumns: [
        providerOperations.organizationId,
        providerOperations.id,
      ],
    }).onDelete("restrict"),
  ],
);

export const messagingChannels = pgTable(
  "messaging_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    providerAccountId: uuid("provider_account_id").notNull(),
    provider: providerKind("provider").notNull().default("META"),
    instanceId: uuid("instance_id"),
    phoneNumberId: text("phone_number_id"),
    wabaId: text("waba_id"),
    credentialReference: text("credential_reference").notNull(),
    botPublicId: text("bot_public_id"),
    botOriginReference: text("bot_origin_reference"),
    ...timestamps,
  },
  (table) => [
    unique("messaging_channels_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("messaging_channels_org_phone_unique").on(
      table.organizationId,
      table.phoneNumberId,
    ),
    foreignKey({
      name: "messaging_channels_provider_account_fk",
      columns: [table.organizationId, table.providerAccountId],
      foreignColumns: [providerAccounts.organizationId, providerAccounts.id],
    }).onDelete("restrict"),
    check(
      "messaging_channels_bot_pair",
      sql`
    (${table.botPublicId} IS NULL AND ${table.botOriginReference} IS NULL)
    OR (${table.botPublicId} IS NOT NULL AND ${table.botOriginReference} IS NOT NULL)
  `,
    ),
    check(
      "messaging_channels_credential_reference_nonempty",
      sql`btrim(${table.credentialReference}) <> ''`,
    ),
    foreignKey({
      name: "messaging_channels_instance_fk",
      columns: [table.organizationId, table.instanceId],
      foreignColumns: [instances.organizationId, instances.id],
    }).onDelete("restrict"),
    uniqueIndex("messaging_channels_instance_unique")
      .on(table.organizationId, table.instanceId)
      .where(sql`${table.instanceId} IS NOT NULL`),
    check(
      "messaging_channels_kind_fields",
      sql`(${table.provider}='META' AND ${table.instanceId} IS NULL AND ${table.phoneNumberId} IS NOT NULL AND ${table.wabaId} IS NOT NULL) OR (${table.provider}='BAILEYS' AND ${table.instanceId} IS NOT NULL AND ${table.phoneNumberId} IS NULL AND ${table.wabaId} IS NULL)`,
    ),
  ],
);

export const messagingContacts = pgTable(
  "messaging_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    consentStatus: messagingConsentStatus("consent_status")
      .notNull()
      .default("UNKNOWN"),
    consentUpdatedAt: timestamp("consent_updated_at", { withTimezone: true }),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("messaging_contacts_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("messaging_contacts_org_external_unique").on(
      table.organizationId,
      table.externalId,
    ),
    check(
      "messaging_contacts_external_nonempty",
      sql`btrim(${table.externalId}) <> ''`,
    ),
  ],
);

export const messagingConversations = pgTable(
  "messaging_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    mode: messagingConversationMode("mode").notNull().default("BOT"),
    botPublicId: text("bot_public_id"),
    botOriginReference: text("bot_origin_reference"),
    typebotSessionId: text("typebot_session_id"),
    ...timestamps,
  },
  (table) => [
    unique("messaging_conversations_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("messaging_conversations_org_channel_id_unique").on(
      table.organizationId,
      table.channelId,
      table.id,
    ),
    unique("messaging_conversations_participants_unique").on(
      table.organizationId,
      table.channelId,
      table.contactId,
    ),
    foreignKey({
      name: "messaging_conversations_channel_fk",
      columns: [table.organizationId, table.channelId],
      foreignColumns: [messagingChannels.organizationId, messagingChannels.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "messaging_conversations_contact_fk",
      columns: [table.organizationId, table.contactId],
      foreignColumns: [messagingContacts.organizationId, messagingContacts.id],
    }).onDelete("restrict"),
    check(
      "messaging_conversations_bot_pair",
      sql`
    (${table.botPublicId} IS NULL AND ${table.botOriginReference} IS NULL)
    OR (${table.botPublicId} IS NOT NULL AND ${table.botOriginReference} IS NOT NULL)
  `,
    ),
    check(
      "messaging_conversations_session_owner",
      sql`
    ${table.typebotSessionId} IS NULL OR ${table.botPublicId} IS NOT NULL
  `,
    ),
  ],
);

export const messagingMedia = pgTable(
  "messaging_media",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type"),
    descriptor: jsonb("descriptor").notNull(),
    status: text("status").notNull().default("PENDING"),
    encryptedData: text("encrypted_data"),
    byteSize: integer("byte_size"),
    sha256: text("sha256"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.channelId, t.id),
    unique().on(t.organizationId, t.channelId, t.source, t.sourceKey),
    foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [messagingChannels.organizationId, messagingChannels.id],
    }).onDelete("restrict"),
    check(
      "messaging_media_source_check",
      sql`${t.source} IN ('QR','META','CHATWOOT')`,
    ),
    check(
      "messaging_media_source_key_check",
      sql`length(${t.sourceKey}) BETWEEN 1 AND 512`,
    ),
    check(
      "messaging_media_kind_check",
      sql`${t.kind} IN ('image','audio','video','document','sticker')`,
    ),
    check(
      "messaging_media_status_check",
      sql`${t.status} IN ('PENDING','DOWNLOADING','READY','FAILED')`,
    ),
    check(
      "messaging_media_byte_size_check",
      sql`${t.byteSize} BETWEEN 1 AND 16777216`,
    ),
    check(
      "messaging_media_check",
      sql`(${t.status}='READY' AND ${t.encryptedData} IS NOT NULL AND ${t.byteSize} IS NOT NULL AND ${t.sha256} IS NOT NULL AND ${t.mimeType} IS NOT NULL) OR (${t.status}<>'READY' AND ${t.encryptedData} IS NULL)`,
    ),
    check(
      "messaging_media_check1",
      sql`(${t.status}='DOWNLOADING' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL) OR (${t.status}<>'DOWNLOADING' AND ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL)`,
    ),
    index("messaging_media_download").on(
      t.organizationId,
      t.status,
      t.availableAt,
      t.createdAt,
    ),
  ],
);

export const messagingMessages = pgTable(
  "messaging_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    direction: messagingMessageDirection("direction").notNull(),
    source: messagingMessageSource("source").notNull(),
    upstreamMessageId: text("upstream_message_id"),
    content: jsonb("content").notNull(),
    mediaId: uuid("media_id").generatedAlwaysAs(
      sql`CASE WHEN content->>'type'='MEDIA' THEN (content->>'mediaId')::uuid END`,
    ),
    state: messagingMessageState("state").notNull(),
    canonicalErrorCode: text("canonical_error_code"),
    idempotencyKey: text("idempotency_key"),
    idempotencyBodyHash: text("idempotency_body_hash"),
    requiresOptIn: boolean("requires_opt_in").notNull().default(false),
    sequenceNumber: bigint("sequence_number", { mode: "number" })
      .notNull()
      .default(sql`nextval('messaging_message_order_seq')`),
    ...timestamps,
  },
  (table) => [
    unique("messaging_messages_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("messaging_messages_org_channel_id_unique").on(
      table.organizationId,
      table.channelId,
      table.id,
    ),
    unique("messaging_messages_org_conversation_id_unique").on(
      table.organizationId,
      table.conversationId,
      table.id,
    ),
    unique("messaging_messages_org_sequence_unique").on(
      table.organizationId,
      table.sequenceNumber,
    ),
    foreignKey({
      name: "messaging_messages_conversation_fk",
      columns: [table.organizationId, table.channelId, table.conversationId],
      foreignColumns: [
        messagingConversations.organizationId,
        messagingConversations.channelId,
        messagingConversations.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("messaging_messages_idempotency_unique")
      .on(table.organizationId, table.channelId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    uniqueIndex("messaging_messages_upstream_unique")
      .on(table.organizationId, table.channelId, table.upstreamMessageId)
      .where(sql`${table.upstreamMessageId} IS NOT NULL`),
    index("messaging_messages_conversation_order").on(
      table.organizationId,
      table.conversationId,
      table.sequenceNumber,
    ),
    check(
      "messaging_messages_direction_source",
      sql`
    (${table.direction} = 'INCOMING' AND ${table.source} = 'CONTACT')
    OR (${table.direction} = 'OUTGOING' AND ${table.source} IN ('OPERATOR', 'AUTOMATION'))
  `,
    ),
    check(
      "messaging_messages_idempotency_pair",
      sql`
    (${table.idempotencyKey} IS NULL AND ${table.idempotencyBodyHash} IS NULL)
    OR (${table.idempotencyKey} IS NOT NULL AND ${table.idempotencyBodyHash} IS NOT NULL)
  `,
    ),
    foreignKey({
      name: "messaging_messages_media_fk",
      columns: [table.organizationId, table.channelId, table.mediaId],
      foreignColumns: [
        messagingMedia.organizationId,
        messagingMedia.channelId,
        messagingMedia.id,
      ],
    }).onDelete("restrict"),
    check(
      "messaging_messages_supported_content",
      sql`COALESCE((
    (${table.content}->>'type' = 'TEXT' AND jsonb_typeof(${table.content}->'text') = 'string')
    OR (${table.content}->>'type' = 'TEMPLATE'
      AND jsonb_typeof(${table.content}->'name') = 'string'
      AND jsonb_typeof(${table.content}->'language') = 'string'
      AND jsonb_typeof(${table.content}->'variables') = 'array')
    OR (${table.content}->>'type'='MEDIA' AND jsonb_typeof(${table.content}->'mediaId')='string' AND ${table.content}->>'kind' IN ('image','audio','video','document','sticker') AND (NOT(${table.content} ? 'caption') OR jsonb_typeof(${table.content}->'caption')='string') AND jsonb_typeof(${table.content}->'fileName')='string')
  ),false)`,
    ),
  ],
);

export const messagingInboxEvents = pgTable(
  "messaging_inbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    eventKey: text("event_key").notNull(),
    messageId: uuid("message_id"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("messaging_inbox_events_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("messaging_inbox_events_dedupe_unique").on(
      table.organizationId,
      table.channelId,
      table.eventKey,
    ),
    foreignKey({
      name: "messaging_inbox_events_channel_fk",
      columns: [table.organizationId, table.channelId],
      foreignColumns: [messagingChannels.organizationId, messagingChannels.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "messaging_inbox_events_message_fk",
      columns: [table.organizationId, table.channelId, table.messageId],
      foreignColumns: [
        messagingMessages.organizationId,
        messagingMessages.channelId,
        messagingMessages.id,
      ],
    }).onDelete("restrict"),
    check(
      "messaging_inbox_events_key_nonempty",
      sql`btrim(${table.eventKey}) <> ''`,
    ),
  ],
);

export const messagingStatusEvents = pgTable(
  "messaging_status_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    upstreamMessageId: text("upstream_message_id").notNull(),
    state: messagingMessageState("state").notNull(),
    canonicalErrorCode: text("canonical_error_code"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("messaging_status_events_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("messaging_status_events_dedupe_unique").on(
      table.organizationId,
      table.channelId,
      table.upstreamMessageId,
      table.state,
    ),
    foreignKey({
      name: "messaging_status_events_channel_fk",
      columns: [table.organizationId, table.channelId],
      foreignColumns: [messagingChannels.organizationId, messagingChannels.id],
    }).onDelete("restrict"),
    check(
      "messaging_status_events_supported_state",
      sql`
    ${table.state} IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
  `,
    ),
  ],
);

export const messagingOutbox = pgTable(
  "messaging_outbox",
  {
    organizationId: uuid("organization_id").notNull(),
    messageId: uuid("message_id").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    retrySafe: boolean("retry_safe").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: "messaging_outbox_pkey",
      columns: [table.organizationId, table.messageId],
    }),
    foreignKey({
      name: "messaging_outbox_message_fk",
      columns: [table.organizationId, table.messageId],
      foreignColumns: [messagingMessages.organizationId, messagingMessages.id],
    }).onDelete("cascade"),
    index("messaging_outbox_claim_order")
      .on(table.organizationId, table.availableAt, table.messageId)
      .where(sql`${table.leaseToken} IS NULL`),
    check(
      "messaging_outbox_lease_pair",
      sql`
    (${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)
    OR (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
  `,
    ),
    check(
      "messaging_outbox_attempt_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export const messagingBotJobs = pgTable(
  "messaging_bot_jobs",
  {
    organizationId: uuid("organization_id").notNull(),
    messageId: uuid("message_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    status: messagingBotJobStatus("status").notNull().default("PENDING"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    canonicalErrorCode: text("canonical_error_code"),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: "messaging_bot_jobs_pkey",
      columns: [table.organizationId, table.messageId],
    }),
    foreignKey({
      name: "messaging_bot_jobs_message_fk",
      columns: [table.organizationId, table.conversationId, table.messageId],
      foreignColumns: [
        messagingMessages.organizationId,
        messagingMessages.conversationId,
        messagingMessages.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "messaging_bot_jobs_conversation_fk",
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [
        messagingConversations.organizationId,
        messagingConversations.id,
      ],
    }).onDelete("cascade"),
    index("messaging_bot_jobs_claim_order")
      .on(table.organizationId, table.createdAt, table.messageId)
      .where(sql`${table.status} = 'PENDING'`),
    check(
      "messaging_bot_jobs_lease_pair",
      sql`
    (${table.status} = 'RUNNING' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    OR (${table.status} <> 'RUNNING' AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)
  `,
    ),
  ],
);

export * from "./platform-schema.js";
export * from "./tenancy-schema.js";
export * from "./meta-onboarding-schema.js";
export * from "./integrations-schema.js";
