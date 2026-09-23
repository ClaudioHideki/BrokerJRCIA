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
]);

export const ChannelListV1Schema = z.strictObject({ data: z.array(ChannelV1Schema) });
export const CreateChannelV1Schema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('QR'),
    name: z.string().trim().min(1).max(100),
    providerAccountId: z.uuid(),
  }),
  z.strictObject({ provider: z.literal('META') }),
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
export const CreateChannelResponseV1Schema = z.discriminatedUnion('provider', [ChannelMutationV1Schema, MetaChannelSetupV1Schema]);
export const BindChannelDestinationV1Schema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  inboxId: z.number().int().positive().optional(),
  replaceExistingWebhook: z.boolean().default(false),
});
export const ChannelAutomationV1Schema = z.strictObject({
  binding: AutomationBindingV1Schema.nullable(),
});
export const BindChannelAutomationV1Schema = z.strictObject({
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
