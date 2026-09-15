import { z } from 'zod';

import { createPageSchema } from '../pagination.js';

export const ProviderKindSchema = z.enum(['BAILEYS', 'META']);

export const InstanceStatusSchema = z.enum([
  'PROVISIONING',
  'CREATED',
  'PROVISIONING_FAILED',
  'CONNECTING',
  'AWAITING_ACTION',
  'CONNECTED',
  'DISCONNECTING',
  'DISCONNECTED',
  'ERROR',
]);

export const CreateInstanceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: ProviderKindSchema,
  providerAccountId: z.string().uuid(),
}).strict();

export const InstanceSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  providerAccountId: z.string().uuid(),
  name: z.string().min(1).max(120),
  provider: ProviderKindSchema,
  status: InstanceStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const InstanceIdParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const IdempotencyHeadersSchema = z.object({
  'idempotency-key': z.string().trim().min(1).max(255),
}).passthrough();

export const ConnectInstanceRequestSchema = z.object({
  pairingHint: z.string().trim().min(1).max(64).optional(),
}).strict();

export const InstanceMutationResponseSchema = z.object({
  instance: InstanceSchema,
  operationId: z.string().uuid().nullable(),
  replayed: z.boolean(),
  pending: z.boolean(),
  reconciliationRequired: z.boolean(),
}).strict();

export const ConnectionActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('QR_CODE'),
    encoding: z.enum(['DATA_URL', 'BASE64']),
    value: z.string().min(1).max(2_000_000),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    type: z.literal('PAIRING_CODE'),
    code: z.string().min(1).max(64),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    type: z.literal('EMBEDDED_SIGNUP'),
    flowId: z.string().min(1).max(256),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    type: z.literal('REDIRECT'),
    url: z.string().url().max(2_048),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    type: z.literal('NONE'),
    reason: z.enum([
      'ALREADY_CONNECTED',
      'CONNECTION_PENDING',
      'NO_USER_ACTION_REQUIRED',
    ]),
  }).strict(),
]);

export const ConnectionResponseSchema = InstanceMutationResponseSchema.extend({
  action: ConnectionActionSchema,
}).strict();

export const InstancePageSchema = createPageSchema(InstanceSchema);

export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;
export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequestSchema>;
export type Instance = z.infer<typeof InstanceSchema>;
export type ConnectInstanceRequest = z.infer<typeof ConnectInstanceRequestSchema>;
export type InstanceMutationResponse = z.infer<typeof InstanceMutationResponseSchema>;
export type ConnectionAction = z.infer<typeof ConnectionActionSchema>;
export type ConnectionResponse = z.infer<typeof ConnectionResponseSchema>;
