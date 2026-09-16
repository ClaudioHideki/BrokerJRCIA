import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  organizations,
  apiKeys,
  memberships,
  instances,
  messagingChannels,
  messagingConversations,
  messagingMessages,
} from "./schema.js";
const dates = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};
export const chatwootOnboardingOperations = pgTable('chatwoot_onboarding_operations', {
  id: uuid('id').primaryKey().defaultRandom(), organizationId: uuid('organization_id').notNull().references(() => chatwootAccounts.organizationId, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(), inputHash: text('input_hash').notNull(), input: jsonb('input').notNull(),
  accountId: bigint('account_id', { mode: 'number' }).notNull(), destinationRevision: integer('destination_revision').notNull(), chatwootOrigin: text('chatwoot_origin').notNull(),
  actorId: uuid('actor_id'), actorApiKeyId: uuid('actor_api_key_id'), externalActorId: text('external_actor_id'),
  state: text('state').notNull().default('PENDING'), stage: text('stage').notNull().default('INSTANCE'),
  instanceId: uuid('instance_id'), channelId: uuid('channel_id'), integrationId: uuid('integration_id'), inboxId: bigint('inbox_id', { mode: 'number' }),
  reconcileOnly: boolean('reconcile_only').notNull().default(false), retryRequested: boolean('retry_requested').notNull().default(false), cancelRequested: boolean('cancel_requested').notNull().default(false),
  leaseToken: uuid('lease_token'), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }), lastError: text('last_error'), ...dates,
}, t => [unique().on(t.organizationId, t.id), unique().on(t.organizationId, t.idempotencyKey),
  foreignKey({ columns: [t.organizationId, t.actorApiKeyId], foreignColumns: [apiKeys.organizationId, apiKeys.id] }).onDelete('restrict'),
  foreignKey({ columns: [t.organizationId, t.instanceId], foreignColumns: [instances.organizationId, instances.id] }).onDelete('restrict'),
  foreignKey({ columns: [t.organizationId, t.channelId], foreignColumns: [messagingChannels.organizationId, messagingChannels.id] }).onDelete('restrict'),
  foreignKey({ columns: [t.organizationId, t.integrationId], foreignColumns: [chatwootConnections.organizationId, chatwootConnections.id] }).onDelete('restrict')]);
export const chatwootConnectionHealth = pgTable('chatwoot_connection_health', {
  organizationId: uuid('organization_id').notNull(), integrationId: uuid('integration_id').notNull(), channelId: uuid('channel_id').notNull(),
  identityEnforced: boolean('identity_enforced').notNull().default(false), approvedFingerprint: text('approved_fingerprint'), observedFingerprint: text('observed_fingerprint'), observedLast4: text('observed_last4'),
  identityRevision: integer('identity_revision').notNull().default(1), observedConnected: boolean('observed_connected').notNull().default(false), observedAt: timestamp('observed_at', { withTimezone: true }),
  identityError: text('identity_error'), accessError: text('access_error'), pairWindowKey: uuid('pair_window_key'), pairWindowExpiresAt: timestamp('pair_window_expires_at', { withTimezone: true }),
  callbackVerifiedAt: timestamp('callback_verified_at', { withTimezone: true }), callbackDestinationRevision: integer('callback_destination_revision'), callbackCredentialVersion: integer('callback_credential_version'), ...dates,
}, t => [primaryKey({ columns: [t.organizationId, t.integrationId] }), unique().on(t.organizationId, t.channelId),
  foreignKey({ columns: [t.organizationId, t.integrationId, t.channelId], foreignColumns: [chatwootConnections.organizationId, chatwootConnections.id, chatwootConnections.channelId] }).onDelete('restrict')]);
export const chatwootControlBindings = pgTable('chatwoot_control_bindings', {
  apiKeyId: uuid('api_key_id').primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => chatwootAccounts.organizationId, { onDelete: 'restrict' }),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  destinationRevision: integer('destination_revision').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.organizationId, t.apiKeyId], foreignColumns: [apiKeys.organizationId, apiKeys.id] }).onDelete('cascade')]);
export const chatwootOperatorGrants = pgTable('chatwoot_operator_grants', {
  organizationId: uuid('organization_id').notNull(), integrationId: uuid('integration_id').notNull(), userId: uuid('user_id').notNull(),
  canPair: boolean('can_pair').notNull().default(false), ...dates,
}, t => [primaryKey({ columns: [t.organizationId, t.integrationId, t.userId] }),
  foreignKey({ columns: [t.organizationId, t.integrationId], foreignColumns: [chatwootConnections.organizationId, chatwootConnections.id] }).onDelete('restrict'),
  foreignKey({ columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }).onDelete('cascade')]);
