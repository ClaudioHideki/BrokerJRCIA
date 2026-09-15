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

export type FakeProviderOperation =
  | 'provisionInstance'
  | 'beginConnection'
  | 'getStatus'
  | 'disconnect'
  | 'lookupInstance'
  | 'reconcileProvisioning'
  | 'deprovisionInstance';

export interface FakeProviderResponses {
  provisionInstance: ProvisionedInstance;
  beginConnection: ConnectionAction;
  getStatus: ProviderStatus;
  lookupInstance: ProviderInstanceLookup;
  reconcileProvisioning: ProvisioningReconciliation;
}

export interface FakeProviderCalls {
  provisionInstance: Array<{ context: ProviderContext; input: ProvisionInstanceInput }>;
  beginConnection: Array<{ context: ProviderContext; input: BeginConnectionInput }>;
  getStatus: Array<{ context: ProviderContext; reference: ProviderInstanceReference }>;
  disconnect: Array<{ context: ProviderContext; reference: ProviderInstanceReference }>;
  lookupInstance: Array<{ context: ProviderContext; reference: ProviderInstanceReference }>;
  reconcileProvisioning: Array<{ context: ProviderContext; input: ReconcileProvisioningInput }>;
  deprovisionInstance: Array<{ context: ProviderContext; reference: ProviderInstanceReference }>;
}

export interface FakeProviderAdapterOptions {
  now?: () => Date;
  responses?: Partial<FakeProviderResponses>;
  errors?: Partial<Record<FakeProviderOperation, unknown>>;
}

const defaultResponses: FakeProviderResponses = {
  provisionInstance: {
    reference: { id: 'fake-instance' },
    status: 'CREATED',
  },
  beginConnection: {
    type: 'NONE',
    reason: 'NO_USER_ACTION_REQUIRED',
  },
  getStatus: 'CREATED',
  lookupInstance: { exists: false },
  reconcileProvisioning: { outcome: 'FAILED' },
};

function providerContextError(
  code: 'INVALID_PROVIDER_CONTEXT' | 'PROVIDER_ABORTED' | 'PROVIDER_TIMEOUT',
): Error & { code: typeof code } {
  return Object.assign(new Error(code), {
    name: 'ProviderContextError',
    code,
  });
}

function validateContext(context: ProviderContext, now: Date): void {
  if (
    !(context.deadline instanceof Date)
    || !Number.isFinite(context.deadline.getTime())
    || !(context.signal instanceof AbortSignal)
  ) {
    throw providerContextError('INVALID_PROVIDER_CONTEXT');
  }

  if (context.signal.aborted) {
    throw providerContextError('PROVIDER_ABORTED');
  }

  if (context.deadline.getTime() <= now.getTime()) {
    throw providerContextError('PROVIDER_TIMEOUT');
  }
}

export class FakeProviderAdapter implements WhatsAppProvider, WhatsAppProviderAdmin {
  readonly kind = 'BAILEYS' as const;
  readonly responses: FakeProviderResponses;
  readonly calls: FakeProviderCalls = {
    provisionInstance: [],
    beginConnection: [],
    getStatus: [],
    disconnect: [],
    lookupInstance: [],
    reconcileProvisioning: [],
    deprovisionInstance: [],
  };

  readonly #errors: Partial<Record<FakeProviderOperation, unknown>>;
  readonly #now: () => Date;

  constructor(options: FakeProviderAdapterOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#errors = { ...options.errors };
    this.responses = {
      ...defaultResponses,
      ...options.responses,
    };
  }

  async provisionInstance(
    context: ProviderContext,
    input: ProvisionInstanceInput,
  ): Promise<ProvisionedInstance> {
    this.calls.provisionInstance.push({ context, input });
    this.#beforeOperation('provisionInstance', context);
    return this.responses.provisionInstance;
  }

  async beginConnection(
    context: ProviderContext,
    input: BeginConnectionInput,
  ): Promise<ConnectionAction> {
    this.calls.beginConnection.push({ context, input });
    this.#beforeOperation('beginConnection', context);
    return this.responses.beginConnection;
  }

  async getStatus(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderStatus> {
    this.calls.getStatus.push({ context, reference });
    this.#beforeOperation('getStatus', context);
    return this.responses.getStatus;
  }

  async disconnect(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void> {
    this.calls.disconnect.push({ context, reference });
    this.#beforeOperation('disconnect', context);
  }

  async lookupInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<ProviderInstanceLookup> {
    this.calls.lookupInstance.push({ context, reference });
    this.#beforeOperation('lookupInstance', context);
    return this.responses.lookupInstance;
  }

  async reconcileProvisioning(
    context: ProviderContext,
    input: ReconcileProvisioningInput,
  ): Promise<ProvisioningReconciliation> {
    this.calls.reconcileProvisioning.push({ context, input });
    this.#beforeOperation('reconcileProvisioning', context);
    return this.responses.reconcileProvisioning;
  }

  async deprovisionInstance(
    context: ProviderContext,
    reference: ProviderInstanceReference,
  ): Promise<void> {
    this.calls.deprovisionInstance.push({ context, reference });
    this.#beforeOperation('deprovisionInstance', context);
  }

  #beforeOperation(operation: FakeProviderOperation, context: ProviderContext): void {
    validateContext(context, this.#now());
    if (Object.hasOwn(this.#errors, operation)) {
      throw this.#errors[operation];
    }
  }
}
