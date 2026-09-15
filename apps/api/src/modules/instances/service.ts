import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { randomUUID } from 'node:crypto';

import type { Instance, InstanceStatus, Page, ProviderKind } from '@jrc/contracts';
import {
  type ConnectionAction,
  type ProviderContext,
  type ProviderStatus,
  type WhatsAppProvider,
} from '@jrc/providers';

import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { TenantAuditEvent } from '../audit/audit.js';
import {
  IdempotencyConflictError,
  hashIdempotencyRequest,
} from './idempotency.js';
import {
  type InstanceCursor,
  type InstanceRepository,
  type InstanceRow,
  type ProviderOperationRow,
} from './repository.js';
import { deriveUpstreamInstanceKey } from './upstream-key.js';

export type {
  InstanceCursor,
  InstanceRepository,
  InstanceRow,
  ProviderOperationRow,
} from './repository.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const CONNECT_LEASE_MS = 60_000;
const DISCONNECT_LEASE_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InstanceActorContext = Readonly<{
  organizationId: string;
  requestId: string;
  deadline: Date;
  signal: AbortSignal;
}> & (
  | Readonly<{ credentialKind: 'JWT'; actorId: string }>
  | Readonly<{ credentialKind: 'API_KEY'; actorId: null; apiKeyId: string }>
);

export interface CreateInstanceCommand {
  name: string;
  provider: ProviderKind;
  providerAccountId: string;
  idempotencyKey: string;
}

export interface ConnectInstanceCommand {
  instanceId: string;
  idempotencyKey: string;
  pairingHint?: string;
}

export interface DisconnectInstanceCommand {
  instanceId: string;
  idempotencyKey: string;
}

export interface InstanceMutationResult {
  instance: Instance;
  operationId: string | null;
  replayed: boolean;
  pending: boolean;
  reconciliationRequired: boolean;
}

export interface ConnectionResult extends InstanceMutationResult {
  action: ConnectionAction;
}

export interface InstanceService {
  createInstance(context: InstanceActorContext, command: CreateInstanceCommand): Promise<InstanceMutationResult>;
  listInstances(context: InstanceActorContext, input: { limit: number; cursor?: string }): Promise<Page<Instance>>;
  getInstance(context: InstanceActorContext, instanceId: string): Promise<Instance>;
  connectInstance(context: InstanceActorContext, command: ConnectInstanceCommand): Promise<ConnectionResult>;
  getInstanceStatus(context: InstanceActorContext, instanceId: string): Promise<Instance>;
  disconnectInstance(context: InstanceActorContext, command: DisconnectInstanceCommand): Promise<InstanceMutationResult>;
}

export interface CommonProviderRegistry {
  getProvider(kind: ProviderKind): WhatsAppProvider;
}

