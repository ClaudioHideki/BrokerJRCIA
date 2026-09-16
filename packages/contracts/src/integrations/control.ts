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
export const ControlAgentIdsSchema = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(100)
  .refine(v => new Set(v).size === v.length, 'Duplicate agent');
export const OnboardingInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('EXISTING'), instanceId: z.uuid() }),
    z.strictObject({ kind: z.literal('NEW'), instanceName: z.string().trim().min(1).max(100), providerAccountId: z.uuid() }),
  ]),
  inboxId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  agentIds: ControlAgentIdsSchema,
  replaceExistingWebhook: z.boolean(),
});
export const OnboardingOperationSchema = z.strictObject({
  operationId: z.uuid(), state: z.enum(['PENDING', 'RUNNING', 'FAILED', 'UNKNOWN', 'SUCCEEDED']),
  stage: z.enum(['INSTANCE', 'ACTIVATE_CHANNEL', 'LINK_INBOX', 'ASSIGN_AGENTS', 'VERIFY', 'DONE']),
  instanceId: z.uuid().nullable(), integrationId: z.uuid().nullable(), inboxId: z.number().int().positive().nullable(),
  lastError: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable(),
});
export const OnboardingRecoverySchema = z.strictObject({ action: z.enum(['RETRY', 'RECONCILE', 'CANCEL']) });
export type OnboardingInput = z.infer<typeof OnboardingInputSchema>;
export type OnboardingOperation = z.infer<typeof OnboardingOperationSchema>;
