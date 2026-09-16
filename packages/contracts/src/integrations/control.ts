import { z } from 'zod';
export const ChatwootControlScopeSchema = z.enum(['chatwoot:read', 'chatwoot:manage', 'chatwoot:pair', 'chatwoot:disconnect']);
export type ChatwootControlScope = z.infer<typeof ChatwootControlScopeSchema>;
export const IssueControlCredentialSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ChatwootControlScopeSchema).min(1).max(4),
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
export const ControlBindingSchema = z.strictObject({
  organizationId: z.uuid(), accountId: z.number().int().positive(), destinationRevision: z.number().int().positive(),
});
export const IssuedControlCredentialSchema = z.strictObject({
  id: z.uuid(), secret: z.string().regex(/^jrc_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/),
  binding: ControlBindingSchema, scopes: z.array(ChatwootControlScopeSchema), expiresAt: z.iso.datetime().nullable(),
});
export const ControlContextSchema = ControlBindingSchema.extend({
  chatwootOrigin: z.url(), capabilities: z.record(z.string(), z.enum(['SUPPORTED', 'UNSUPPORTED', 'UNVERIFIED'])),
});
export const OperatorGrantsSchema = z.strictObject({
  grants: z.array(z.strictObject({ userId: z.uuid(), canPair: z.boolean() })).max(100),
}).refine(v => new Set(v.grants.map(x => x.userId)).size === v.grants.length, 'Duplicate user');
export const ControlIdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/);
