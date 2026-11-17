import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createHistorySyncWorker } from '../../src/modules/history-sync/worker.js';
import { historyCaptureScopeKey, historySyncRecordsDigest, type HistorySyncScope } from '../../src/modules/history-sync/contract.js';
import { hashIdempotencyRequest } from '../../src/modules/instances/idempotency.js';

const scope: HistorySyncScope = { organizationId: randomUUID(), channelId: randomUUID(), instanceId: randomUUID(), engineId: 'synthetic',
  engineGeneration: 1, sessionGeneration: randomUUID(), bindingFingerprint: 'a'.repeat(64), identityScopeId: randomUUID(),
  historyAccountIdentity: randomUUID(), ownerFingerprint: 'b'.repeat(64) };
function harness(enabled = true) {
  const run = randomUUID(), now = new Date();
  const chunk = { schemaVersion: 2 as const, provenance: 'SOCKET' as const, scope, chunkId: randomUUID(), ordinal: 0,
    capturedAt: now.toISOString(), isLast: false, progress: 100, records: [], checksum: historySyncRecordsDigest([]) };
  const pending = { scopeKey: historyCaptureScopeKey(scope), runId: run, captureId: randomUUID(), payloadHash: hashIdempotencyRequest(chunk), chunk };
  const store = { get: vi.fn(async () => ({ id: run, organizationId: scope.organizationId, channelId: scope.channelId,
    instanceId: scope.instanceId, state: 'RUNNING', capture: 'CAPTURING', historyAccountIdentity: scope.historyAccountIdentity,
    revision: 1, lastError: null, persistence: 'PENDING', projection: 'PENDING' })),
    acceptChunk: vi.fn(async () => ({ kind: 'VALIDATED' as const, chunkId: chunk.chunkId, checksum: chunk.checksum })),
    persistNext: vi.fn(async () => ({ kind: 'IDLE' as const })) };
  const source = { pending: vi.fn(async () => [pending]), acknowledge: vi.fn(async () => true) };
  const projector = { runOnce: vi.fn(async () => ({ kind: 'IDLE' as const })) };
  const assertAdmission = vi.fn(async () => {});
  return { run, now, chunk, pending, store, source, projector, assertAdmission,
    worker: createHistorySyncWorker({ enabled, store, source, projector, assertAdmission }) };
}
it('services one durable source media obligation without freezing persisted text when media fails',async()=>{
  const h=harness(),media={runOnce:vi.fn().mockRejectedValue(Error('synthetic source outage'))};
  const worker=createHistorySyncWorker({...h,enabled:true,media});
  expect(await worker.runOnce(scope,h.run,h.now)).toMatchObject({media:'RETRY',materialization:'IDLE',projection:'IDLE'});
  expect(media.runOnce).toHaveBeenCalledWith(scope,h.run,h.now);
  expect(h.projector.runOnce).toHaveBeenCalledOnce();
});
it('does nothing while the gate is disabled, including no source or membership query', async () => {
  const h = harness(false);
  expect(await h.worker.runOnce(scope, h.run, h.now)).toEqual({ kind: 'DISABLED' });
  expect(h.assertAdmission).not.toHaveBeenCalled(); expect(h.store.get).not.toHaveBeenCalled();
  expect(h.source.pending).not.toHaveBeenCalled(); expect(h.projector.runOnce).not.toHaveBeenCalled();
});
it('acknowledges one immutable source page only after the durable Broker receipt and never closes coverage from progress=100', async () => {
  const h = harness();
  const result = await h.worker.runOnce(scope, h.run, h.now);
  expect(h.source.pending).toHaveBeenCalledWith(scope, { limit: 1, runId: h.run });
  expect(h.source.acknowledge).toHaveBeenCalledWith(scope, h.pending, expect.objectContaining({ protocol: 'jrc-history-source/2',
    runId: h.run, scopeKey: h.pending.scopeKey, payloadHash: h.pending.payloadHash, durablyAccepted: true }));
  expect(h.store.acceptChunk.mock.invocationCallOrder[0]).toBeLessThan(h.source.acknowledge.mock.invocationCallOrder[0]!);
  expect(result).toMatchObject({ kind: 'ADVANCED', source: 'ACKNOWLEDGED', capture: 'CAPTURING' });
  expect(h.chunk.isLast).toBe(false);
});
it('retains the source obligation when the Broker commit failed, but advances previously persisted work', async () => {
  const h = harness(); h.store.acceptChunk.mockRejectedValue(Error('synthetic private failure'));
  expect(await h.worker.runOnce(scope, h.run, h.now)).toMatchObject({ source: 'RETRY', materialization: 'IDLE', projection: 'IDLE' });
  expect(h.source.acknowledge).not.toHaveBeenCalled(); expect(h.projector.runOnce).toHaveBeenCalledOnce();
});
it('refuses a page correlated to another run, even if the source scope is the same', async () => {
  const h = harness(); h.pending.runId = randomUUID();
  expect(await h.worker.runOnce(scope, h.run, h.now)).toMatchObject({ source: 'RETRY' });
  expect(h.store.acceptChunk).not.toHaveBeenCalled(); expect(h.source.acknowledge).not.toHaveBeenCalled();
});
it('honors cancellation before pulling a source page and does not drain a canceled run', async () => {
  const h = harness(); h.store.get.mockImplementation(async () => ({ id: h.run, organizationId: scope.organizationId, channelId: scope.channelId,
    instanceId: scope.instanceId, state: 'CANCELED', capture: 'PARTIAL', historyAccountIdentity: scope.historyAccountIdentity,
    revision: 2, lastError: null, persistence: 'RUNNING', projection: 'RUNNING' }));
  expect(await h.worker.runOnce(scope, h.run, h.now)).toEqual({ kind: 'INACTIVE', state: 'CANCELED' });
  expect(h.source.pending).not.toHaveBeenCalled(); expect(h.store.persistNext).not.toHaveBeenCalled();
});
it('requires the current admission before any private read and never projects provisional identity', async () => {
  const h = harness(); h.assertAdmission.mockRejectedValueOnce(Error('HISTORY_SYNC_SCOPE_CHANGED'));
  await expect(h.worker.runOnce(scope, h.run, h.now)).rejects.toThrow('HISTORY_SYNC_SCOPE_CHANGED');
  expect(h.store.get).not.toHaveBeenCalled();
  h.store.get.mockImplementation(async () => ({ id: h.run, organizationId: scope.organizationId, channelId: scope.channelId,
    instanceId: scope.instanceId, state: 'RUNNING', capture: 'WAITING_IDENTITY', historyAccountIdentity: null,
    revision: 1, lastError: null, persistence: 'PENDING', projection: 'PENDING' }));
  expect(await h.worker.runOnce(scope, h.run, h.now)).toMatchObject({ capture: 'WAITING_IDENTITY', materialization: 'WAITING_IDENTITY', projection: 'WAITING_IDENTITY' });
  expect(h.projector.runOnce).not.toHaveBeenCalled(); expect(h.store.persistNext).not.toHaveBeenCalled();
});
