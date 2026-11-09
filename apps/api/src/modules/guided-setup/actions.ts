import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SetupSelection } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { evaluateSetupReadiness, type SetupSnapshot } from './readiness.js';
import { evaluateSetupProof, type SetupEvidence } from './proof.js';
import type { SetupRecord, SetupStore } from './repository.js';
import { publicSetup, setupFail, type GuidedSetupOptions, type SetupPrincipal } from './service.js';
import { writeSetupAudit } from './audit.js';

const revisionInput = z.strictObject({ revision: z.int().positive() });
export const SetupTestInputSchema = revisionInput.extend({ keyword: z.string().trim().min(8).max(100)
  .refine(value => !/[\r\n\0]/u.test(value)), expectedOwnerRevision: z.int().nonnegative(), replaceExisting: z.boolean() });
export const SetupActivateInputSchema = revisionInput.extend({ expectedOwnerRevision: z.int().nonnegative() });
export const SetupProofInputSchema = revisionInput.extend({ executionId: z.uuid().optional() });
export interface SetupActionPorts {
  inspect(principal: SetupPrincipal, selection: SetupSelection): Promise<SetupSnapshot>;
  prepareTest(principal: SetupPrincipal, record: SetupRecord, keyword: string, key: string): Promise<{ automationId: string; version: number }>;
  bind(principal: SetupPrincipal, input: { channelId: string; automationId: string; version: number;
    expectedOwnerRevision: number; snapshot: SetupSnapshot; setupId: string; leaseToken: string }): Promise<{ id: string; revision: number; ownerRevision: number }>;
  readOwner(principal: SetupPrincipal, selection: SetupSelection): Promise<{ channelId: string; owner: SetupSnapshot['owner'] }>;
  assertOwner(tx: TenantTransaction, principal: SetupPrincipal, expected: SetupSnapshot, validateConfiguration?: boolean): Promise<void>;
  deactivate(principal: SetupPrincipal, input: { channelId: string; expectedOwnerRevision: number; setupId: string; leaseToken: string }): Promise<{ ownerRevision: number }>;
  localizePackageDrafts(tx: TenantTransaction, org: string, packageId: string, snapshot: SetupSnapshot): Promise<void>;
  readProof(principal: SetupPrincipal, record: SetupRecord, executionId?: string): Promise<{ executionId: string; evidence: SetupEvidence }>;
}
interface ActionOptions {
  options: GuidedSetupOptions; store: SetupStore;
  authorize(principal: SetupPrincipal): Promise<void>;
  read(tx: TenantTransaction, principal: SetupPrincipal, id: string, lock?: boolean): Promise<SetupRecord>;
}
export function createGuidedSetupActions(context: ActionOptions) {
  const { options, store, authorize, read } = context;
  const tx = <T>(principal: SetupPrincipal, work: (transaction: TenantTransaction) => Promise<T>) => options.transact(principal.organizationId, work);
  const ports = () => {
    const port = options.ports;
    if (!port.inspect || !port.prepareTest || !port.bind || !port.readProof) return setupFail('ACTIONS_UNAVAILABLE', 503);
    return port as SetupActionPorts;
  };
  const changed = (row: SetupRecord, revision: number) => { if (row.revision !== revision) return setupFail('CHANGED'); };
  const save = async (t: TenantTransaction, row: SetupRecord) => {
    row.revision++; row.updatedAt = new Date().toISOString(); await store.put(t, row); return publicSetup(row);
  };
  const inspect = async (principal: SetupPrincipal, row: SetupRecord) => {
    await authorize(principal);
    const snapshot = await ports().inspect(principal, row.selection), readiness = evaluateSetupReadiness(snapshot);
    if (snapshot.organizationId !== principal.organizationId) return setupFail('SCOPE_MISMATCH');
    return { snapshot, readiness };
  };
  async function finish(principal: SetupPrincipal, id: string, lease: string, snapshot: SetupSnapshot) {
    await authorize(principal);
    return tx(principal, async t => {
      if (!options.ports.assertOwner) return setupFail('ACTIONS_UNAVAILABLE', 503);
      await options.ports.assertOwner(t, principal, snapshot);
      const row = await read(t, principal, id, true), op = row.operation;
      if (!op || op.leaseToken !== lease || (op.leaseExpiresAt ?? 0) <= Date.now()) return setupFail('LEASE_LOST');
      if (op.kind === 'TEST') {
        if (!row.testContext) return setupFail('TEST_REQUIRED');
        row.testContext.ownerRevision = snapshot.owner.revision; row.state = 'TESTING';
      } else { row.state = 'ACTIVE'; row.activeOwnerRevision = snapshot.owner.revision; }
      await writeSetupAudit(t, principal, id, op.kind === 'ACTIVATE' ? 'ACTIVATED' : 'TESTED', {
        requestedBy: op.actorId, channelId: snapshot.channelId, automationId: snapshot.owner.automationId, version: snapshot.owner.version,
      });
      row.readiness = evaluateSetupReadiness(snapshot);
      row.lastAction = { key: op.key, actorId: op.actorId, kind: op.kind, requestHash: op.requestHash }; row.operation = null;
      return save(t, row);
    });
  }
  async function runReserved(principal: SetupPrincipal, id: string, lease: string) {
    const row = await tx(principal, t => read(t, principal, id));
    const op = row.operation;
    if (!op || op.leaseToken !== lease) return setupFail('LEASE_LOST');
    try {
      if (op.kind === 'DEACTIVATE') {
        const port = options.ports;
        if (!port.readOwner || !port.deactivate) return setupFail('ACTIONS_UNAVAILABLE', 503);
        await authorize(principal);
        const current = await port.readOwner(principal, row.selection);
        const none = !current.owner.automationId && current.owner.executor === 'NONE';
        const previous = row.previousBinding;
        const untouched = op.input.abandonedKind === 'TEST' && previous && current.owner.revision === previous.revision &&
          current.owner.automationId === previous.automationId && current.owner.version === previous.version && current.owner.executor === previous.executor;
        const testRevision = row.testContext?.ownerRevision ?? (row.testContext ? row.testContext.expectedOwnerRevision + 1 : null);
        const ownTest = current.owner.revision === testRevision && current.owner.automationId === row.testContext?.automationId && current.owner.version === row.testContext?.version && Boolean(current.owner.automationId);
        const ownActive = op.input.allowSelected === true && current.owner.revision === op.input.ownedRevision && current.owner.automationId === row.selection.automationId && current.owner.version === row.selection.version;
        if (!none && !untouched && !ownTest && !ownActive) return setupFail('OWNER_CHANGED');
        if (!none && !untouched) {
          if (current.owner.revision !== Number(op.input.expectedOwnerRevision)) return setupFail('OWNER_CHANGED');
          await port.deactivate(principal, { channelId: current.channelId, expectedOwnerRevision: current.owner.revision, setupId: id, leaseToken: lease });
        }
        await authorize(principal);
        return tx(principal, async t => {
          const locked = await read(t, principal, id, true);
          if (locked.operation?.leaseToken !== lease || (locked.operation.leaseExpiresAt ?? 0) <= Date.now()) return setupFail('LEASE_LOST');
          await writeSetupAudit(t, principal, id, 'DEACTIVATED', { requestedBy: op.actorId, channelId: current.channelId });
          locked.state = 'EDITING'; locked.proof = null; locked.readiness = null; locked.testContext = null; locked.previousBinding = null; locked.activeOwnerRevision = null;
          locked.lastAction = { key: op.key, actorId: op.actorId, kind: op.kind, requestHash: op.requestHash }; locked.operation = null;
          return save(t, locked);
        });
      }
      const { snapshot, readiness } = await inspect(principal, row);
      if (!readiness.readyForTest || !readiness.fingerprint) return setupFail('READINESS_REQUIRED');
      if (!row.testContext || row.testContext.fingerprint !== readiness.fingerprint) return setupFail('CONFIGURATION_CHANGED');
      let automationId = row.selection.automationId!, version = row.selection.version!;
      if (op.kind === 'TEST') {
        if (!row.testContext.automationId || !row.testContext.version) {
          const prepared = await ports().prepareTest(principal, row, row.testContext.keyword, `${id}:${op.key}`);
          await tx(principal, async t => {
            const locked = await read(t, principal, id, true);
            if (locked.operation?.leaseToken !== lease || !locked.testContext) return setupFail('LEASE_LOST');
            locked.testContext.automationId = prepared.automationId; locked.testContext.version = prepared.version;
            await store.put(t, locked);
          });
          row.testContext.automationId = prepared.automationId; row.testContext.version = prepared.version;
        }
        automationId = row.testContext.automationId; version = row.testContext.version;
      }
      // Reconciliation observes the exact desired owner before considering a retry.
      if (snapshot.owner.automationId === automationId && snapshot.owner.version === version &&
        snapshot.owner.revision > Number(op.input.expectedOwnerRevision)) return finish(principal, id, lease, snapshot);
      if (snapshot.owner.revision !== Number(op.input.expectedOwnerRevision)) return setupFail('OWNER_CHANGED');
      await authorize(principal);
      await ports().bind(principal, { channelId: snapshot.channelId!, automationId, version,
        expectedOwnerRevision: Number(op.input.expectedOwnerRevision), snapshot, setupId: id, leaseToken: lease });
      const after = await ports().inspect(principal, row.selection), checked = evaluateSetupReadiness(after);
      if (checked.fingerprint !== readiness.fingerprint || after.owner.automationId !== automationId || after.owner.version !== version)
        return setupFail('CONFIGURATION_CHANGED');
      return finish(principal, id, lease, after);
    } catch (error) {
      await tx(principal, async t => {
        const locked = await read(t, principal, id, true);
        if (locked.operation?.leaseToken === lease) {
          locked.state = 'UNKNOWN'; locked.operation.leaseToken = null; locked.operation.leaseExpiresAt = null; await save(t, locked);
        }
      });
      throw error;
    }
  }
  async function reserve(principal: SetupPrincipal, id: string, input: z.infer<typeof SetupTestInputSchema> | z.infer<typeof SetupActivateInputSchema>, key: string, kind: 'TEST' | 'ACTIVATE') {
    await authorize(principal);
    const initial = await tx(principal, t => read(t, principal, id));
    const hash = hashIdempotencyRequest(input);
    if (initial.lastAction?.key === key) {
      if (initial.lastAction.kind !== kind || initial.lastAction.requestHash !== hash) return setupFail('IDEMPOTENCY_CONFLICT');
      return { replay: publicSetup(initial), lease: null };
    }
    changed(initial, input.revision);
    if (initial.operation) return setupFail('RECONCILIATION_REQUIRED');
    if (kind === 'TEST' && !['EDITING', 'REVIEW'].includes(initial.state)) return setupFail('TEST_STATE_INVALID');
    if (kind === 'ACTIVATE' && (initial.state !== 'TESTING' || !initial.proof?.passed)) return setupFail('PHYSICAL_PROOF_REQUIRED');
    const { snapshot, readiness } = await inspect(principal, initial);
    if (!readiness.readyForTest || !readiness.fingerprint) return setupFail('READINESS_REQUIRED');
    if (snapshot.owner.revision !== input.expectedOwnerRevision) return setupFail('OWNER_CHANGED');
    if (kind === 'TEST' && (snapshot.owner.automationId || snapshot.owner.executor === 'EXTERNAL') && !('replaceExisting' in input && input.replaceExisting))
      return setupFail('REPLACEMENT_CONFIRMATION_REQUIRED');
    if (kind === 'ACTIVATE') {
      if (initial.proof!.fingerprint !== readiness.fingerprint || initial.proof!.provider !== snapshot.provider ||
        initial.testContext?.fingerprint !== readiness.fingerprint) return setupFail('CONFIGURATION_CHANGED');
      if (snapshot.owner.automationId !== initial.testContext.automationId || snapshot.owner.version !== initial.testContext.version ||
        snapshot.owner.revision !== initial.testContext.ownerRevision) return setupFail('OWNER_CHANGED');
    }
    const lease = randomUUID();
    await authorize(principal);
    await tx(principal, async t => {
      const row = await read(t, principal, id, true); changed(row, input.revision);
      if (row.operation) return setupFail('RECONCILIATION_REQUIRED');
      row.operation = { key, actorId: principal.actorId, kind, requestHash: hash, input, leaseToken: lease, leaseExpiresAt: Date.now() + 600000 };
      row.readiness = readiness; row.state = 'UNKNOWN';
      if (kind === 'TEST') {
        row.previousBinding = { ...snapshot.owner }; row.proof = null;
        row.testContext = { keyword: (input as z.infer<typeof SetupTestInputSchema>).keyword, startedAt: new Date().toISOString(),
          fingerprint: readiness.fingerprint!, automationId: null, version: null, expectedOwnerRevision: input.expectedOwnerRevision, ownerRevision: null };
      }
      await save(t, row);
    });
    return { replay: null, lease };
  }
  return {
    async mapPackage(principal: SetupPrincipal, id: string, value: unknown) {
      const input = revisionInput.parse(value); await authorize(principal);
      const initial = await tx(principal, t => read(t, principal, id)); changed(initial, input.revision);
      if (!['EDITING', 'REVIEW'].includes(initial.state) || initial.operation || !initial.selection.packageId) return setupFail('PACKAGE_REQUIRED');
      const { snapshot } = await inspect(principal, initial);
      if (!options.ports.localizePackageDrafts) return setupFail('ACTIONS_UNAVAILABLE', 503);
      await authorize(principal);
      return tx(principal, async t => {
        const row = await read(t, principal, id, true); changed(row, input.revision);
        if (row.operation || !['EDITING', 'REVIEW'].includes(row.state)) return setupFail('RECONCILIATION_REQUIRED');
        await options.ports.localizePackageDrafts!(t, principal.organizationId, row.selection.packageId!, snapshot);
        row.proof = null; row.readiness = null; row.state = 'EDITING';
        await writeSetupAudit(t, principal, id, 'UPDATED', { packageId: row.selection.packageId! });
        return save(t, row);
      });
    },
    async check(principal: SetupPrincipal, id: string, value: unknown) {
      const input = revisionInput.parse(value); await authorize(principal);
      const initial = await tx(principal, t => read(t, principal, id)); changed(initial, input.revision);
      const { snapshot, readiness } = await inspect(principal, initial);
      return tx(principal, async t => {
        if (['ACTIVE', 'TESTING'].includes(initial.state)) {
          if (!options.ports.assertOwner) return setupFail('ACTIONS_UNAVAILABLE', 503);
          await options.ports.assertOwner(t, principal, snapshot, false);
        }
        const row = await read(t, principal, id, true); changed(row, input.revision);
        if (row.state === 'CANCELLED' || row.operation) return setupFail('RECONCILIATION_REQUIRED');
        row.readiness = readiness;
        const expectedOwner = row.state === 'ACTIVE' ? { automationId: row.selection.automationId, version: row.selection.version, revision: row.activeOwnerRevision }
          : row.state === 'TESTING' ? { automationId: row.testContext?.automationId, version: row.testContext?.version, revision: row.testContext?.ownerRevision } : null;
        if (expectedOwner && (snapshot.owner.automationId !== expectedOwner.automationId || snapshot.owner.version !== expectedOwner.version || snapshot.owner.revision !== expectedOwner.revision)) {
          row.state = 'EDITING'; row.proof = null; row.testContext = null; row.previousBinding = null; row.activeOwnerRevision = null;
          row.readiness = { ...readiness, readyForTest: false, checks: [...readiness.checks, { code: 'EXECUTOR_CHANGED', state: 'ACTION_REQUIRED',
            title: 'O vínculo da caixa mudou. Confira novamente e repita a homologação.' }] };
          return save(t, row);
        }
        if (row.proof?.fingerprint !== readiness.fingerprint) row.proof = null;
        if (['EDITING', 'REVIEW'].includes(row.state)) row.state = readiness.readyForTest ? 'REVIEW' : 'EDITING';
        return save(t, row);
      });
    },
    async beginTest(principal: SetupPrincipal, id: string, value: unknown, key: string) {
      const reserved = await reserve(principal, id, SetupTestInputSchema.parse(value), key, 'TEST');
      return reserved.replay ?? runReserved(principal, id, reserved.lease!);
    },
    async collectProof(principal: SetupPrincipal, id: string, value: unknown) {
      const input = SetupProofInputSchema.parse(value); await authorize(principal);
      const initial = await tx(principal, t => read(t, principal, id)); changed(initial, input.revision);
      if (initial.state !== 'TESTING' || !initial.testContext || initial.operation) return setupFail('TEST_REQUIRED');
      const { snapshot, readiness } = await inspect(principal, initial);
      if (readiness.fingerprint !== initial.testContext.fingerprint || snapshot.owner.automationId !== initial.testContext.automationId ||
        snapshot.owner.version !== initial.testContext.version || snapshot.owner.revision !== initial.testContext.ownerRevision) return setupFail('CONFIGURATION_CHANGED');
      const native = await ports().readProof(principal, initial, input.executionId);
      const proof = evaluateSetupProof({ executionId: native.executionId, fingerprint: readiness.fingerprint!, provider: snapshot.provider }, native.evidence);
      await authorize(principal);
      return tx(principal, async t => {
        const row = await read(t, principal, id, true); changed(row, input.revision); row.proof = proof; row.readiness = readiness; return save(t, row);
      });
    },
    async activate(principal: SetupPrincipal, id: string, value: unknown, key: string) {
      const reserved = await reserve(principal, id, SetupActivateInputSchema.parse(value), key, 'ACTIVATE');
      return reserved.replay ?? runReserved(principal, id, reserved.lease!);
    },
    async deactivate(principal: SetupPrincipal, id: string, value: unknown, key: string) {
      const input = SetupActivateInputSchema.parse(value); await authorize(principal);
      const hash = hashIdempotencyRequest(input), lease = randomUUID();
      const replay = await tx(principal, async t => {
        const row = await read(t, principal, id, true);
        if (row.lastAction?.key === key) {
          if (row.lastAction.kind !== 'DEACTIVATE' || row.lastAction.requestHash !== hash) return setupFail('IDEMPOTENCY_CONFLICT');
          return publicSetup(row);
        }
        changed(row, input.revision);
        if (!['TESTING', 'ACTIVE', 'UNKNOWN'].includes(row.state)) return setupFail('TEST_REQUIRED');
        if (row.operation?.leaseToken && (row.operation.leaseExpiresAt ?? 0) > Date.now()) return setupFail('OPERATION_IN_PROGRESS');
        const abandonedKind = row.operation?.kind ?? null;
        const allowSelected = row.state === 'ACTIVE' || abandonedKind === 'ACTIVATE';
        const ownedRevision = row.state === 'ACTIVE' ? row.activeOwnerRevision : abandonedKind === 'ACTIVATE' ? Number(row.operation?.input.expectedOwnerRevision) + 1 : null;
        row.operation = { key, actorId: principal.actorId, kind: 'DEACTIVATE', requestHash: hash,
          input: { ...input, abandonedKind, allowSelected, ownedRevision }, leaseToken: lease, leaseExpiresAt: Date.now() + 600000 };
        row.state = 'UNKNOWN'; await save(t, row); return null;
      });
      return replay ?? runReserved(principal, id, lease);
    },
    async reconcile(principal: SetupPrincipal, id: string, value: unknown) {
      const input = revisionInput.parse(value); await authorize(principal); const lease = randomUUID();
      await tx(principal, async t => {
        const row = await read(t, principal, id, true); changed(row, input.revision);
        if (!row.operation || row.state !== 'UNKNOWN') return setupFail('NO_PENDING_ACTION');
        if (row.operation.leaseToken && (row.operation.leaseExpiresAt ?? 0) > Date.now()) return setupFail('OPERATION_IN_PROGRESS');
        row.operation.leaseToken = lease; row.operation.leaseExpiresAt = Date.now() + 600000; await save(t, row);
      });
      return runReserved(principal, id, lease);
    },
  };
}
