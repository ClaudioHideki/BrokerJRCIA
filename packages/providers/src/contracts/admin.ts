import type {
  ProviderContext,
  ProviderInstanceLookup,
  ProviderInstanceReference,
  ProvisioningReconciliation,
  ReconcileProvisioningInput,
} from './types.js';

export interface WhatsAppProviderAdmin {
  lookupInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderInstanceLookup>;

  reconcileProvisioning(
    context: ProviderContext,
    input: ReconcileProvisioningInput,
  ): Promise<ProvisioningReconciliation>;

  deprovisionInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void>;
}
