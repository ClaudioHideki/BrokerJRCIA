import {sql} from 'drizzle-orm';
import {pgTable,uuid,text,boolean,bigint,integer,timestamp,index,check} from 'drizzle-orm/pg-core';
import {organizations} from './schema.js';
export const platformUsers=pgTable('platform_users',{
 id:uuid('id').defaultRandom().primaryKey(),email:text('email').notNull().unique(),passwordHash:text('password_hash').notNull(),
 role:text('role').notNull(),mfaSeed:text('mfa_seed').notNull(),lastTotpStep:bigint('last_totp_step',{mode:'number'}).notNull().default(-1),active:boolean('active').notNull().default(true),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[check('platform_users_email_check',sql`${t.email}=lower(btrim(${t.email}))`),check('platform_users_role_check',sql`${t.role} in ('SUPER_ADMIN','SUPPORT')`)]);
export const platformSessions=pgTable('platform_sessions',{
 tokenHash:text('token_hash').primaryKey(),userId:uuid('user_id').notNull().references(()=>platformUsers.id),csrfToken:text('csrf_token').notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[index('platform_sessions_expiry').on(t.expiresAt)]);
export const platformLoginLimits=pgTable('platform_login_limits',{key:text('key').primaryKey(),attempts:integer('attempts').notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull()});
export const platformAuditLogs=pgTable('platform_audit_logs',{id:uuid('id').primaryKey().defaultRandom(),actorId:uuid('actor_id').references(()=>platformUsers.id),organizationId:uuid('organization_id').references(()=>organizations.id),action:text('action').notNull(),reason:text('reason').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow()},t=>[check('platform_audit_logs_reason_check',sql`length(btrim(${t.reason}))>=5`)]);
