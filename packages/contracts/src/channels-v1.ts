import { z } from 'zod';
import { ConnectionActionSchema } from './instances/schemas.js';
import { AutomationBindingV1Schema } from './automations-v1.js';

export const CHANNEL_CONTRACT_VERSION = 1 as const;

export const ChannelTransportStatusV1Schema = z.enum([
  'CREATED',
  'PAIRING',
  'CONNECTED',
  'DISCONNECTED',
  'DEGRADED',
  'UNKNOWN',
]);
export const ChannelProviderStatusV1Schema = z.enum([
  'PENDING',
  'READY',
  'DEGRADED',
  'REVOKED',
  'DISABLED',
  'UNKNOWN',
]);
export const ChannelAutomationStatusV1Schema = z.enum([
  'UNBOUND',
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ERROR',
  'UNKNOWN',
]);
export const ChannelHumanStatusV1Schema = z.enum([
  'UNBOUND',
  'READY',
  'DEGRADED',
  'DISABLED',
  'UNKNOWN',
]);

const ChannelIdentityV1Schema = z.strictObject({
  displayName: z.string().trim().min(1).max(160).nullable(),
  maskedAddress: z.string().regex(/^(?:[*•Xx]{3,})(?:[- ]?\d{0,4})?$/u).nullable(),
});

const commonChannelShape = {
  schemaVersion: z.literal(CHANNEL_CONTRACT_VERSION),
  id: z.uuid(),
  organizationId: z.uuid(),
  identity: ChannelIdentityV1Schema,
  archivedAt: z.iso.datetime().nullable().optional(),
  messagingChannelId: z.uuid().nullable().optional(),
  automationName: z.string().nullable().optional(),
  destination: z.strictObject({integrationId:z.uuid(),inboxId:z.number().int().positive().nullable(),name:z.string()}).nullable().optional(),
  transportStatus: ChannelTransportStatusV1Schema,
  providerStatus: ChannelProviderStatusV1Schema,
  automationStatus: ChannelAutomationStatusV1Schema,
  humanStatus: ChannelHumanStatusV1Schema,
  revision: z.number().int().positive(),
  ownerRevision: z.number().int().nonnegative().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const ChannelV1Schema = z.discriminatedUnion('provider', [
  z.strictObject({
    ...commonChannelShape,
    provider: z.literal('QR'),
    providerReference: z.strictObject({
      providerAccountId: z.uuid(),
      instanceId: z.uuid(),
    }),
  }),
  z.strictObject({
    ...commonChannelShape,
    provider: z.literal('META'),
    providerReference: z.strictObject({
      providerAccountId: z.uuid(),
      connectionId: z.uuid(),
    }),
  }),
  z.strictObject({
    ...commonChannelShape,
    provider: z.literal('CENTRAL'),
    providerReference: z.strictObject({integrationId:z.uuid(),accountId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),inboxId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),
  }),
]);

export const ChannelListV1Schema = z.strictObject({ data: z.array(ChannelV1Schema), nextCursor: z.string().min(1).max(256).nullable().optional() });
export const CreateChannelV1Schema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('QR'),
    name: z.string().trim().min(1).max(100),
    providerAccountId: z.uuid(),
  }),
  z.strictObject({ provider: z.literal('META') }),
  z.strictObject({provider:z.literal('CENTRAL'),name:z.string().trim().min(1).max(100),inboxId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedCredentialVersion:z.number().int().positive(),expectedDestinationRevision:z.number().int().positive(),
    expectedRemoteFingerprint:z.string().regex(/^[a-f0-9]{64}$/),expectedBotId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),replaceExistingBot:z.boolean()}),
]);
export const PatchChannelV1Schema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
});
export const ChannelMutationV1Schema = z.strictObject({
  provider: z.literal('QR'),
  channel: ChannelV1Schema,
  operationId: z.uuid().nullable(),
  replayed: z.boolean(),
  pending: z.boolean(),
  reconciliationRequired: z.boolean(),
});
export const PairChannelResponseV1Schema = ChannelMutationV1Schema.extend({ action: ConnectionActionSchema });
export const MetaChannelSetupV1Schema = z.strictObject({
  provider: z.literal('META'),
  action: z.strictObject({
    type: z.literal('EMBEDDED_SIGNUP'),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
    appId: z.string().min(1),
    configId: z.string().min(1),
    graphVersion: z.string().min(1),
  }),
});
export const CentralCutoverOperationSchema=z.strictObject({id:z.uuid(),channelId:z.uuid().nullable(),integrationId:z.uuid(),inboxId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 status:z.enum(['PENDING','DISPATCHED','UNKNOWN','COMPLETE','ROLLED_BACK','CANCELED']),step:z.enum(['DETACH','CREATE','ATTACH','VERIFY']),revision:z.number().int().positive(),reconciliationRequired:z.boolean(),rollbackStep:z.enum(['DETACH','RESTORE','VERIFY']).nullable().optional()});
export const CentralChannelSetupV1Schema=z.strictObject({provider:z.literal('CENTRAL'),pending:z.boolean(),operation:CentralCutoverOperationSchema});
export const CentralInboxPreviewSchema=z.strictObject({expectedCredentialVersion:z.number().int().positive(),expectedDestinationRevision:z.number().int().positive(),
 expectedRemoteFingerprint:z.string().regex(/^[a-f0-9]{64}$/),expectedBotId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable()});
export const CentralInboxListSchema=z.strictObject({data:z.array(z.strictObject({id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),name:z.string().max(1000),channelType:z.string().max(100)})).max(10000)});
export const CreateChannelResponseV1Schema = z.discriminatedUnion('provider', [ChannelMutationV1Schema, MetaChannelSetupV1Schema,CentralChannelSetupV1Schema]);
export const BindChannelDestinationV1Schema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  inboxId: z.number().int().positive().optional(),
  replaceExistingWebhook: z.boolean().default(false),
});
export const ChannelAutomationV1Schema = z.strictObject({
  binding: AutomationBindingV1Schema.nullable(),
  ownerRevision: z.number().int().nonnegative(),
});
export const BindChannelAutomationV1Schema = z.strictObject({
  expectedOwnerRevision: z.number().int().nonnegative(),
  automationId: z.uuid(),
  version: z.number().int().positive().optional(),
  humanDestinationId: z.uuid().nullable().optional(),
});

export type ChannelV1 = z.infer<typeof ChannelV1Schema>;
export type CreateChannelV1 = z.infer<typeof CreateChannelV1Schema>;
export type PatchChannelV1 = z.infer<typeof PatchChannelV1Schema>;
export type BindChannelDestinationV1 = z.infer<typeof BindChannelDestinationV1Schema>;
export type BindChannelAutomationV1 = z.infer<typeof BindChannelAutomationV1Schema>;
export type ChannelTransportStatusV1 = z.infer<typeof ChannelTransportStatusV1Schema>;
export type ChannelProviderStatusV1 = z.infer<typeof ChannelProviderStatusV1Schema>;
export type ChannelAutomationStatusV1 = z.infer<typeof ChannelAutomationStatusV1Schema>;
export type ChannelHumanStatusV1 = z.infer<typeof ChannelHumanStatusV1Schema>;
