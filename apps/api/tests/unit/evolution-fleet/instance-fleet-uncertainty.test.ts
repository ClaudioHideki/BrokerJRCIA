import { describe, expect, it } from 'vitest';

import {
  FakeProviderAdapter,
  ProviderRegistry,
  type ConnectionAction,
  type ProviderStatus,
} from '@jrc/providers';

import type { TenantTransaction } from '../../../src/db/tenant-transaction.js';
import {
  createInstanceService,
  InstanceServiceError,
  type InstanceRepository,
  type InstanceRow,
  type ProviderOperationRow,
} from '../../../src/modules/instances/service.js';

const ORGANIZATION_A = 'c9fd2146-457a-4b6c-8359-c8f96fb0f077';
const ORGANIZATION_B = 'b0a5d1af-72cf-483d-b769-cf3b820dad55';
const USER_ID = 'c3ee8b86-5269-4377-9144-cec1ac3b0040';
const ACCOUNT_ID = 'ac282057-7f9c-4a91-93c9-82e4cedfa157';
const INSTANCE_ID = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const OPERATION_ID = 'a92b0b8d-dadb-4bd9-a273-89ed914ffabb';
const REQUEST_ID = '8ecfc8d2-3a67-42db-a3de-24fc99aef758';
const NOW = new Date('2030-01-01T00:00:00.000Z');