export interface InstanceServiceDependencies {
  repository: InstanceRepository;
  providers: CommonProviderRegistry;
  runInOrganizationTransaction<T>(
    organizationId: string,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T>;
  writeAudit(transaction: TenantTransaction, event: TenantAuditEvent): Promise<void>;
  now?: () => Date;
  randomUuid?: () => string;
  idempotencyTtlMs?: number;
  connectLeaseMs?: number;
  disconnectLeaseMs?: number;
}

export type InstanceServiceErrorCode =
  | 'INSTANCE_NOT_FOUND'
  | 'PROVIDER_ACCOUNT_NOT_FOUND'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CURSOR'
  | 'CURSOR_NOT_FOUND'
  | 'INSTANCE_STATE_CONFLICT'
  | 'PROVIDER_OPERATION_FAILED';

export class InstanceServiceError extends Error {
  constructor(
    readonly code: InstanceServiceErrorCode,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(code);
    this.name = 'InstanceServiceError';
  }
}

function asInstance(row: InstanceRow): Instance {
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerAccountId: row.providerAccountId,
    name: row.name,
    provider: row.provider,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function providerContext(context: InstanceActorContext): ProviderContext {
  return {
    organizationId: context.organizationId,
    requestId: context.requestId,
    deadline: context.deadline,
    signal: context.signal,
  };
}

function auditActor(context: InstanceActorContext) {
  return context.credentialKind === 'API_KEY'
    ? { actorId: null, actorKind: 'API_KEY' as const, actorApiKeyId: context.apiKeyId }
    : { actorId: context.actorId };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ? code
    : 'PROVIDER_OPERATION_FAILED';
}

function isUncertain(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_ABORTED';
}

function providerStatusToInstanceStatus(status: ProviderStatus): InstanceStatus {
  return status;
}

function connectionStatus(action: ConnectionAction): InstanceStatus {
  if (action.type !== 'NONE') return 'AWAITING_ACTION';
  return action.reason === 'ALREADY_CONNECTED' ? 'CONNECTED' : 'CONNECTING';
}

function replayConnectionAction(status: InstanceStatus): ConnectionAction {
  return status === 'CONNECTED'
    ? { type: 'NONE', reason: 'ALREADY_CONNECTED' }
    : { type: 'NONE', reason: 'CONNECTION_PENDING' };
}

function isSameInstanceSnapshot(current: InstanceRow, observed: InstanceRow): boolean {
  return current.status === observed.status
    && current.updatedAt.getTime() === observed.updatedAt.getTime();
}

function encodeCursor(row: InstanceRow): string {
  return Buffer.from(JSON.stringify({
    organizationId: row.organizationId,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  }), 'utf8').toString('base64url');
}

function decodeCursor(value: string, organizationId: string): InstanceCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'createdAt,id,organizationId'
      || typeof parsed.organizationId !== 'string'
      || typeof parsed.createdAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.id !== 'string'
      || !UUID_PATTERN.test(parsed.id)
    ) throw new Error('invalid');
    if (parsed.organizationId !== organizationId) {
      throw new InstanceServiceError('CURSOR_NOT_FOUND', 404);
    }
    return { organizationId, createdAt: parsed.createdAt, id: parsed.id };
  } catch (error) {
    if (error instanceof InstanceServiceError) throw error;
    throw new InstanceServiceError('INVALID_CURSOR', 400);
  }
}

async function persistAccessDenied(
  dependencies: InstanceServiceDependencies,
  context: InstanceActorContext,
  resourceId: string,
): Promise<void> {
  await dependencies.runInOrganizationTransaction(
    context.organizationId,
    (transaction) => dependencies.writeAudit(transaction, {
      type: 'CROSS_TENANT_ACCESS_DENIED',
      organizationId: context.organizationId,
      ...auditActor(context),
      resourceId,
      requestId: context.requestId,
    }),
  );
}

async function denyNotFound(
  dependencies: InstanceServiceDependencies,
  context: InstanceActorContext,
  resourceId: string,
): Promise<never> {
  await persistAccessDenied(dependencies, context, resourceId);
  throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
}

function translateIdempotencyError(error: unknown): never {
  if (error instanceof IdempotencyConflictError || (error as { code?: unknown })?.code === 'IDEMPOTENCY_CONFLICT') {
    throw new InstanceServiceError('IDEMPOTENCY_CONFLICT', 409);
  }
  throw error;
}