export const chatwootDestinations = pgTable('chatwoot_destinations', {
  organizationId: uuid('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'restrict' }),
  baseUrl: text('base_url').notNull(),
  mode: text('mode').notNull(),
  approvalStatus: text('approval_status').notNull().default('PENDING'),
  mediaOrigins: jsonb('media_origins').notNull().default(sql`'[]'::jsonb`),
  revision: integer('revision').notNull().default(1),
  approvalAuditId: uuid('approval_audit_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  ...dates,
}, t => [
  unique().on(t.organizationId, t.baseUrl),
  check('chatwoot_destinations_mode_check', sql`${t.mode} IN ('MANAGED','EXTERNAL')`),
  check('chatwoot_destinations_approval_status_check', sql`${t.approvalStatus} IN ('PENDING','APPROVED','REVOKED')`),
  check('chatwoot_destinations_revision_check', sql`${t.revision}>0`),
]);
export const chatwootAccounts = pgTable(
  "chatwoot_accounts",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    baseUrl: text("base_url").notNull(),
    accountId: bigint("account_id", { mode: "number" }),
    encryptedToken: text("encrypted_token"),
    credentialVersion: integer('credential_version').notNull().default(1),
    capabilities: jsonb('capabilities').notNull().default(sql`'{}'::jsonb`),
    capabilitiesVerifiedAt: timestamp('capabilities_verified_at', { withTimezone: true }),
    provisioningKey: uuid("provisioning_key").notNull().defaultRandom(),
    status: text("status").notNull().default("PENDING"),
    lastError: text("last_error"),
    ...dates,
  },
  (t) => [
    unique().on(t.baseUrl, t.accountId),
    foreignKey({ name: 'chatwoot_accounts_destination_fk', columns: [t.organizationId, t.baseUrl],
      foreignColumns: [chatwootDestinations.organizationId, chatwootDestinations.baseUrl] }),
    check(
      "chatwoot_accounts_status_check",
      sql`${t.status} IN ('PENDING','READY','FAILED','UNKNOWN','DISABLED')`,
    ),
  ],
);
export const chatwootConnections = pgTable(
  "chatwoot_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => chatwootAccounts.organizationId, {
        onDelete: "restrict",
      }),
    channelId: uuid("channel_id").notNull(),
    inboxId: bigint("inbox_id", { mode: "number" }),
    encryptedWebhookSecret: text("encrypted_webhook_secret"),
    name: text("name").notNull(),
    status: text("status").notNull().default("PENDING"),
    lastError: text("last_error"),
    ...dates,
  },
  (t) => [
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.channelId),
    unique().on(t.organizationId, t.inboxId),
    unique('chatwoot_connections_channel_binding_unique').on(t.organizationId, t.id, t.channelId),
    foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [messagingChannels.organizationId, messagingChannels.id],
    }).onDelete("restrict"),
    check(
      "chatwoot_connections_status_check",
      sql`${t.status} IN ('PENDING','READY','FAILED','UNKNOWN','DISABLED')`,
    ),
  ],
);
export const chatwootConversations = pgTable(
  "chatwoot_conversations",
  {
    organizationId: uuid("organization_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    contactId: bigint("contact_id", { mode: "number" }).notNull(),
    sourceId: text("source_id").notNull(),
    remoteConversationId: bigint("remote_conversation_id", {
      mode: "number",
    }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.integrationId, t.conversationId],
    }),
    unique().on(t.organizationId, t.integrationId, t.remoteConversationId),
    foreignKey({
      columns: [t.organizationId, t.integrationId],
      foreignColumns: [
        chatwootConnections.organizationId,
        chatwootConnections.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [
        messagingConversations.organizationId,
        messagingConversations.id,
      ],
    }).onDelete("restrict"),
  ],
);
export const chatwootMessages = pgTable(
  "chatwoot_messages",
  {
    organizationId: uuid("organization_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    messageId: uuid("message_id").notNull(),
    remoteMessageId: bigint("remote_message_id", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.integrationId, t.messageId] }),
    index("chatwoot_messages_remote_lookup").on(
      t.organizationId,
      t.integrationId,
      t.remoteMessageId,
    ),
    foreignKey({
      columns: [t.organizationId, t.integrationId],
      foreignColumns: [
        chatwootConnections.organizationId,
        chatwootConnections.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messagingMessages.organizationId, messagingMessages.id],
    }).onDelete("restrict"),
  ],
);
export const integrationJobs = pgTable(
  "integration_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    messageId: uuid("message_id"),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...dates,
  },
  (t) => [
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.integrationId, t.dedupeKey),
    foreignKey({
      columns: [t.organizationId, t.integrationId],
      foreignColumns: [
        chatwootConnections.organizationId,
        chatwootConnections.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messagingMessages.organizationId, messagingMessages.id],
    }).onDelete("restrict"),
    index("integration_jobs_claim").on(
      t.organizationId,
      t.status,
      t.availableAt,
      t.createdAt,
    ),
    check(
      "integration_jobs_kind_check",
      sql`${t.kind} IN ('CHATWOOT_REPLY','MIRROR_MESSAGE')`,
    ),
    check(
      "integration_jobs_status_check",
      sql`${t.status} IN ('PENDING','RUNNING','SUCCEEDED','FAILED','UNKNOWN')`,
    ),
    check("integration_jobs_attempts_check", sql`${t.attempts}>=0`),
    check(
      "integration_jobs_check",
      sql`(${t.status}='RUNNING' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL) OR (${t.status}<>'RUNNING' AND ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL)`,
    ),
  ],
);
export const integrationAudit = pgTable("integration_audit", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  actorId: uuid("actor_id"),
  actorApiKeyId: uuid('actor_api_key_id'),
  externalActorId: text('external_actor_id'),
  action: text("action").notNull(),
  resourceId: uuid("resource_id"),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const chatwootProvisioning = pgTable(
  "chatwoot_provisioning",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => chatwootAccounts.organizationId, {
        onDelete: "restrict",
      }),
    stage: text("stage").notNull().default("ACCOUNT"),
    state: text("state").notNull().default("PENDING"),
    encryptedInput: text("encrypted_input"),
    remoteUserId: bigint("remote_user_id", { mode: "number" }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...dates,
  },
  (t) => [
    check(
      "chatwoot_provisioning_stage_check",
      sql`${t.stage} IN ('ACCOUNT','USER','ACCESS','VERIFY','DONE')`,
    ),
    check(
      "chatwoot_provisioning_state_check",
      sql`${t.state} IN ('PENDING','RUNNING','FAILED','UNKNOWN','READY')`,
    ),
    check(
      "chatwoot_provisioning_check",
      sql`(${t.state}='RUNNING' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL) OR (${t.state}<>'RUNNING' AND ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL)`,
    ),
  ],
);
