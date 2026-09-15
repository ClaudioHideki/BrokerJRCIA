import {sql} from 'drizzle-orm';
import {pgTable,text,uuid,timestamp,jsonb,foreignKey,check} from 'drizzle-orm/pg-core';
import {organizations,users,messagingChannels} from './schema.js';
export const metaSignupStates=pgTable('meta_signup_states',{
 stateHash:text('state_hash').primaryKey(),organizationId:uuid('organization_id').notNull().references(()=>organizations.id),
 userId:uuid('user_id').notNull().references(()=>users.id),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),consumedAt:timestamp('consumed_at',{withTimezone:true}),
});
export const metaConnections=pgTable('meta_connections',{
 id:uuid('id').primaryKey(),organizationId:uuid('organization_id').notNull().references(()=>organizations.id),channelId:uuid('channel_id').notNull(),
 wabaId:text('waba_id').notNull(),phoneNumberId:text('phone_number_id').notNull().unique(),encryptedToken:text('encrypted_token'),
 tokenExpiresAt:timestamp('token_expires_at',{withTimezone:true}),graphVersion:text('graph_version').notNull(),status:text('status').notNull(),
 pending:jsonb('pending').notNull().default([]),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[
 foreignKey({columns:[table.organizationId,table.channelId],foreignColumns:[messagingChannels.organizationId,messagingChannels.id]}),
 check('meta_connections_status_check',sql`${table.status} IN ('PENDING','READY','REVOKED')`),
 check('meta_connections_check',sql`(${table.status} = 'REVOKED') = (${table.encryptedToken} IS NULL)`),
]);
