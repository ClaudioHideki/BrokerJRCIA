import { describe, expect, it } from 'vitest';

import {
  FakeProviderAdapter,
  ProviderRegistry,
  type ConnectionAction,
  type ProviderStatus,
} from '@jrc/providers';

import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import {
  createInstanceService,
  InstanceServiceError,
  type InstanceRepository,
  type InstanceRow,
  type ProviderOperationRow,
} from '../../src/modules/instances/service.js';

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
        updatedAt: input.updatedAt,
        attemptCount: current.attemptCount + (input.incrementAttempt ? 1 : 0),
      });
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

describe('serviço de instâncias', () => {
  it('persiste PROVISIONING, commita, chama o provider e conclui CREATED em nova transação', async () => {
    const harness = createHarness({ visible: false });

    const result = await harness.service.createInstance(context(), {
      name: 'Primary',
      provider: 'BAILEYS',
      providerAccountId: ACCOUNT_ID,
      idempotencyKey: 'create-primary',
    });

    expect(harness.timeline).toEqual(['begin', 'commit', 'provider.provision', 'begin', 'commit']);
    expect(result.instance.status).toBe('CREATED');
    expect(result.pending).toBe(false);
    expect(harness.provider.calls.provisionInstance[0]?.input.upstreamInstanceKey)
      .toBe('jrc_519b77a6a4e5409a85c8d78fc155c525');
    expect(harness.audits).toEqual([expect.objectContaining({
      type: 'INSTANCE_CREATED',
      resourceId: INSTANCE_ID,
    })]);
  });

  it('marca timeout como incerto e reconciliável sem abrir terceira chamada provider', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'PROVIDER_TIMEOUT' });
    const provider = new FakeProviderAdapter({ now: () => NOW, errors: { provisionInstance: timeout } });
    const harness = createHarness({ visible: false, provider });

    const result = await harness.service.createInstance(context(), {
      name: 'Primary', provider: 'BAILEYS', providerAccountId: ACCOUNT_ID, idempotencyKey: 'timeout',
    });

    expect(result).toMatchObject({ pending: true, reconciliationRequired: true });
    expect(result.instance.status).toBe('PROVISIONING');
    expect([...harness.operations.values()][0]).toMatchObject({
      status: 'UNKNOWN',
      canonicalErrorCode: 'PROVIDER_TIMEOUT',
      reconciliationRequired: true,
    });
    expect(harness.provider.calls.provisionInstance).toHaveLength(1);
  });

  it('marca falha definida como PROVISIONING_FAILED e não persiste mensagem upstream', async () => {
    const failure = Object.assign(new Error('upstream leaked details'), { code: 'PROVIDER_REQUEST_FAILED' });
    const provider = new FakeProviderAdapter({ now: () => NOW, errors: { provisionInstance: failure } });
    const harness = createHarness({ visible: false, provider });

    const result = await harness.service.createInstance(context(), {
      name: 'Primary', provider: 'BAILEYS', providerAccountId: ACCOUNT_ID, idempotencyKey: 'failure',
    });

    expect(result.instance.status).toBe('PROVISIONING_FAILED');
    expect(JSON.stringify([...harness.operations.values()])).not.toContain('upstream leaked details');
  });

  it('replay de create e connect não repete provider nem serializa desafio', async () => {
    const challenge: ConnectionAction = {
      type: 'QR_CODE', encoding: 'BASE64', value: 'secret-qr-value', expiresAt: '2030-01-01T00:01:00.000Z',
    };
    const provider = new FakeProviderAdapter({ now: () => NOW, responses: { beginConnection: challenge } });
    const harness = createHarness({ visible: false, provider });
    const command = {
      name: 'Primary', provider: 'BAILEYS' as const, providerAccountId: ACCOUNT_ID, idempotencyKey: 'create',
    };

    await harness.service.createInstance(context(), command);
    const createReplay = await harness.service.createInstance(context(), command);
    expect(createReplay.replayed).toBe(true);
    expect(harness.provider.calls.provisionInstance).toHaveLength(1);

    const connected = await harness.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'connect',
    });
    expect(connected.action).toEqual(challenge);
    const replay = await harness.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'connect',
    });
    expect(replay).toMatchObject({
      replayed: true,
      pending: true,
      action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
    });
    expect(provider.calls.beginConnection).toHaveLength(1);
    expect(JSON.stringify([...harness.idempotency.values()])).not.toContain('secret-qr-value');
  });

  it('rejeita chave idempotente com payload diferente', async () => {
    const harness = createHarness({ visible: false });
    await harness.service.createInstance(context(), {
      name: 'Primary', provider: 'BAILEYS', providerAccountId: ACCOUNT_ID, idempotencyKey: 'same',
    });
    await expect(harness.service.createInstance(context(), {
      name: 'Changed', provider: 'BAILEYS', providerAccountId: ACCOUNT_ID, idempotencyKey: 'same',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('reproduz falha de connect sem repetir o provider e registra auditoria sanitizada', async () => {
    const failure = Object.assign(new Error('provider-body-canary'), { code: 'PROVIDER_REQUEST_FAILED' });
    const provider = new FakeProviderAdapter({ now: () => NOW, errors: { beginConnection: failure } });
    const harness = createHarness({ provider });
    const command = { instanceId: INSTANCE_ID, idempotencyKey: 'failed-connect' };

    await expect(harness.service.connectInstance(context(), command))
      .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });
    await expect(harness.service.connectInstance(context(), command))
      .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });

    expect(provider.calls.beginConnection).toHaveLength(1);
    expect(harness.audits).toContainEqual(expect.objectContaining({
      type: 'INSTANCE_CONNECT_FAILED',
      resourceId: INSTANCE_ID,
    }));
    expect(JSON.stringify(harness.audits)).not.toContain('provider-body-canary');
  });

  it.each(['PROVIDER_TIMEOUT', 'PROVIDER_ABORTED'] as const)(
    'reproduz %s de connect com a mesma chave e bloqueia nova chamada upstream durante a lease',
    async (errorCode) => {
      const provider = new FakeProviderAdapter({ now: () => NOW });
      const original = provider.beginConnection.bind(provider);
      let firstCall = true;
      provider.beginConnection = async (...args) => {
        const response = await original(...args);
        if (firstCall) {
          firstCall = false;
          throw Object.assign(new Error('uncertain-provider-result'), { code: errorCode });
        }
        return response;
      };
      const harness = createHarness({ provider });

      const command = {
        instanceId: INSTANCE_ID,
        idempotencyKey: `uncertain-${errorCode}`,
      };
      await expect(harness.service.connectInstance(context(), command))
        .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });

      expect(harness.rows.get(INSTANCE_ID)).toMatchObject({ status: 'CONNECTING' });
      expect([...harness.operations.values()]).toContainEqual(expect.objectContaining({
        operationType: 'CONNECT',
        status: 'PENDING',
        canonicalErrorCode: errorCode,
      }));
      await expect(harness.service.connectInstance(context(), command)).resolves.toMatchObject({
        replayed: true,
        pending: true,
        action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
      });
      await expect(harness.service.connectInstance(context(), {
        instanceId: INSTANCE_ID,
        idempotencyKey: `second-${errorCode}`,
      })).resolves.toMatchObject({
        pending: true,
        action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
      });
      expect(provider.calls.beginConnection).toHaveLength(1);
    },
  );

  it('normaliza falha de status como 502 e audita sem mensagem upstream', async () => {
    const failure = Object.assign(new Error('status-body-canary'), { code: 'PROVIDER_TIMEOUT' });
    const provider = new FakeProviderAdapter({ now: () => NOW, errors: { getStatus: failure } });
    const harness = createHarness({ provider });

    await expect(harness.service.getInstanceStatus(context(), INSTANCE_ID))
      .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });
    expect(harness.audits).toContainEqual(expect.objectContaining({
      type: 'INSTANCE_STATUS_FAILED',
      resourceId: INSTANCE_ID,
    }));
    expect(JSON.stringify(harness.audits)).not.toContain('status-body-canary');
  });

  it.each(['PROVIDER_TIMEOUT', 'PROVIDER_ABORTED'] as const)(
    'reproduz %s de disconnect com a mesma chave e bloqueia nova chamada upstream durante a lease',
    async (errorCode) => {
      const provider = new FakeProviderAdapter({
        now: () => NOW,
        responses: { getStatus: 'CONNECTED' },
      });
      const original = provider.disconnect.bind(provider);
      let firstCall = true;
      provider.disconnect = async (...args) => {
        await original(...args);
        if (firstCall) {
          firstCall = false;
          throw Object.assign(new Error('uncertain-provider-result'), { code: errorCode });
        }
      };
      const harness = createHarness({ provider, persistedStatus: 'CONNECTED' });
      const command = {
        instanceId: INSTANCE_ID,
        idempotencyKey: `uncertain-disconnect-${errorCode}`,
      };

      await expect(harness.service.disconnectInstance(context(), command))
        .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });
      expect(harness.rows.get(INSTANCE_ID)).toMatchObject({ status: 'DISCONNECTING' });
      expect([...harness.operations.values()]).toContainEqual(expect.objectContaining({
        operationType: 'DISCONNECT',
        status: 'PENDING',
        canonicalErrorCode: errorCode,
      }));
      await expect(harness.service.getInstanceStatus(context(), INSTANCE_ID))
        .resolves.toMatchObject({ status: 'DISCONNECTING' });
      await expect(harness.service.disconnectInstance(context(), command)).resolves.toMatchObject({
        replayed: true,
        pending: true,
        instance: { status: 'DISCONNECTING' },
      });
      await expect(harness.service.disconnectInstance(context(), {
        instanceId: INSTANCE_ID,
        idempotencyKey: `second-disconnect-${errorCode}`,
      })).resolves.toMatchObject({
        pending: true,
        instance: { status: 'DISCONNECTING' },
      });
      expect(provider.calls.disconnect).toHaveLength(1);
    },
  );

  it('expira lease antiga de disconnect e permite exatamente uma nova chamada ao provider', async () => {
    const harness = createHarness({
      persistedStatus: 'DISCONNECTING',
      persistedDisconnectUpdatedAt: new Date(NOW.getTime() - 60_001),
    });

    await harness.service.disconnectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'after-expired-disconnect-lease',
    });

    expect(harness.provider.calls.disconnect).toHaveLength(1);
    expect([...harness.operations.values()]).toContainEqual(expect.objectContaining({
      id: OPERATION_ID,
      status: 'UNKNOWN',
      canonicalErrorCode: 'DISCONNECT_LEASE_EXPIRED',
    }));
  });

  it('reproduz falha de disconnect sem retornar sucesso inconsistente', async () => {
    const failure = Object.assign(new Error('disconnect-body-canary'), { code: 'PROVIDER_REQUEST_FAILED' });
    const provider = new FakeProviderAdapter({ now: () => NOW, errors: { disconnect: failure } });
    const harness = createHarness({ provider, persistedStatus: 'CONNECTED' });
    const command = { instanceId: INSTANCE_ID, idempotencyKey: 'failed-disconnect' };

    await expect(harness.service.disconnectInstance(context(), command))
      .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });
    await expect(harness.service.disconnectInstance(context(), command))
      .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });

    expect(provider.calls.disconnect).toHaveLength(1);
    expect(harness.audits).toContainEqual(expect.objectContaining({
      type: 'INSTANCE_DISCONNECT_FAILED',
      resourceId: INSTANCE_ID,
    }));
  });

  it('rejeita cursor cujo id não é UUID antes de consultar o repositório', async () => {
    const harness = createHarness();
    const cursor = Buffer.from(JSON.stringify({
      organizationId: ORGANIZATION_A,
      createdAt: NOW.toISOString(),
      id: 'not-a-uuid',
    })).toString('base64url');

    await expect(harness.service.listInstances(context(), { limit: 20, cursor }))
      .rejects.toMatchObject({ code: 'INVALID_CURSOR', status: 400 });
  });

  it('não chama o provider para recurso invisível de outra organização', async () => {
    const harness = createHarness();

    await expect(harness.service.getInstanceStatus(context(ORGANIZATION_B), INSTANCE_ID))
      .rejects.toBeInstanceOf(InstanceServiceError);
    await expect(harness.service.connectInstance(context(ORGANIZATION_B), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'foreign-connect',
    })).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
    await expect(harness.service.disconnectInstance(context(ORGANIZATION_B), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'foreign-disconnect',
    })).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
    expect(harness.provider.calls.getStatus).toHaveLength(0);
    expect(harness.provider.calls.beginConnection).toHaveLength(0);
    expect(harness.provider.calls.disconnect).toHaveLength(0);
    expect(harness.timeline.slice(0, 4)).toEqual(['begin', 'commit', 'begin', 'commit']);
    expect(harness.audits).toEqual([expect.objectContaining({
      type: 'CROSS_TENANT_ACCESS_DENIED',
      organizationId: ORGANIZATION_B,
      resourceId: INSTANCE_ID,
    }), expect.anything(), expect.anything()]);
  });

  it('associa nova intenção a uma conexão pendente sem chamar o provider', async () => {
    const connecting = createHarness({ persistedStatus: 'CONNECTING' });
    await expect(connecting.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'another-connect',
    })).resolves.toMatchObject({
      pending: true,
      action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
    });
    expect(connecting.provider.calls.beginConnection).toHaveLength(0);

    const provisioning = createHarness({ persistedStatus: 'PROVISIONING' });
    await expect(provisioning.service.disconnectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'disconnect-too-early',
    })).rejects.toMatchObject({ code: 'INSTANCE_STATE_CONFLICT', status: 409 });
    expect(provisioning.provider.calls.disconnect).toHaveLength(0);
  });

  it('permite nova intenção em AWAITING_ACTION e mantém NONE/CONNECTION_PENDING sob lease', async () => {
    const challengeProvider = new FakeProviderAdapter({
      now: () => NOW,
      responses: {
        beginConnection: {
          type: 'PAIRING_CODE',
          code: '12345678',
          expiresAt: '2030-01-01T00:01:00.000Z',
        },
      },
    });
    const awaiting = createHarness({
      provider: challengeProvider,
      persistedStatus: 'AWAITING_ACTION',
    });
    await expect(awaiting.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'new-intent',
    })).resolves.toMatchObject({
      action: { type: 'PAIRING_CODE' },
      instance: { status: 'AWAITING_ACTION' },
    });
    expect(challengeProvider.calls.beginConnection).toHaveLength(1);

    const pendingProvider = new FakeProviderAdapter({
      now: () => NOW,
      responses: { beginConnection: { type: 'NONE', reason: 'CONNECTION_PENDING' } },
    });
    const pending = createHarness({ provider: pendingProvider });
    await expect(pending.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'pending-intent',
    })).resolves.toMatchObject({
      pending: true,
      action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
      instance: { status: 'CONNECTING' },
    });
    expect([...pending.operations.values()]).toContainEqual(expect.objectContaining({
      operationType: 'CONNECT',
      status: 'PENDING',
    }));
  });

  it('expira lease antiga e permite exatamente uma nova chamada ao provider', async () => {
    const stale = createHarness({
      persistedStatus: 'CONNECTING',
      persistedConnectUpdatedAt: new Date(NOW.getTime() - 60_001),
    });

    await stale.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'after-expired-lease',
    });

    expect(stale.provider.calls.beginConnection).toHaveLength(1);
    expect([...stale.operations.values()]).toContainEqual(expect.objectContaining({
      id: OPERATION_ID,
      status: 'UNKNOWN',
      canonicalErrorCode: 'CONNECT_LEASE_EXPIRED',
    }));
  });

  it('descarta desafio de uma operação superseded pelo fencing token', async () => {
    const challenge = {
      type: 'QR_CODE' as const,
      encoding: 'BASE64' as const,
      value: 'late-secret-qr',
      expiresAt: '2030-01-01T00:01:00.000Z',
    };
    const provider = new FakeProviderAdapter({ now: () => NOW });
    const original = provider.beginConnection.bind(provider);
    let release: ((action: ConnectionAction) => void) | undefined;
    provider.beginConnection = async (providerContext, input) => {
      await original(providerContext, input);
      return new Promise<ConnectionAction>((resolve) => { release = resolve; });
    };
    const test = createHarness({ provider });
    const pending = test.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'late-operation',
    });
    while (!release) await Promise.resolve();
    const old = [...test.operations.values()].find(({ operationType }) => operationType === 'CONNECT')!;
    test.operations.set(old.id, { ...old, status: 'UNKNOWN' });
    test.operations.set('a92b0b8d-dadb-4bd9-a273-89ed914ffa22', operation({
      id: 'a92b0b8d-dadb-4bd9-a273-89ed914ffa22',
      operationType: 'CONNECT',
      updatedAt: NOW,
    }));
    release(challenge);

    const result = await pending;
    expect(result.action).toEqual({ type: 'NONE', reason: 'CONNECTION_PENDING' });
    expect(result.instance.status).toBe('CONNECTING');
    expect(JSON.stringify(test.idempotency)).not.toContain('late-secret-qr');
  });

  it.each(['CREATED', 'DISCONNECTED', 'ERROR', 'AWAITING_ACTION'] as const)(
    'mantém uma lease CONNECT fresca durante polling %s e une a segunda intenção',
    async (polledStatus) => {
      const provider = new FakeProviderAdapter({
        now: () => NOW,
        responses: {
          beginConnection: {
            type: 'PAIRING_CODE',
            code: '12345678',
            expiresAt: '2030-01-01T00:01:00.000Z',
          },
          getStatus: polledStatus,
        },
      });
      const original = provider.beginConnection.bind(provider);
      let releaseFirst: (() => void) | undefined;
      let firstCall = true;
      provider.beginConnection = async (...args) => {
        const action = await original(...args);
        if (!firstCall) return action;
        firstCall = false;
        return new Promise<ConnectionAction>((resolve) => {
          releaseFirst = () => resolve(action);
        });
      };
      const harness = createHarness({ provider });
      const first = harness.service.connectInstance(context(), {
        instanceId: INSTANCE_ID,
        idempotencyKey: `blocked-${polledStatus}`,
      });
      while (!releaseFirst) await Promise.resolve();

      try {
        await harness.service.getInstanceStatus(context(), INSTANCE_ID);
        const joined = await harness.service.connectInstance(context(), {
          instanceId: INSTANCE_ID,
          idempotencyKey: `joined-after-${polledStatus}`,
        });

        expect(joined).toMatchObject({
          pending: true,
          action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
        });
        expect(provider.calls.beginConnection).toHaveLength(1);
        expect([...harness.operations.values()]).toContainEqual(expect.objectContaining({
          operationType: 'CONNECT',
          status: 'PENDING',
        }));
      } finally {
        releaseFirst();
        await first;
      }
    },
  );

  it('descarta polling obsoleto quando uma conexão conclui durante a chamada upstream', async () => {
    const provider = new FakeProviderAdapter({
      now: () => NOW,
      responses: {
        beginConnection: {
          type: 'QR_CODE',
          encoding: 'BASE64',
          value: 'one-time-secret',
          expiresAt: '2030-01-01T00:01:00.000Z',
        },
        getStatus: 'CREATED',
      },
    });
    const originalGetStatus = provider.getStatus.bind(provider);
    let releaseStatus: ((status: ProviderStatus) => void) | undefined;
    provider.getStatus = async (...args) => {
      const observed = await originalGetStatus(...args);
      return new Promise<ProviderStatus>((resolve) => {
        releaseStatus = () => resolve(observed);
      });
    };
    const harness = createHarness({ provider });
    const stalePoll = harness.service.getInstanceStatus(context(), INSTANCE_ID);
    while (!releaseStatus) await Promise.resolve();

    const connected = await harness.service.connectInstance(context(), {
      instanceId: INSTANCE_ID,
      idempotencyKey: 'connect-during-poll',
    });
    expect(connected.instance.status).toBe('AWAITING_ACTION');

    releaseStatus('CREATED');
    await expect(stalePoll).resolves.toMatchObject({ status: 'AWAITING_ACTION' });
    expect(provider.calls.beginConnection).toHaveLength(1);
  });

  it('lista e consulta somente registros do tenant e executa status/disconnect fora da transação', async () => {
    const provider = new FakeProviderAdapter({ now: () => NOW, responses: { getStatus: 'CONNECTED' } });
    const harness = createHarness({ provider });

    await expect(harness.service.listInstances(context(), { limit: 20 })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: INSTANCE_ID })],
    });
    await expect(harness.service.getInstance(context(), INSTANCE_ID)).resolves.toMatchObject({ id: INSTANCE_ID });
    await expect(harness.service.getInstanceStatus(context(), INSTANCE_ID)).resolves.toMatchObject({ status: 'CONNECTED' });
    await expect(harness.service.disconnectInstance(context(), {
      instanceId: INSTANCE_ID, idempotencyKey: 'disconnect',
    })).resolves.toMatchObject({ instance: { status: 'DISCONNECTED' } });
    expect(provider.calls.getStatus).toHaveLength(1);
    expect(provider.calls.disconnect).toHaveLength(1);
  });
});

it('blocks suspended organization pairing before calling a provider', async () => {
  const harness = createHarness({ active: false });
  await expect(harness.service.connectInstance(context(), { instanceId: INSTANCE_ID, idempotencyKey: 'suspended' }))
    .rejects.toMatchObject({ code: 'ORGANIZATION_NOT_ACTIVE' });
  expect(harness.operations.size).toBe(0);
});
