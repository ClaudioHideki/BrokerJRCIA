import { describe, expect, it } from 'vitest';

import { FakeProviderAdapter, ProviderRegistry } from '@jrc/providers';

import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import type { InstanceRepository, InstanceRow, ProviderOperationRow } from '../../src/modules/instances/service.js';
import { createProvisioningReconciler } from '../../src/modules/reconciliation/reconcile-provisioning.js';

const ORGANIZATION_ID = 'c9fd2146-457a-4b6c-8359-c8f96fb0f077';
const INSTANCE_ID = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const OPERATION_ID = 'a92b0b8d-dadb-4bd9-a273-89ed914ffabb';
const ACCOUNT_ID = 'ac282057-7f9c-4a91-93c9-82e4cedfa157';
const NOW = new Date('2030-01-01T00:00:00.000Z');

function fixture() {
  const instance: InstanceRow = {
    id: INSTANCE_ID,
    organizationId: ORGANIZATION_ID,
    providerAccountId: ACCOUNT_ID,
    name: 'Primary',
    provider: 'BAILEYS',
    upstreamInstanceKey: 'jrc_519b77a6a4e5409a85c8d78fc155c525',
    externalReference: null,
    status: 'PROVISIONING',
    capabilities: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const operation: ProviderOperationRow = {
    id: OPERATION_ID,
    organizationId: ORGANIZATION_ID,
    instanceId: INSTANCE_ID,
    operationType: 'PROVISION',
    status: 'UNKNOWN',
    attemptCount: 1,
    canonicalErrorCode: 'PROVIDER_TIMEOUT',
    reconciliationRequired: true,
    updatedAt: NOW,
  };
  return { instance, operation };
}

function harness(provider: FakeProviderAdapter) {
  const state = fixture();
  const timeline: string[] = [];
  const repository: InstanceRepository = {
    async findProviderAccount() { return null; },
    async insertProvisioning() { return state; },
    async findById() { return state.instance; },
    async findByIdForUpdate() { return state.instance; },
    async findByOperation() { return state.instance; },
    async list() { return [state.instance]; },
    async createOperation() { return state.operation; },
    async findPendingConnectOperationForUpdate() { return null; },
    async updatePendingConnectOperation() { return false; },
    async updateInstanceState(_tx, update) {
      state.instance = { ...state.instance, ...update, updatedAt: NOW };
      return state.instance;
    },
    async completeOperation(_tx, update) { state.operation = { ...state.operation, ...update }; },
    async claimProvisioningOperation() {
      if (state.operation.status === 'PENDING') return null;
      state.operation = {
        ...state.operation,
        status: 'PENDING',
        attemptCount: state.operation.attemptCount + 1,
      };
      return state;
    },
    async claimIdempotency() { throw new Error('unused'); },
    async linkIdempotency() { throw new Error('unused'); },
    async completeIdempotency() { throw new Error('unused'); },
  };
  const originalLookup = provider.lookupInstance.bind(provider);
  provider.lookupInstance = async (...args) => {
    timeline.push('provider.lookup');
    return originalLookup(...args);
  };
  const originalReconcile = provider.reconcileProvisioning.bind(provider);
  provider.reconcileProvisioning = async (...args) => {
    timeline.push('provider.reconcile');
    return originalReconcile(...args);
  };
  const reconcile = createProvisioningReconciler({
    repository,
    providers: new ProviderRegistry([provider], [['BAILEYS', provider]]),
    now: () => NOW,
    runInOrganizationTransaction: async (_organizationId, callback) => {
      timeline.push('begin');
      const value = await callback({ query: async () => ({ rows: [], rowCount: 0 }) } as unknown as TenantTransaction);
      timeline.push('commit');
      return value;
    },
    writeAudit: async () => undefined,
  });
  return { reconcile, state, timeline };
}

describe('reconciliação de provisionamento', () => {
  it('usa lookup estritamente read-only e conclui sem comando mutável quando encontra a instância', async () => {
    const provider = new FakeProviderAdapter({
      now: () => NOW,
      responses: {
        lookupInstance: { exists: true, reference: { id: 'upstream-ref' }, status: 'CREATED' },
      },
    });
    const test = harness(provider);

    await expect(test.reconcile({
      organizationId: ORGANIZATION_ID,
      operationId: OPERATION_ID,
      requestId: '8ecfc8d2-3a67-42db-a3de-24fc99aef758',
      deadline: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'CREATED' });

    expect(test.timeline).toEqual(['begin', 'commit', 'provider.lookup', 'begin', 'commit']);
    expect(provider.calls.reconcileProvisioning).toHaveLength(0);
    expect(provider.calls.lookupInstance[0]?.reference.id).toBe('jrc_519b77a6a4e5409a85c8d78fc155c525');
  });

  it('somente após lookup ausente repete provisionamento pela mesma chave determinística', async () => {
    const provider = new FakeProviderAdapter({
      now: () => NOW,
      responses: {
        lookupInstance: { exists: false },
        reconcileProvisioning: {
          outcome: 'PROVISIONED',
          instance: { reference: { id: 'upstream-ref' }, status: 'CREATED' },
        },
      },
    });
    const test = harness(provider);

    await test.reconcile({
      organizationId: ORGANIZATION_ID,
      operationId: OPERATION_ID,
      requestId: '8ecfc8d2-3a67-42db-a3de-24fc99aef758',
      deadline: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    });

    expect(test.timeline).toEqual([
      'begin', 'commit', 'provider.lookup', 'provider.reconcile', 'begin', 'commit',
    ]);
    expect(provider.calls.reconcileProvisioning[0]?.input).toEqual({
      upstreamInstanceKey: 'jrc_519b77a6a4e5409a85c8d78fc155c525',
      providerAccountId: ACCOUNT_ID,
    });
  });

  it('claim durável impede dois executores de emitir comandos upstream concorrentes', async () => {
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const provider = new FakeProviderAdapter({
      now: () => NOW,
      responses: {
        lookupInstance: { exists: false },
        reconcileProvisioning: {
          outcome: 'PROVISIONED',
          instance: { reference: { id: 'upstream-ref' }, status: 'CREATED' },
        },
      },
    });
    const realLookup = provider.lookupInstance.bind(provider);
    provider.lookupInstance = async (...arguments_) => {
      await lookupGate;
      return realLookup(...arguments_);
    };
    const test = harness(provider);
    const command = {
      organizationId: ORGANIZATION_ID,
      operationId: OPERATION_ID,
      requestId: '8ecfc8d2-3a67-42db-a3de-24fc99aef758',
      deadline: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    };

    const first = test.reconcile(command);
    await Promise.resolve();
    await expect(test.reconcile(command)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_FOUND' });
    releaseLookup();
    await first;

    expect(provider.calls.lookupInstance).toHaveLength(1);
    expect(provider.calls.reconcileProvisioning).toHaveLength(1);
  });
});
