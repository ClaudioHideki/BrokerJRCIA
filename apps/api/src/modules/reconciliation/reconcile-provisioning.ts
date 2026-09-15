import type {
  ProviderContext,
  WhatsAppProviderAdmin,
} from '@jrc/providers';
import type { Instance, ProviderKind } from '@jrc/contracts';

import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { TenantAuditEvent } from '../audit/audit.js';
import type { InstanceRepository, InstanceRow } from '../instances/service.js';

export interface AdminProviderRegistry {
  getAdminProvider(kind: ProviderKind): WhatsAppProviderAdmin;
}

export interface ReconcileProvisioningCommand {
  organizationId: string;
  operationId: string;
  requestId: string;
  deadline: Date;
  signal: AbortSignal;
}

export interface ProvisioningReconcilerDependencies {
  repository: InstanceRepository;
  providers: AdminProviderRegistry;
  runInOrganizationTransaction<T>(
    organizationId: string,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T>;
  writeAudit(transaction: TenantTransaction, event: TenantAuditEvent): Promise<void>;
  now?: () => Date;
  leaseMs?: number;
}

export class ReconciliationError extends Error {
  constructor(readonly code: 'RECONCILIATION_NOT_FOUND' | 'RECONCILIATION_FAILED') {
    super(code);
    this.name = 'ReconciliationError';
  }
}

function publicInstance(row: InstanceRow): Instance {
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

function canonicalError(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ? code
    : 'RECONCILIATION_FAILED';
}

export function createProvisioningReconciler(dependencies: ProvisioningReconcilerDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const leaseMs = dependencies.leaseMs ?? 60_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error('Reconciliation lease must be a positive integer');
  }
  return async function reconcileProvisioning(
    command: ReconcileProvisioningCommand,
  ): Promise<Instance> {
    const pending = await dependencies.runInOrganizationTransaction(
      command.organizationId,
      (transaction) => dependencies.repository.claimProvisioningOperation(
        transaction,
        command.organizationId,
        command.operationId,
        now(),
        leaseMs,
      ),
    );
    if (!pending) throw new ReconciliationError('RECONCILIATION_NOT_FOUND');

    const context: ProviderContext = {
      organizationId: command.organizationId,
      requestId: command.requestId,
      deadline: command.deadline,
      signal: command.signal,
    };
    const admin = dependencies.providers.getAdminProvider(pending.instance.provider);

    try {
      const lookup = await admin.lookupInstance(context, {
        id: pending.instance.upstreamInstanceKey,
      });
      const resolved = lookup.exists
        ? { reference: lookup.reference, status: lookup.status }
        : (await admin.reconcileProvisioning(context, {
            upstreamInstanceKey: pending.instance.upstreamInstanceKey,
            providerAccountId: pending.instance.providerAccountId,
          })).instance;
      if (!resolved) throw new ReconciliationError('RECONCILIATION_FAILED');

      const completed = await dependencies.runInOrganizationTransaction(
        command.organizationId,
        async (transaction) => {
          const updated = await dependencies.repository.updateInstanceState(transaction, {
            organizationId: command.organizationId,
            instanceId: pending.instance.id,
            status: 'CREATED',
            externalReference: resolved.reference.id,
          });
          if (!updated) throw new ReconciliationError('RECONCILIATION_NOT_FOUND');
          await dependencies.repository.completeOperation(transaction, {
            organizationId: command.organizationId,
            operationId: pending.operation.id,
            status: 'SUCCEEDED',
            canonicalErrorCode: null,
            reconciliationRequired: false,
            incrementAttempt: false,
          });
          await dependencies.writeAudit(transaction, {
            type: 'RECONCILIATION_COMPLETED',
            organizationId: command.organizationId,
            actorId: null,
            actorKind: 'INTERNAL',
            resourceId: pending.operation.id,
            requestId: command.requestId,
          });
          return updated;
        },
      );
      return publicInstance(completed);
    } catch (error) {
      await dependencies.runInOrganizationTransaction(command.organizationId, async (transaction) => {
        await dependencies.repository.completeOperation(transaction, {
          organizationId: command.organizationId,
          operationId: pending.operation.id,
          status: 'UNKNOWN',
          canonicalErrorCode: canonicalError(error),
          reconciliationRequired: true,
          incrementAttempt: false,
        });
      });
      if (error instanceof ReconciliationError) throw error;
      throw new ReconciliationError('RECONCILIATION_FAILED');
    }
  };
}
