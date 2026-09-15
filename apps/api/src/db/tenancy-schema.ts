import { sql } from 'drizzle-orm';
import { check, date, integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './schema.js';

export const organizationLimits = pgTable('organization_limits', {
  organizationId: uuid('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  maxInstances: integer('max_instances').notNull().default(5),
  maxUsers: integer('max_users').notNull().default(10),
  messagesPerDay: integer('messages_per_day').notNull().default(1000),
  maxPendingMessages: integer('max_pending_messages').notNull().default(1000),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('organization_limits_max_instances_check', sql`${table.maxInstances}>0`),
  check('organization_limits_max_users_check', sql`${table.maxUsers}>0`),
  check('organization_limits_messages_per_day_check', sql`${table.messagesPerDay}>0`),
  check('organization_limits_max_pending_messages_check', sql`${table.maxPendingMessages}>0`),
]);

export const organizationMessageUsage = pgTable('organization_message_usage', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  usageDay: date('usage_day').notNull(),
  acceptedMessages: integer('accepted_messages').notNull().default(0),
}, table => [
  primaryKey({ columns: [table.organizationId, table.usageDay] }),
  check('organization_message_usage_accepted_messages_check', sql`${table.acceptedMessages}>=0`),
]);
