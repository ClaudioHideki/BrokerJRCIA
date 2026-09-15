import type {
  BeginConnectionInput,
  ConnectionAction,
  ProviderContext,
  ProviderInstanceReference,
  ProviderStatus,
  ProvisionedInstance,
  ProvisionInstanceInput,
} from './types.js';

export interface WhatsAppProvider {
  readonly kind: 'BAILEYS' | 'META';

  provisionInstance(
    context: ProviderContext,
    input: ProvisionInstanceInput,
  ): Promise<ProvisionedInstance>;

  beginConnection(
    context: ProviderContext,
    input: BeginConnectionInput,
  ): Promise<ConnectionAction>;

  getStatus(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderStatus>;

  disconnect(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void>;
}
