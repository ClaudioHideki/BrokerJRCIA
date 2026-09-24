import { z } from 'zod';
import { InstanceStatusSchema } from '../instances/schemas.js';
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
export const OperatorGrantViewSchema = z.strictObject({
  members: z.array(z.strictObject({ userId: z.uuid(), email: z.email(), role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER']) })).max(1000),
  grants: z.array(z.strictObject({ userId: z.uuid(), canPair: z.boolean() })).max(100),
});
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
export const ControlResourcesSchema = z.strictObject({
  connections: z.array(z.strictObject({ integrationId: z.uuid(), inboxId: z.number().int().positive(), instanceId: z.uuid(), name: z.string() })).max(500).default([]),
  providers: z.array(z.strictObject({ id: z.uuid(), name: z.string() })).max(500),
  instances: z.array(z.strictObject({ id: z.uuid(), name: z.string(), status: InstanceStatusSchema })).max(500),
});
export const OnboardingListSchema = z.strictObject({ data: z.array(OnboardingOperationSchema).max(50) });
export type OnboardingInput = z.infer<typeof OnboardingInputSchema>;
export type OnboardingOperation = z.infer<typeof OnboardingOperationSchema>;
export const ConnectionHealthSchema = z.strictObject({
  integrationId: z.uuid(), inboxId: z.number().int().positive().nullable(), instanceId: z.uuid(),
  integrationStatus: z.enum(['PENDING', 'READY', 'FAILED', 'UNKNOWN', 'DISABLED']), instanceStatus: InstanceStatusSchema,
  callbackVerifiedAt: z.iso.datetime().nullable(), lastSuccessfulInboundAt: z.iso.datetime().nullable(), lastSuccessfulOutboundAt: z.iso.datetime().nullable(),
  transportStatus: z.enum(['UNVERIFIED', 'OPERATIONAL', 'DEGRADED']), checkedAt: z.iso.datetime(), lastError: z.string().nullable(),
  allowedActions: z.array(z.enum(['status', 'pair', 'disconnect', 'manage'])),
  identityStatus: z.enum(['UNVERIFIED', 'CONFIRMED', 'CONFIRMATION_REQUIRED']), identityRevision: z.number().int().positive(),
  identityApproved: z.boolean(),
  observedNumberSuffix: z.string().regex(/^\d{4}$/).nullable(),
});
export const ConfirmIdentitySchema = z.strictObject({ observedRevision: z.number().int().positive() });
export const ControlAgentsSchema = z.strictObject({ agentIds: ControlAgentIdsSchema });
export type ConnectionHealth = z.infer<typeof ConnectionHealthSchema>;
