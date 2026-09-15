import type { WhatsAppProviderAdmin } from './contracts/admin.js';
import type { WhatsAppProvider } from './contracts/provider.js';

export type ProviderKind = WhatsAppProvider['kind'];

function registryError(
  code:
    | 'PROVIDER_NOT_REGISTERED'
    | 'PROVIDER_ADMIN_NOT_AVAILABLE'
    | 'PROVIDER_ALREADY_REGISTERED'
    | 'PROVIDER_ADMIN_ALREADY_REGISTERED',
): Error & { code: typeof code } {
  return Object.assign(new Error(code), {
    name: 'ProviderRegistryError',
    code,
  });
}

export class ProviderRegistry {
  readonly #providers = new Map<ProviderKind, WhatsAppProvider>();
  readonly #adminProviders = new Map<ProviderKind, WhatsAppProviderAdmin>();

  constructor(
    providers: Iterable<WhatsAppProvider> = [],
    adminProviders: Iterable<readonly [ProviderKind, WhatsAppProviderAdmin]> = [],
  ) {
    for (const provider of providers) {
      if (this.#providers.has(provider.kind)) {
        throw registryError('PROVIDER_ALREADY_REGISTERED');
      }
      this.#providers.set(provider.kind, provider);
    }

    for (const [kind, provider] of adminProviders) {
      if (this.#adminProviders.has(kind)) {
        throw registryError('PROVIDER_ADMIN_ALREADY_REGISTERED');
      }
      this.#adminProviders.set(kind, provider);
    }
  }

  getProvider(kind: ProviderKind): WhatsAppProvider {
    const provider = this.#providers.get(kind);
    if (provider === undefined) {
      throw registryError('PROVIDER_NOT_REGISTERED');
    }
    return provider;
  }

  getAdminProvider(kind: ProviderKind): WhatsAppProviderAdmin {
    const provider = this.#adminProviders.get(kind);
    if (provider === undefined) {
      throw registryError('PROVIDER_ADMIN_NOT_AVAILABLE');
    }
    return provider;
  }
}
