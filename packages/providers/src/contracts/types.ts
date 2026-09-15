import { z } from 'zod';

import {
  ConnectionActionSchema,
  type ConnectionAction,
} from '@jrc/contracts';

export { ConnectionActionSchema };
export type { ConnectionAction };

export const ProviderStatusSchema = z.enum([
  'CREATED',
  'CONNECTING',
  'AWAITING_ACTION',
  'CONNECTED',
  'DISCONNECTED',
  'ERROR',
]);

export const ProviderInstanceReferenceSchema = z.object({
  id: z.string().min(1).max(256),
}).strict();

export const ProviderInstanceLookupSchema = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(false) }).strict(),
  z.object({
    exists: z.literal(true),
    reference: ProviderInstanceReferenceSchema,
    status: ProviderStatusSchema,
  }).strict(),
]);

export interface ProviderContext {
  organizationId: string;
  requestId: string;
  deadline: Date;
  signal: AbortSignal;
}

export interface ProvisionInstanceInput {
  upstreamInstanceKey: string;
  providerAccountId: string;
}

export interface ProvisionedInstance {
  reference: ProviderInstanceReference;
  status: ProviderStatus;
}

export interface BeginConnectionInput {
  reference: ProviderInstanceReference;
  pairingHint?: string;
}

export interface ReconcileProvisioningInput {
  upstreamInstanceKey: string;
  providerAccountId: string;
}

export interface ProvisioningReconciliation {
  outcome: 'FOUND' | 'PROVISIONED' | 'FAILED';
  instance?: ProvisionedInstance;
}

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
export type ProviderInstanceReference = z.infer<typeof ProviderInstanceReferenceSchema>;
export type ProviderInstanceLookup = z.infer<typeof ProviderInstanceLookupSchema>;
