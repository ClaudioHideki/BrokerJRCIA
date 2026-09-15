import type { WhatsAppProvider } from '../contracts/provider.js';
import type {
  BeginConnectionInput,
  ConnectionAction,
  ProviderContext,
  ProviderInstanceReference,
  ProviderStatus,
  ProvisionedInstance,
  ProvisionInstanceInput,
} from '../contracts/types.js';

function providerNotAvailable(): Error & { code: 'PROVIDER_NOT_AVAILABLE' } {
  return Object.assign(new Error('PROVIDER_NOT_AVAILABLE'), {
    name: 'ProviderUnavailableError',
    code: 'PROVIDER_NOT_AVAILABLE' as const,
  });
}

export class MetaProviderAdapter implements WhatsAppProvider {
  readonly kind = 'META' as const;

  async provisionInstance(
    _context: ProviderContext,
    _input: ProvisionInstanceInput,
  ): Promise<ProvisionedInstance> {
    throw providerNotAvailable();
  }

  async beginConnection(
    _context: ProviderContext,
    _input: BeginConnectionInput,
  ): Promise<ConnectionAction> {
    throw providerNotAvailable();
  }

  async getStatus(
    _context: ProviderContext,
    _reference: ProviderInstanceReference,
  ): Promise<ProviderStatus> {
    throw providerNotAvailable();
  }

  async disconnect(
    _context: ProviderContext,
    _reference: ProviderInstanceReference,
  ): Promise<void> {
    throw providerNotAvailable();
  }
}
