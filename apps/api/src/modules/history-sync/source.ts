import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { HistorySyncScopeSchema, historyCaptureScopeKey, parseHistorySyncSourceChunk, type HistorySyncScope } from './contract.js';
import type { createHistorySyncStore } from './store.js';

/** Private source adapter. The host supplies verified scope and holds its authority
 * fence through the store transaction. This is not an unversioned HTTP route.
 * STAGED confirms durable private bytes only; it does not confirm owner or media custody.
 */
export async function acceptHistorySourceChunk(store: Pick<ReturnType<typeof createHistorySyncStore>, 'acceptChunk'>, scope: HistorySyncScope,
  runId: string, rawChunk: unknown, now: Date) {
  const verified = Object.freeze(HistorySyncScopeSchema.parse(scope));
  const chunk = parseHistorySyncSourceChunk(rawChunk,verified,now);
  const correlation = { protocol: 'jrc-history-source/2' as const, runId, scopeKey: historyCaptureScopeKey(verified),
    payloadHash: hashIdempotencyRequest(chunk) };
  const accepted = await store.acceptChunk(verified, runId, chunk, now);
  if (accepted.kind === 'GAP') return { ...correlation, kind: 'GAP' as const, durablyAccepted: false,
    chunkId: accepted.chunkId, reason: accepted.reason };
  return { ...correlation, kind: accepted.kind, durablyAccepted: true,
    chunkId: accepted.chunkId, checksum: accepted.checksum };
}
