import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GuidedSetupRevisionSchema, GuidedSetupStartSchema, GuidedSetupUpdateSchema, type SetupSelection } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import type { Role } from '../../http/plugins/authorization.js';
import { requireAutomationDraftAccess } from '../automations/service.js';
import { claimIdempotency, completeIdempotencyRecord, hashIdempotencyRequest } from '../instances/idempotency.js';
import { createSetupStore, type SetupRecord, type SetupStore } from './repository.js';
import { createGuidedSetupActions, type SetupActionPorts } from './actions.js';

export interface SetupPrincipal { organizationId: string; actorId: string }
export class GuidedSetupError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}
export interface GuidedSetupOptions {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  store?: SetupStore; resolveCurrentRole(actorId: string, org: string): Promise<Role | null>;
  isEnabled(org: string): boolean;
  ports: { validateSelection(principal: SetupPrincipal, selection: SetupSelection): Promise<void> } & Partial<SetupActionPorts>;
}
export const setupFail = (code: string, status = 409): never => { throw new GuidedSetupError(`GUIDED_SETUP_${code}`, status); };
export function publicSetup(record: SetupRecord) {
  const { operation, testContext, previousBinding: _previous, lastAction: _last, activeOwnerRevision: _activeOwner, ...value } = record;
  return { ...value, pendingAction: operation?.kind ?? null,
    test: testContext ? { keyword: testContext.keyword, startedAt: testContext.startedAt,
      automationId: testContext.automationId, version: testContext.version } : null };
}
export function createGuidedSetupService(options: GuidedSetupOptions) {
  const store = options.store ?? createSetupStore();
  const authorize = async (principal: SetupPrincipal, requireEnabled = true) => {
    const role = await options.resolveCurrentRole(principal.actorId, principal.organizationId);
    if (!role || !['OWNER', 'ADMIN'].includes(role)) return setupFail('FORBIDDEN', 403);
    if (requireEnabled && !options.isEnabled(principal.organizationId)) return setupFail('DISABLED', 403);
  };
  const read = async (tx: TenantTransaction, principal: SetupPrincipal, id: string, lock = false) => {
    await requireAutomationDraftAccess(tx, principal.organizationId);
    const record = await store.get(tx, principal.organizationId, id, lock);
    if (!record || record.organizationId !== principal.organizationId) return setupFail('NOT_FOUND', 404);
    return record;
  };
  const claim = (tx: TenantTransaction, principal: SetupPrincipal, route: string, key: string, input: unknown) =>
    claimIdempotency(tx, { organizationId: principal.organizationId, route, key,
      requestHash: hashIdempotencyRequest(input), expiresAt: new Date(Date.now() + 7 * 86400000) });
  const complete = (tx: TenantTransaction, principal: SetupPrincipal, recordId: string, setupId: string) =>
    completeIdempotencyRecord(tx, { organizationId: principal.organizationId, recordId, status: 'COMPLETED', responseMetadata: { setupId } });
  const replay = async (tx: TenantTransaction, principal: SetupPrincipal, metadata: Record<string, unknown>, status: string) => {
    const id = z.uuid().safeParse(metadata.setupId);
    if (status !== 'COMPLETED' || !id.success) return setupFail('REPLAY_UNAVAILABLE', 503);
    return publicSetup(await read(tx, principal, id.data));
  };
  const get = async (principal: SetupPrincipal, id: string) => {
    await authorize(principal);
    return options.transact(principal.organizationId, async tx => publicSetup(await read(tx, principal, id)));
  };
  return {
    ...createGuidedSetupActions({ options, store, authorize, read }),
    async availability(principal: SetupPrincipal) { await authorize(principal, false); return { enabled: options.isEnabled(principal.organizationId) }; },
    async list(principal: SetupPrincipal) {
      await authorize(principal);
      return options.transact(principal.organizationId, async tx => {
        await requireAutomationDraftAccess(tx, principal.organizationId);
        return { data: (await store.list(tx, principal.organizationId)).map(publicSetup) };
      });
    },
    get,
    async start(principal: SetupPrincipal, value: unknown, key: string) {
      await authorize(principal); const input = GuidedSetupStartSchema.parse(value);
      return options.transact(principal.organizationId, async tx => {
        await requireAutomationDraftAccess(tx, principal.organizationId);
        const intent = await claim(tx, principal, 'POST /v1/guided-setups', key, input);
        if (intent.kind === 'REPLAY') return replay(tx, principal, intent.record.responseMetadata, intent.record.status);
        const now = new Date().toISOString(), record: SetupRecord = {
          id: randomUUID(), organizationId: principal.organizationId, actorId: principal.actorId, name: input.name,
          revision: 1, state: 'EDITING', selection: { transport: input.transport }, readiness: null, proof: null,
          operation: null, testContext: null, previousBinding: null, createdAt: now, updatedAt: now,
        };
        await store.insert(tx, record); await complete(tx, principal, intent.recordId, record.id); return publicSetup(record);
      });
    },
    async update(principal: SetupPrincipal, id: string, value: unknown, key: string) {
      await authorize(principal); const input = GuidedSetupUpdateSchema.parse(value);
      await options.ports.validateSelection(principal, input.selection);
      await authorize(principal);
      return options.transact(principal.organizationId, async tx => {
        const intent = await claim(tx, principal, `PUT /v1/guided-setups/${id}`, key, input);
        if (intent.kind === 'REPLAY') return replay(tx, principal, intent.record.responseMetadata, intent.record.status);
        const row = await read(tx, principal, id, true);
        if (row.revision !== input.revision) return setupFail('CHANGED');
        if (row.state === 'CANCELLED') return setupFail('CANCELLED');
        if (row.state === 'ACTIVE' || row.state === 'TESTING' || row.state === 'UNKNOWN' || row.operation) return setupFail('RECONCILIATION_REQUIRED');
        row.selection = input.selection; row.readiness = null; row.proof = null; row.testContext = null;
        row.state = 'EDITING'; row.revision++; row.updatedAt = new Date().toISOString();
        await store.put(tx, row); await complete(tx, principal, intent.recordId, row.id); return publicSetup(row);
      });
    },
    async cancel(principal: SetupPrincipal, id: string, value: unknown, key: string) {
      await authorize(principal); const input = GuidedSetupRevisionSchema.parse(value);
      return options.transact(principal.organizationId, async tx => {
        const intent = await claim(tx, principal, `POST /v1/guided-setups/${id}/cancel`, key, input);
        if (intent.kind === 'REPLAY') return replay(tx, principal, intent.record.responseMetadata, intent.record.status);
        const row = await read(tx, principal, id, true);
        if (row.revision !== input.revision) return setupFail('CHANGED');
        if (['ACTIVE', 'TESTING', 'UNKNOWN'].includes(row.state) || row.operation) return setupFail('DEACTIVATION_REQUIRED');
        row.state = 'CANCELLED'; row.revision++; row.updatedAt = new Date().toISOString();
        await store.put(tx, row); await complete(tx, principal, intent.recordId, row.id); return publicSetup(row);
      });
    },
  };
}
export type GuidedSetupService = ReturnType<typeof createGuidedSetupService>;
