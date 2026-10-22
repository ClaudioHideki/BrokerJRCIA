import {sql} from 'drizzle-orm';
import {pgTable,uuid,text,bigint,integer,jsonb,timestamp,primaryKey,unique,foreignKey,check} from 'drizzle-orm/pg-core';
import {organizations,messagingChannels,messagingConversations} from './schema.js';
import {chatwootConnections} from './integrations-schema.js';

export const chatwootCampaignIntents=pgTable('chatwoot_campaign_intents',{
 organizationId:uuid('organization_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),id:uuid('id').notNull().defaultRandom(),
 integrationId:uuid('integration_id').notNull(),channelId:uuid('channel_id').notNull(),apiKeyId:uuid('api_key_id').notNull(),actorId:text('actor_id').notNull(),
 accountId:bigint('account_id',{mode:'number'}).notNull(),inboxId:bigint('inbox_id',{mode:'number'}).notNull(),destinationRevision:integer('destination_revision').notNull(),
 credentialVersion:integer('credential_version').notNull(),identityRevision:integer('identity_revision').notNull(),ownerRevision:integer('owner_revision').notNull(),
 remoteConversationId:bigint('remote_conversation_id',{mode:'number'}).notNull(),remoteMessageId:bigint('remote_message_id',{mode:'number'}).notNull(),
 campaignId:text('campaign_id').notNull(),kind:text('kind').notNull(),text:text('text').notNull(),attachmentIds:jsonb('attachment_ids').$type<number[]>().notNull().default([]),
 remoteContactId:bigint('remote_contact_id',{mode:'number'}).notNull(),recipientPhone:text('recipient_phone').notNull(),recipientSourceId:text('recipient_source_id').notNull(),
 idempotencyKey:text('idempotency_key').notNull(),requestHash:text('request_hash').notNull(),localConversationId:uuid('local_conversation_id'),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull().default(sql`now()+interval '24 hours'`),
},t=>[primaryKey({columns:[t.organizationId,t.id]}),unique().on(t.organizationId,t.integrationId,t.idempotencyKey),unique().on(t.organizationId,t.integrationId,t.remoteMessageId),
 foreignKey({columns:[t.organizationId,t.integrationId],foreignColumns:[chatwootConnections.organizationId,chatwootConnections.id]}).onDelete('cascade'),
 foreignKey({columns:[t.organizationId,t.channelId],foreignColumns:[messagingChannels.organizationId,messagingChannels.id]}).onDelete('cascade'),
 foreignKey({columns:[t.organizationId,t.localConversationId],foreignColumns:[messagingConversations.organizationId,messagingConversations.id]}).onDelete('cascade'),
 check('campaign_actor',sql`${t.actorId} ~ '^[1-9][0-9]{0,15}$'`),check('campaign_kind',sql`${t.kind} IN ('text','image','document','video','audio')`),
 check('campaign_text_length',sql`length(${t.text})<=4096`),check('campaign_id_length',sql`length(${t.campaignId}) BETWEEN 1 AND 128`),
 check('campaign_idempotency_length',sql`length(${t.idempotencyKey}) BETWEEN 8 AND 128`),
 check('campaign_attachment_snapshot',sql`jsonb_typeof(${t.attachmentIds})='array' AND jsonb_array_length(${t.attachmentIds})<=1`),
]);