function instance(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: INSTANCE_ID,
    organizationId: ORGANIZATION_A,
    providerAccountId: ACCOUNT_ID,
    name: 'Primary',
    provider: 'BAILEYS',
    upstreamInstanceKey: 'jrc_519b77a6a4e5409a85c8d78fc155c525',
    externalReference: 'fake-instance',
    status: 'CREATED',
    capabilities: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function operation(overrides: Partial<ProviderOperationRow> = {}): ProviderOperationRow {
  return {
    id: OPERATION_ID,
    organizationId: ORGANIZATION_A,
    instanceId: INSTANCE_ID,
    operationType: 'PROVISION',
    status: 'PENDING',
    attemptCount: 0,
    canonicalErrorCode: null,
    reconciliationRequired: false,
    updatedAt: NOW,
    ...overrides,
  };
}

function createHarness(options: {
  provider?: FakeProviderAdapter;
  visible?: boolean;
  active?: boolean;
  persistedStatus?: InstanceRow['status'];
  persistedConnectUpdatedAt?: Date;
  persistedDisconnectUpdatedAt?: Date;
} = {}) {
  const timeline: string[] = [];
  const audits: unknown[] = [];
  const rows = new Map<string, InstanceRow>();
  const operations = new Map<string, ProviderOperationRow>();
  const idempotency = new Map<string, {
    requestHash: string;
    operationId: string | null;
    status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    responseMetadata: Record<string, unknown>;
  }>();
  if (options.visible !== false) rows.set(INSTANCE_ID, instance({ status: options.persistedStatus ?? 'CREATED' }));
  if (options.persistedStatus === 'CONNECTING') {
    operations.set(OPERATION_ID, operation({
      operationType: 'CONNECT',
      updatedAt: options.persistedConnectUpdatedAt ?? NOW,
    }));
  }
  if (options.persistedStatus === 'DISCONNECTING') {
    operations.set(OPERATION_ID, operation({
      operationType: 'DISCONNECT',
      updatedAt: options.persistedDisconnectUpdatedAt ?? NOW,
    }));
  }
  const repository: InstanceRepository = {
    async findProviderAccount() { return { id: ACCOUNT_ID, organizationId: ORGANIZATION_A, provider: 'BAILEYS' }; },
    async insertProvisioning(_tx, input) {
      const row = instance({
        id: input.id,
        name: input.name,
        upstreamInstanceKey: input.upstreamInstanceKey,
        externalReference: null,
        status: 'PROVISIONING',
      });
      const op = operation({
        id: OPERATION_ID,
        instanceId: input.id,
        reconciliationRequired: true,
      });
      rows.set(row.id, row);
      operations.set(op.id, op);
      return { instance: row, operation: op };
    },
    async findById(_tx, organizationId, id) {
      const row = rows.get(id);
      return row?.organizationId === organizationId ? row : null;
    },
    async findByIdForUpdate(_tx, organizationId, id) {
      const row = rows.get(id);
      return row?.organizationId === organizationId ? row : null;
    },
    async findByOperation(_tx, organizationId, operationId) {
      const op = operations.get(operationId);
      return op?.organizationId === organizationId ? rows.get(op.instanceId) ?? null : null;
    },
    async list(_tx, organizationId) {
      return [...rows.values()].filter((row) => row.organizationId === organizationId);
    },
    async createOperation(_tx, input) {
      const op = operation({
        id: `${OPERATION_ID.slice(0, -1)}${operations.size}`,
        instanceId: input.instanceId,
        operationType: input.operationType,
        updatedAt: input.updatedAt ?? NOW,
      });
      operations.set(op.id, op);
      return op;
    },
    async findPendingConnectOperationForUpdate(_tx, organizationId, instanceId) {
      return [...operations.values()].find((candidate) => (
        candidate.organizationId === organizationId
        && candidate.instanceId === instanceId
        && candidate.operationType === 'CONNECT'
        && candidate.status === 'PENDING'
      )) ?? null;
    },
    async findLatestConnectOperationForUpdate(_tx, organizationId, instanceId) {
      return [...operations.values()].filter((candidate) => (
        candidate.organizationId === organizationId
        && candidate.instanceId === instanceId
        && candidate.operationType === 'CONNECT'
      )).at(-1) ?? null;
    },
    async findPendingDisconnectOperationForUpdate(_tx, organizationId, instanceId) {
      return [...operations.values()].find((candidate) => (
        candidate.organizationId === organizationId
        && candidate.instanceId === instanceId
        && candidate.operationType === 'DISCONNECT'
        && candidate.status === 'PENDING'
      )) ?? null;
    },
    async updatePendingConnectOperation(_tx, input) {
      const current = operations.get(input.operationId);
      if (
        !current
        || current.organizationId !== input.organizationId
        || current.instanceId !== input.instanceId
        || current.operationType !== 'CONNECT'
        || current.status !== 'PENDING'
      ) return false;
      operations.set(current.id, {
        ...current,
        status: input.status,
        canonicalErrorCode: input.canonicalErrorCode,
        reconciliationRequired: input.reconciliationRequired ?? current.reconciliationRequired,
        updatedAt: input.updatedAt,
        attemptCount: current.attemptCount + (input.incrementAttempt ? 1 : 0),
      });
      return true;
    },
    async resolveUncertainConnectOperation(_tx, input) {
      const current = operations.get(input.operationId);
      if (!current || current.organizationId !== input.organizationId
        || current.instanceId !== input.instanceId || !current.reconciliationRequired
        || (current.status !== 'UNKNOWN' && current.status !== 'FAILED')) return false;
      operations.set(current.id, { ...current, status: 'SUCCEEDED', canonicalErrorCode: null,
        reconciliationRequired: false, updatedAt: input.updatedAt });
      return true;
    },
    async updatePendingDisconnectOperation(_tx, input) {
      const current = operations.get(input.operationId);
      if (
        !current
        || current.organizationId !== input.organizationId
        || current.instanceId !== input.instanceId
        || current.operationType !== 'DISCONNECT'
        || current.status !== 'PENDING'
      ) return false;
      operations.set(current.id, {
        ...current,
        status: input.status,
        canonicalErrorCode: input.canonicalErrorCode,
        updatedAt: input.updatedAt,
        attemptCount: current.attemptCount + (input.incrementAttempt ? 1 : 0),
      });
      return true;
    },
    async updateInstanceState(_tx, input) {
      const current = rows.get(input.instanceId);
      if (!current || current.organizationId !== input.organizationId) return null;
      const updated = instance({ ...current, ...input, updatedAt: NOW });
      rows.set(updated.id, updated);
      return updated;
    },
    async completeOperation(_tx, input) {
      const current = operations.get(input.operationId);
      if (!current || current.organizationId !== input.organizationId) return;
      operations.set(current.id, { ...current, ...input });
    },
    async claimProvisioningOperation(_tx, organizationId, operationId) {
      const op = operations.get(operationId);
      const row = op ? rows.get(op.instanceId) : undefined;
      return op?.organizationId === organizationId && row ? { instance: row, operation: op } : null;
    },
    async claimIdempotency(_tx, input) {
      const mapKey = `${input.organizationId}:${input.route}:${input.key}`;
      const existing = idempotency.get(mapKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), { code: 'IDEMPOTENCY_CONFLICT' });
        }
        return {
          kind: 'REPLAY' as const,
          record: {
            id: mapKey,
            organizationId: input.organizationId,
            route: input.route,
            idempotencyKey: input.key,
            requestHash: existing.requestHash,
            operationId: existing.operationId,
            status: existing.status,
            responseMetadata: existing.responseMetadata,
            expiresAt: input.expiresAt,
          },
        };
      }
      idempotency.set(mapKey, {
        requestHash: input.requestHash,
        operationId: null,
        status: 'IN_PROGRESS',
        responseMetadata: {},
      });
      return { kind: 'CLAIMED' as const, recordId: mapKey };
    },
    async linkIdempotency(_tx, input) {
      const found = idempotency.get(input.recordId)!;
      idempotency.set(input.recordId, {
        ...found,
        operationId: input.operationId,
        responseMetadata: { ...input.responseMetadata },
      });
    },
    async completeIdempotency(_tx, input) {
      const found = idempotency.get(input.recordId)!;
      idempotency.set(input.recordId, {
        ...found,
        status: input.status,
        responseMetadata: { ...input.responseMetadata },
      });
    },
  };
  const provider = options.provider ?? new FakeProviderAdapter({ now: () => NOW });
  const originalProvision = provider.provisionInstance.bind(provider);
  provider.provisionInstance = async (...args) => {
    timeline.push('provider.provision');
    return originalProvision(...args);
  };
  const service = createInstanceService({
    repository,
    providers: new ProviderRegistry([provider], [['BAILEYS', provider]]),
    now: () => NOW,
    randomUuid: () => INSTANCE_ID,
    runInOrganizationTransaction: async (_organizationId, callback) => {
      timeline.push('begin');
      try {
        const value = await callback({ query: async () => ({ rows: [{ active: options.active !== false }], rowCount: 1 }) } as unknown as TenantTransaction);
        timeline.push('commit');
        return value;
      } catch (error) {
        timeline.push('rollback');
        throw error;
      }
    },
    writeAudit: async (_tx, event) => { audits.push(event); },
  });
  return { audits, idempotency, operations, provider, repository, rows, service, timeline };
}

function context(organizationId = ORGANIZATION_A) {
  return {
    credentialKind: 'JWT' as const,
    organizationId,
    actorId: USER_ID,
    requestId: REQUEST_ID,
    deadline: new Date(NOW.getTime() + 60_000),
    signal: new AbortController().signal,
  };
}


it.each(['EVOLUTION_ENGINE_BINDING_CHANGED','EVOLUTION_ENGINE_LEASE_CHANGED'])('preserves %s after dispatched fleet I/O as UNKNOWN in the canonical instance saga',async code=>{
 const provider=new FakeProviderAdapter({now:()=>NOW,errors:{provisionInstance:Object.assign(new Error('synthetic post-I/O guard'),{code,uncertain:true})}});
 const h=createHarness({visible:false,provider});const result=await h.service.createInstance(context(),{name:'Primary',provider:'BAILEYS',providerAccountId:ACCOUNT_ID,idempotencyKey:code});
 expect(result).toMatchObject({pending:true,reconciliationRequired:true});expect([...h.operations.values()][0]).toMatchObject({status:'UNKNOWN',canonicalErrorCode:code,reconciliationRequired:true});expect(provider.calls.provisionInstance).toHaveLength(1);
});
