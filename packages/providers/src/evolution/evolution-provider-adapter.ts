import type { WhatsAppProviderAdmin } from '../contracts/admin.js';
import type { WhatsAppProvider } from '../contracts/provider.js';
import type {
  BeginConnectionInput,
  ConnectionAction,
  ProviderContext,
  ProviderInstanceLookup,
  ProviderInstanceReference,
  ProviderStatus,
  ProvisionedInstance,
  ProvisioningReconciliation,
  ProvisionInstanceInput,
  ReconcileProvisioningInput,
} from '../contracts/types.js';
import {
  EvolutionClient,
  evolutionProviderError,
  type EvolutionClientOptions,
  type EvolutionOperation,
} from './client.js';
import {
  mapConnectionAction,
  mapConnectionState,
  mapInstanceLookup,
  mapProvisionedInstance,
} from './mappers.js';

export interface EvolutionTimeouts {
  provisionInstance: number;
  beginConnection: number;
  getStatus: number;
  disconnect: number;
  lookupInstance: number;
  reconcileProvisioning: number;
  deprovisionInstance: number;
}

export const defaultEvolutionTimeouts: Readonly<EvolutionTimeouts> = Object.freeze({
  provisionInstance: 15_000,
  beginConnection: 15_000,
  getStatus: 5_000,
  disconnect: 10_000,
  lookupInstance: 5_000,
  reconcileProvisioning: 20_000,
  deprovisionInstance: 10_000,
});

export interface EvolutionProviderAdapterOptions extends EvolutionClientOptions {
  timeouts?: Partial<EvolutionTimeouts>;
  challengeTtlMs?: number;
  deprovisionPollIntervalMs?: number;
}

function validatePositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw evolutionProviderError('INVALID_EVOLUTION_CONFIGURATION');
  }
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function lookupPath(instanceKey: string): string {
  const query = new URLSearchParams({ instanceName: instanceKey });
  return `instance/fetchInstances?${query.toString()}`;
}

export class EvolutionProviderAdapter implements WhatsAppProvider, WhatsAppProviderAdmin {
  readonly kind = 'BAILEYS' as const;
  readonly #challengeTtlMs: number;
  readonly #client: EvolutionClient;
  readonly #deprovisionPollIntervalMs: number;
  readonly #now: () => Date;
  readonly #timeouts: EvolutionTimeouts;

  constructor(options: EvolutionProviderAdapterOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#challengeTtlMs = options.challengeTtlMs ?? 60_000;
    this.#deprovisionPollIntervalMs = options.deprovisionPollIntervalMs ?? 250;
    validatePositiveInteger(this.#challengeTtlMs);
    validatePositiveInteger(this.#deprovisionPollIntervalMs);
    this.#timeouts = {
      ...defaultEvolutionTimeouts,
      ...options.timeouts,
    };
    this.#client = new EvolutionClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      now: this.#now,
    });
  }

  async provisionInstance(
    context: ProviderContext,
    input: ProvisionInstanceInput,
  ): Promise<ProvisionedInstance> {
    const operation = this.#client.beginOperation(context, this.#timeouts.provisionInstance);
    return this.#provision(operation, input.upstreamInstanceKey);
  }

  async beginConnection(
    context: ProviderContext,
    input: BeginConnectionInput,
  ): Promise<ConnectionAction> {
    const operation = this.#client.beginOperation(context, this.#timeouts.beginConnection);
    const query = input.pairingHint === undefined
      ? ''
      : `?${new URLSearchParams({ number: input.pairingHint }).toString()}`;
    const response = await operation.request({
      method: 'GET',
      path: `instance/connect/${pathSegment(input.reference.id)}${query}`,
    });
    if (!response.found) {
      throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    }
    return mapConnectionAction(
      response.body,
      new Date(this.#now().getTime() + this.#challengeTtlMs).toISOString(),
    );
  }

  async getStatus(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderStatus> {
    const operation = this.#client.beginOperation(context, this.#timeouts.getStatus);
    const response = await operation.request({
      method: 'GET',
      path: `instance/connectionState/${pathSegment(reference.id)}`,
    });
    if (!response.found) {
      throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    }
    return mapConnectionState(response.body);
  }

  async disconnect(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void> {
    const operation = this.#client.beginOperation(context, this.#timeouts.disconnect);
    await operation.request({
      method: 'DELETE',
      path: `instance/logout/${pathSegment(reference.id)}`,
    });
  }

  async lookupInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderInstanceLookup> {
    const operation = this.#client.beginOperation(context, this.#timeouts.lookupInstance);
    return this.#lookup(operation, reference.id);
  }

  async reconcileProvisioning(
    context: ProviderContext,
    input: ReconcileProvisioningInput,
  ): Promise<ProvisioningReconciliation> {
    const operation = this.#client.beginOperation(context, this.#timeouts.reconcileProvisioning);
    const lookup = await this.#lookup(operation, input.upstreamInstanceKey);
    if (lookup.exists) {
      return {
        outcome: 'FOUND',
        instance: { reference: lookup.reference, status: lookup.status },
      };
    }
    return {
      outcome: 'PROVISIONED',
      instance: await this.#provision(operation, input.upstreamInstanceKey),
    };
  }

  async deprovisionInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void> {
    const operation = this.#client.beginOperation(context, this.#timeouts.deprovisionInstance);
    await operation.request({
      method: 'DELETE',
      path: `instance/delete/${pathSegment(reference.id)}`,
      allowNotFound: true,
    });
    for (;;) {
      const lookup = await this.#lookup(operation, reference.id);
      if (!lookup.exists) {
        return;
      }
      await operation.wait(this.#deprovisionPollIntervalMs);
    }
  }

  async #lookup(
    operation: EvolutionOperation,
    instanceKey: string,
  ): Promise<ProviderInstanceLookup> {
    const response = await operation.request({
      method: 'GET',
      path: lookupPath(instanceKey),
      allowNotFound: true,
    });
    return response.found ? mapInstanceLookup(response.body, instanceKey) : { exists: false };
  }

  async #provision(
    operation: EvolutionOperation,
    upstreamInstanceKey: string,
  ): Promise<ProvisionedInstance> {
    const response = await operation.request({
      method: 'POST',
      path: 'instance/create',
      body: {
        instanceName: upstreamInstanceKey,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: false,
      },
    });
    if (!response.found) {
      throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    }
    return mapProvisionedInstance(response.body, upstreamInstanceKey);
  }
}