export function createInstanceService(dependencies: InstanceServiceDependencies): InstanceService {
  const now = dependencies.now ?? (() => new Date());
  const randomUuid = dependencies.randomUuid ?? randomUUID;
  const idempotencyTtlMs = dependencies.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  const connectLeaseMs = dependencies.connectLeaseMs ?? CONNECT_LEASE_MS;
  const disconnectLeaseMs = dependencies.disconnectLeaseMs ?? DISCONNECT_LEASE_MS;

  async function replayInstance(
    transaction: TenantTransaction,
    organizationId: string,
    operationId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<InstanceRow> {
    const byOperation = operationId
      ? await dependencies.repository.findByOperation(transaction, organizationId, operationId)
      : null;
    if (byOperation) return byOperation;
    const instanceId = metadata.instanceId;
    if (typeof instanceId === 'string') {
      const byId = await dependencies.repository.findById(transaction, organizationId, instanceId);
      if (byId) return byId;
    }
    throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
  }

  async function claim(
    transaction: TenantTransaction,
    input: { organizationId: string; route: string; key: string; request: unknown },
  ) {
    try {
      return await dependencies.repository.claimIdempotency(transaction, {
        organizationId: input.organizationId,
        route: input.route,
        key: input.key,
        requestHash: hashIdempotencyRequest(input.request),
        expiresAt: new Date(now().getTime() + idempotencyTtlMs),
      });
    } catch (error) {
      return translateIdempotencyError(error);
    }
  }

  return {
    async createInstance(context, command) {
      const initial = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          await requireActiveOrganization(transaction, context.organizationId);
          const providerAccount = await dependencies.repository.findProviderAccount(
            transaction,
            context.organizationId,
            command.providerAccountId,
          );
          if (!providerAccount) throw new InstanceServiceError('PROVIDER_ACCOUNT_NOT_FOUND', 404);
          if (providerAccount.provider !== command.provider) {
            throw new InstanceServiceError('PROVIDER_ACCOUNT_MISMATCH', 400);
          }
          const idempotency = await claim(transaction, {
            organizationId: context.organizationId,
            route: '/v1/instances',
            key: command.idempotencyKey,
            request: {
              name: command.name,
              provider: command.provider,
              providerAccountId: command.providerAccountId,
            },
          });
          if (idempotency.kind === 'REPLAY') {
            return {
              kind: 'REPLAY' as const,
              instance: await replayInstance(
                transaction,
                context.organizationId,
                idempotency.record.operationId,
                idempotency.record.responseMetadata,
              ),
              operationId: idempotency.record.operationId,
              idempotencyStatus: idempotency.record.status,
              reconciliationRequired: idempotency.record.responseMetadata.reconciliationRequired === true,
            };
          }
          const instanceId = randomUuid();
          const created = await dependencies.repository.insertProvisioning(transaction, {
            id: instanceId,
            organizationId: context.organizationId,
            providerAccountId: providerAccount.id,
            provider: providerAccount.provider,
            name: command.name,
            upstreamInstanceKey: deriveUpstreamInstanceKey(instanceId),
          });
          await dependencies.repository.linkIdempotency(transaction, {
            organizationId: context.organizationId,
            recordId: idempotency.recordId,
            operationId: created.operation.id,
            responseMetadata: {
              instanceId: created.instance.id,
              status: 'PROVISIONING',
              reconciliationRequired: true,
            },
          });
          await dependencies.writeAudit(transaction, {
            type: 'INSTANCE_CREATED',
            organizationId: context.organizationId,
            ...auditActor(context),
            resourceId: created.instance.id,
            requestId: context.requestId,
          });
          return { kind: 'NEW' as const, ...created, idempotencyRecordId: idempotency.recordId };
        },
      );
      if (initial.kind === 'REPLAY') {
        return {
          instance: asInstance(initial.instance),
          operationId: initial.operationId,
          replayed: true,
          pending: initial.idempotencyStatus === 'IN_PROGRESS'
            || initial.instance.status === 'PROVISIONING',
          reconciliationRequired: initial.reconciliationRequired,
        };
      }

      let finalStatus: InstanceStatus = 'CREATED';
      let externalReference: string | null = null;
      let operationStatus: ProviderOperationRow['status'] = 'SUCCEEDED';
      let canonicalErrorCode: string | null = null;
      let reconciliationRequired = false;
      try {
        const provisioned = await dependencies.providers.getProvider(command.provider).provisionInstance(
          providerContext(context),
          {
            upstreamInstanceKey: initial.instance.upstreamInstanceKey,
            providerAccountId: command.providerAccountId,
          },
        );
        externalReference = provisioned.reference.id;
      } catch (error) {
        canonicalErrorCode = errorCode(error);
        reconciliationRequired = isUncertain(error);
        operationStatus = reconciliationRequired ? 'UNKNOWN' : 'FAILED';
        finalStatus = reconciliationRequired ? 'PROVISIONING' : 'PROVISIONING_FAILED';
      }

      const completed = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          const updated = await dependencies.repository.updateInstanceState(transaction, {
            organizationId: context.organizationId,
            instanceId: initial.instance.id,
            status: finalStatus,
            ...(externalReference === null ? {} : { externalReference }),
          });
          if (!updated) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
          await dependencies.repository.completeOperation(transaction, {
            organizationId: context.organizationId,
            operationId: initial.operation.id,
            status: operationStatus,
            canonicalErrorCode,
            reconciliationRequired,
          });
          await dependencies.repository.completeIdempotency(transaction, {
            organizationId: context.organizationId,
            recordId: initial.idempotencyRecordId,
            status: 'COMPLETED',
            responseMetadata: {
              instanceId: updated.id,
              status: updated.status,
              reconciliationRequired,
            },
          });
          return updated;
        },
      );
      return {
        instance: asInstance(completed),
        operationId: initial.operation.id,
        replayed: false,
        pending: reconciliationRequired,
        reconciliationRequired,
      };
    },

    async listInstances(context, input) {
      const cursor = input.cursor ? decodeCursor(input.cursor, context.organizationId) : null;
      const rows = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        (transaction) => dependencies.repository.list(
          transaction,
          context.organizationId,
          input.limit + 1,
          cursor,
        ),
      );
      const selected = rows.slice(0, input.limit);
      const hasNextPage = rows.length > input.limit;
      return {
        data: selected.map(asInstance),
        pageInfo: {
          hasNextPage,
          nextCursor: hasNextPage && selected.length > 0
            ? encodeCursor(selected[selected.length - 1]!)
            : null,
        },
      };
    },

    async getInstance(context, instanceId) {
      const row = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        (transaction) => dependencies.repository.findById(
          transaction,
          context.organizationId,
          instanceId,
        ),
      );
      if (!row) return denyNotFound(dependencies, context, instanceId);
      return asInstance(row);
    },

    async connectInstance(context, command) {
      const route = `/v1/instances/${command.instanceId}/connect`;
      const acquiredAt = now();
      const initial = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          await requireActiveOrganization(transaction, context.organizationId);
          const instance = await dependencies.repository.findByIdForUpdate(
            transaction,
            context.organizationId,
            command.instanceId,
          );
          if (!instance) return { kind: 'NOT_FOUND' as const };
          const idempotency = await claim(transaction, {
            organizationId: context.organizationId,
            route,
            key: command.idempotencyKey,
            request: { instanceId: command.instanceId, pairingHint: command.pairingHint ?? null },
          });
          if (idempotency.kind === 'REPLAY') {
            if (idempotency.record.status === 'FAILED') {
              throw new InstanceServiceError('PROVIDER_OPERATION_FAILED', 502);
            }
            return { kind: 'REPLAY' as const, instance, operationId: idempotency.record.operationId };
          }
          if (instance.status === 'CONNECTED') {
            await dependencies.repository.completeIdempotency(transaction, {
              organizationId: context.organizationId,
              recordId: idempotency.recordId,
              status: 'COMPLETED',
              responseMetadata: { instanceId: instance.id, status: instance.status, actionType: 'NONE' },
            });
            return { kind: 'ALREADY_CONNECTED' as const, instance };
          }

          if (instance.status === 'CONNECTING') {
            const active = await dependencies.repository.findPendingConnectOperationForUpdate(
              transaction,
              context.organizationId,
              instance.id,
            );
            if (
              active
              && active.updatedAt.getTime() > acquiredAt.getTime() - connectLeaseMs
            ) {
              await dependencies.repository.linkIdempotency(transaction, {
                organizationId: context.organizationId,
                recordId: idempotency.recordId,
                operationId: active.id,
                responseMetadata: { instanceId: instance.id, status: 'CONNECTING', actionType: 'NONE' },
              });
              await dependencies.repository.completeIdempotency(transaction, {
                organizationId: context.organizationId,
                recordId: idempotency.recordId,
                status: 'COMPLETED',
                responseMetadata: { instanceId: instance.id, status: 'CONNECTING', actionType: 'NONE' },
              });
              return { kind: 'JOINED' as const, instance, operationId: active.id };
            }
            if (active) {
              await dependencies.repository.updatePendingConnectOperation(transaction, {
                organizationId: context.organizationId,
                instanceId: instance.id,
                operationId: active.id,
                status: 'UNKNOWN',
                canonicalErrorCode: 'CONNECT_LEASE_EXPIRED',
                updatedAt: acquiredAt,
              });
            }
          } else if (!['CREATED', 'DISCONNECTED', 'ERROR', 'AWAITING_ACTION'].includes(instance.status)) {
            throw new InstanceServiceError('INSTANCE_STATE_CONFLICT', 409);
          }

          const operation = await dependencies.repository.createOperation(transaction, {
            organizationId: context.organizationId,
            instanceId: instance.id,
            operationType: 'CONNECT',
            updatedAt: acquiredAt,
          });
          const connecting = await dependencies.repository.updateInstanceState(transaction, {
            organizationId: context.organizationId,
            instanceId: instance.id,
            status: 'CONNECTING',
          });
          if (!connecting) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
          await dependencies.repository.linkIdempotency(transaction, {
            organizationId: context.organizationId,
            recordId: idempotency.recordId,
            operationId: operation.id,
            responseMetadata: { instanceId: instance.id, status: 'CONNECTING' },
          });
          return {
            kind: 'NEW' as const,
            instance: connecting,
            operation,
            idempotencyRecordId: idempotency.recordId,
          };
        },
      );
      if (initial.kind === 'NOT_FOUND') {
        return denyNotFound(dependencies, context, command.instanceId);
      }
      if (initial.kind === 'REPLAY') {
        return {
          instance: asInstance(initial.instance),
          operationId: initial.operationId,
          replayed: true,
          pending: initial.instance.status !== 'CONNECTED',
          reconciliationRequired: false,
          action: replayConnectionAction(initial.instance.status),
        };
      }
      if (initial.kind === 'JOINED') {
        return {
          instance: asInstance(initial.instance),
          operationId: initial.operationId,
          replayed: false,
          pending: true,
          reconciliationRequired: false,
          action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
        };
      }
      if (initial.kind === 'ALREADY_CONNECTED') {
        return {
          instance: asInstance(initial.instance),
          operationId: null,
          replayed: false,
          pending: false,
          reconciliationRequired: false,
          action: { type: 'NONE', reason: 'ALREADY_CONNECTED' },
        };
      }

      const staleResult = async (): Promise<ConnectionResult> => {
        const current = await dependencies.runInOrganizationTransaction(
          context.organizationId,
          (transaction) => dependencies.repository.findById(
            transaction,
            context.organizationId,
            initial.instance.id,
          ),
        );
        if (!current) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
        return {
          instance: asInstance(current),
          operationId: initial.operation.id,
          replayed: false,
          pending: current.status !== 'CONNECTED',
          reconciliationRequired: false,
          action: replayConnectionAction(current.status),
        };
      };

      let action: ConnectionAction;
      try {
        action = await dependencies.providers.getProvider(initial.instance.provider).beginConnection(
          providerContext(context),
          {
            reference: { id: initial.instance.externalReference ?? initial.instance.upstreamInstanceKey },
            ...(command.pairingHint === undefined ? {} : { pairingHint: command.pairingHint }),
          },
        );
      } catch (error) {
        const uncertain = isUncertain(error);
        const applied = await dependencies.runInOrganizationTransaction(
          context.organizationId,
          async (transaction) => {
            const locked = await dependencies.repository.findByIdForUpdate(
              transaction,
              context.organizationId,
              initial.instance.id,
            );
            if (!locked) return false;
            const fenced = await dependencies.repository.updatePendingConnectOperation(transaction, {
              organizationId: context.organizationId,
              instanceId: initial.instance.id,
              operationId: initial.operation.id,
              status: uncertain ? 'PENDING' : 'FAILED',
              canonicalErrorCode: errorCode(error),
              updatedAt: now(),
              incrementAttempt: true,
            });
            if (!fenced) return false;
            await dependencies.repository.updateInstanceState(transaction, {
              organizationId: context.organizationId,
              instanceId: initial.instance.id,
              status: uncertain ? 'CONNECTING' : 'ERROR',
            });
            await dependencies.repository.completeIdempotency(transaction, {
              organizationId: context.organizationId,
              recordId: initial.idempotencyRecordId,
              status: uncertain ? 'COMPLETED' : 'FAILED',
              responseMetadata: {
                instanceId: initial.instance.id,
                status: uncertain ? 'CONNECTING' : 'ERROR',
                ...(uncertain ? { actionType: 'NONE' } : {}),
              },
            });
            await dependencies.writeAudit(transaction, {
              type: 'INSTANCE_CONNECT_FAILED',
              organizationId: context.organizationId,
              ...auditActor(context),
              resourceId: initial.instance.id,
              requestId: context.requestId,
              canonicalErrorCode: errorCode(error),
            });
            return true;
          },
        );
        if (!applied) return staleResult();
        throw new InstanceServiceError('PROVIDER_OPERATION_FAILED', 502);
      }

      const status = connectionStatus(action);
      const completed = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          const locked = await dependencies.repository.findByIdForUpdate(
            transaction,
            context.organizationId,
            initial.instance.id,
          );
          if (!locked) return null;
          const connectionPending = action.type === 'NONE' && action.reason === 'CONNECTION_PENDING';
          const fenced = await dependencies.repository.updatePendingConnectOperation(transaction, {
            organizationId: context.organizationId,
            instanceId: initial.instance.id,
            operationId: initial.operation.id,
            status: connectionPending ? 'PENDING' : 'SUCCEEDED',
            canonicalErrorCode: null,
            updatedAt: now(),
            incrementAttempt: !connectionPending,
          });
          if (!fenced) return null;
          const updated = await dependencies.repository.updateInstanceState(transaction, {
            organizationId: context.organizationId,
            instanceId: initial.instance.id,
            status,
          });
          if (!updated) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
          await dependencies.repository.completeIdempotency(transaction, {
            organizationId: context.organizationId,
            recordId: initial.idempotencyRecordId,
            status: 'COMPLETED',
            responseMetadata: { instanceId: updated.id, status: updated.status, actionType: action.type },
          });
          if (!connectionPending) {
            await dependencies.writeAudit(transaction, {
              type: 'INSTANCE_CONNECTED',
              organizationId: context.organizationId,
              ...auditActor(context),
              resourceId: updated.id,
              requestId: context.requestId,
            });
          }
          return updated;
        },
      );
      if (!completed) return staleResult();
      return {
        instance: asInstance(completed),
        operationId: initial.operation.id,
        replayed: false,
        pending: status !== 'CONNECTED',
        reconciliationRequired: false,
        action,
      };
    },

    async getInstanceStatus(context, instanceId) {
      const instance = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        (transaction) => dependencies.repository.findById(
          transaction,
          context.organizationId,
          instanceId,
        ),
      );
      if (!instance) return denyNotFound(dependencies, context, instanceId);
      let status: ProviderStatus;
      try {
        status = await dependencies.providers.getProvider(instance.provider).getStatus(
          providerContext(context),
          { id: instance.externalReference ?? instance.upstreamInstanceKey },
        );
      } catch (error) {
        await dependencies.runInOrganizationTransaction(context.organizationId, (transaction) => (
          dependencies.writeAudit(transaction, {
            type: 'INSTANCE_STATUS_FAILED',
            organizationId: context.organizationId,
            ...auditActor(context),
            resourceId: instance.id,
            requestId: context.requestId,
            canonicalErrorCode: errorCode(error),
          })
        ));
        throw new InstanceServiceError('PROVIDER_OPERATION_FAILED', 502);
      }
      const updated = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          const observedAt = now();
          const current = await dependencies.repository.findByIdForUpdate(
            transaction,
            context.organizationId,
            instanceId,
          );
          if (!current) return null;
          if (!isSameInstanceSnapshot(current, instance)) return current;
          const pending = await dependencies.repository.findPendingConnectOperationForUpdate(
            transaction,
            context.organizationId,
            instanceId,
          );
          if (pending) {
            const leaseIsFresh = pending.updatedAt.getTime()
              > observedAt.getTime() - connectLeaseMs;
            if (leaseIsFresh && status !== 'CONNECTED') {
              return dependencies.repository.updateInstanceState(transaction, {
                organizationId: context.organizationId,
                instanceId,
                status: 'CONNECTING',
              });
            }
            const operationStatus = status === 'CONNECTING'
              ? 'UNKNOWN'
              : status === 'CONNECTED' || status === 'AWAITING_ACTION'
                ? 'SUCCEEDED'
                : 'FAILED';
            await dependencies.repository.updatePendingConnectOperation(transaction, {
              organizationId: context.organizationId,
              instanceId,
              operationId: pending.id,
              status: operationStatus,
              canonicalErrorCode: operationStatus === 'UNKNOWN'
                ? 'CONNECT_LEASE_EXPIRED'
                : operationStatus === 'FAILED'
                  ? 'CONNECTION_NOT_ACTIVE'
                  : null,
              updatedAt: observedAt,
              incrementAttempt: true,
            });
          }
          const pendingDisconnect = await dependencies.repository.findPendingDisconnectOperationForUpdate(
            transaction,
            context.organizationId,
            instanceId,
          );
          if (pendingDisconnect) {
            const leaseIsFresh = pendingDisconnect.updatedAt.getTime()
              > observedAt.getTime() - disconnectLeaseMs;
            if (leaseIsFresh && status !== 'DISCONNECTED') {
              return dependencies.repository.updateInstanceState(transaction, {
                organizationId: context.organizationId,
                instanceId,
                status: 'DISCONNECTING',
              });
            }
            const operationStatus = status === 'DISCONNECTED' ? 'SUCCEEDED' : 'UNKNOWN';
            await dependencies.repository.updatePendingDisconnectOperation(transaction, {
              organizationId: context.organizationId,
              instanceId,
              operationId: pendingDisconnect.id,
              status: operationStatus,
              canonicalErrorCode: operationStatus === 'UNKNOWN'
                ? 'DISCONNECT_LEASE_EXPIRED'
                : null,
              updatedAt: observedAt,
              incrementAttempt: true,
            });
          }
          return dependencies.repository.updateInstanceState(transaction, {
            organizationId: context.organizationId,
            instanceId,
            status: providerStatusToInstanceStatus(status),
          });
        },
      );
      if (!updated) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
      return asInstance(updated);
    },

    async disconnectInstance(context, command) {
      const route = `/v1/instances/${command.instanceId}/disconnect`;
      const acquiredAt = now();
      const initial = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          const instance = await dependencies.repository.findByIdForUpdate(
            transaction,
            context.organizationId,
            command.instanceId,
          );
          if (!instance) return { kind: 'NOT_FOUND' as const };
          const idempotency = await claim(transaction, {
            organizationId: context.organizationId,
            route,
            key: command.idempotencyKey,
            request: { instanceId: command.instanceId },
          });
          if (idempotency.kind === 'REPLAY') {
            if (idempotency.record.status === 'FAILED') {
              throw new InstanceServiceError('PROVIDER_OPERATION_FAILED', 502);
            }
            return { kind: 'REPLAY' as const, instance, operationId: idempotency.record.operationId };
          }
          if (instance.status === 'DISCONNECTED') {
            await dependencies.repository.completeIdempotency(transaction, {
              organizationId: context.organizationId,
              recordId: idempotency.recordId,
              status: 'COMPLETED',
              responseMetadata: { instanceId: instance.id, status: instance.status },
            });
            return { kind: 'ALREADY_DISCONNECTED' as const, instance };
          }

          if (instance.status === 'DISCONNECTING') {
            const active = await dependencies.repository.findPendingDisconnectOperationForUpdate(
              transaction,
              context.organizationId,
              instance.id,
            );
            if (
              active
              && active.updatedAt.getTime() > acquiredAt.getTime() - disconnectLeaseMs
            ) {
              await dependencies.repository.linkIdempotency(transaction, {
                organizationId: context.organizationId,
                recordId: idempotency.recordId,
                operationId: active.id,
                responseMetadata: { instanceId: instance.id, status: 'DISCONNECTING' },
              });
              await dependencies.repository.completeIdempotency(transaction, {
                organizationId: context.organizationId,
                recordId: idempotency.recordId,
                status: 'COMPLETED',
                responseMetadata: { instanceId: instance.id, status: 'DISCONNECTING' },
              });
              return { kind: 'JOINED' as const, instance, operationId: active.id };
            }
            if (active) {
              await dependencies.repository.updatePendingDisconnectOperation(transaction, {
                organizationId: context.organizationId,
                instanceId: instance.id,
                operationId: active.id,
                status: 'UNKNOWN',
                canonicalErrorCode: 'DISCONNECT_LEASE_EXPIRED',
                updatedAt: acquiredAt,
              });
            } else {
              throw new InstanceServiceError('INSTANCE_STATE_CONFLICT', 409);
            }
          } else if (!['CONNECTED', 'AWAITING_ACTION', 'ERROR'].includes(instance.status)) {
            throw new InstanceServiceError('INSTANCE_STATE_CONFLICT', 409);
          }
          const operation = await dependencies.repository.createOperation(transaction, {
            organizationId: context.organizationId,
            instanceId: instance.id,
            operationType: 'DISCONNECT',
            updatedAt: acquiredAt,
          });
          const disconnecting = await dependencies.repository.updateInstanceState(transaction, {
            organizationId: context.organizationId,
            instanceId: instance.id,
            status: 'DISCONNECTING',
          });
          if (!disconnecting) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
          await dependencies.repository.linkIdempotency(transaction, {
            organizationId: context.organizationId,
            recordId: idempotency.recordId,
            operationId: operation.id,
            responseMetadata: { instanceId: instance.id, status: 'DISCONNECTING' },
          });
          return {
            kind: 'NEW' as const,
            instance: disconnecting,
            operation,
            idempotencyRecordId: idempotency.recordId,
          };
        },
      );
      if (initial.kind === 'NOT_FOUND') {
        return denyNotFound(dependencies, context, command.instanceId);
      }
      if (initial.kind !== 'NEW') {
        return {
          instance: asInstance(initial.instance),
          operationId: initial.kind === 'REPLAY' || initial.kind === 'JOINED'
            ? initial.operationId
            : null,
          replayed: initial.kind === 'REPLAY',
          pending: initial.instance.status === 'DISCONNECTING',
          reconciliationRequired: false,
        };
      }

      const staleResult = async (): Promise<InstanceMutationResult> => {
        const current = await dependencies.runInOrganizationTransaction(
          context.organizationId,
          (transaction) => dependencies.repository.findById(
            transaction,
            context.organizationId,
            initial.instance.id,
          ),
        );
        if (!current) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
        return {
          instance: asInstance(current),
          operationId: initial.operation.id,
          replayed: false,
          pending: current.status === 'DISCONNECTING',
          reconciliationRequired: false,
        };
      };

      try {
        await dependencies.providers.getProvider(initial.instance.provider).disconnect(
          providerContext(context),
          { id: initial.instance.externalReference ?? initial.instance.upstreamInstanceKey },
        );
      } catch (error) {
        const uncertain = isUncertain(error);
        const applied = await dependencies.runInOrganizationTransaction(
          context.organizationId,
          async (transaction) => {
            const locked = await dependencies.repository.findByIdForUpdate(
              transaction,
              context.organizationId,
              initial.instance.id,
            );
            if (!locked) return false;
            const fenced = await dependencies.repository.updatePendingDisconnectOperation(transaction, {
              organizationId: context.organizationId,
              instanceId: initial.instance.id,
              operationId: initial.operation.id,
              status: uncertain ? 'PENDING' : 'FAILED',
              canonicalErrorCode: errorCode(error),
              updatedAt: now(),
              incrementAttempt: true,
            });
            if (!fenced) return false;
            await dependencies.repository.updateInstanceState(transaction, {
              organizationId: context.organizationId,
              instanceId: initial.instance.id,
              status: uncertain ? 'DISCONNECTING' : 'ERROR',
            });
            await dependencies.repository.completeIdempotency(transaction, {
              organizationId: context.organizationId,
              recordId: initial.idempotencyRecordId,
              status: uncertain ? 'COMPLETED' : 'FAILED',
              responseMetadata: {
                instanceId: initial.instance.id,
                status: uncertain ? 'DISCONNECTING' : 'ERROR',
              },
            });
            await dependencies.writeAudit(transaction, {
              type: 'INSTANCE_DISCONNECT_FAILED',
              organizationId: context.organizationId,
              ...auditActor(context),
              resourceId: initial.instance.id,
              requestId: context.requestId,
              canonicalErrorCode: errorCode(error),
            });
            return true;
          },
        );
        if (!applied) return staleResult();
        throw new InstanceServiceError('PROVIDER_OPERATION_FAILED', 502);
      }
      const completed = await dependencies.runInOrganizationTransaction(
        context.organizationId,
        async (transaction) => {
          const locked = await dependencies.repository.findByIdForUpdate(
            transaction,
            context.organizationId,
            initial.instance.id,
          );
          if (!locked) return null;
          const fenced = await dependencies.repository.updatePendingDisconnectOperation(transaction, {
            organizationId: context.organizationId,
            instanceId: initial.instance.id,
            operationId: initial.operation.id,
            status: 'SUCCEEDED',
            canonicalErrorCode: null,
            updatedAt: now(),
            incrementAttempt: true,
          });
          if (!fenced) return null;
          const updated = await dependencies.repository.updateInstanceState(transaction, {
            organizationId: context.organizationId,
            instanceId: initial.instance.id,
            status: 'DISCONNECTED',
          });
          if (!updated) throw new InstanceServiceError('INSTANCE_NOT_FOUND', 404);
          await dependencies.repository.completeIdempotency(transaction, {
            organizationId: context.organizationId,
            recordId: initial.idempotencyRecordId,
            status: 'COMPLETED',
            responseMetadata: { instanceId: updated.id, status: updated.status },
          });
          await dependencies.writeAudit(transaction, {
            type: 'INSTANCE_DISCONNECTED',
            organizationId: context.organizationId,
            ...auditActor(context),
            resourceId: updated.id,
            requestId: context.requestId,
          });
          return updated;
        },
      );
      if (!completed) return staleResult();
      return {
        instance: asInstance(completed),
        operationId: initial.operation.id,
        replayed: false,
        pending: false,
        reconciliationRequired: false,
      };
    },
  };
}
