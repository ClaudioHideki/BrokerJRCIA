import type { createHistorySyncStore } from './store.js';
import type { createHistorySyncProjector } from './projector.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { HistorySyncScopeSchema, historyCaptureScopeKey, type HistorySyncScope } from './contract.js';
import { acceptHistorySourceChunk } from './source.js';

type Store = Pick<ReturnType<typeof createHistorySyncStore>, 'get' | 'acceptChunk' | 'persistNext'>;
type Pending = { scopeKey: string; runId: string; payloadHash: string; chunk: unknown };
export interface HistorySourceReader {
  pending(scope: HistorySyncScope, selection: { limit: 1; runId: string }): Promise<Pending[]>;
  acknowledge(scope: HistorySyncScope, pending: Pending, receipt: Awaited<ReturnType<typeof acceptHistorySourceChunk>>): Promise<boolean>;
}
type Options = {
  enabled: boolean;
  store: Store;
  source: HistorySourceReader;
  projector: Pick<ReturnType<typeof createHistorySyncProjector>, 'runOnce'>;
  media?: {runOnce(scope:HistorySyncScope,runId:string,now:Date):Promise<{kind:string}>};
  /** Private host port: verify the admitted policy/source and current authority.
   * No browser or source payload may supply this capability. Store transactions
   * independently retain their revocation fences through COMMIT. */
  assertAdmission(scope: HistorySyncScope, runId: string): Promise<void>;
};

/** Headless, bounded driver of an already admitted run. One source page and one
 * delivery per tick, with PostgreSQL owning all progress. It cannot admit runs,
 * pair sessions, send WhatsApp messages or assert source coverage completion. */
export function createHistorySyncWorker(options: Options) {
  return {
    async runOnce(rawScope: HistorySyncScope, runId: string, now: Date) {
      if (!options.enabled) return { kind: 'DISABLED' } as const;
      const scope = Object.freeze(HistorySyncScopeSchema.parse(rawScope));
      if (!Number.isFinite(now.getTime())) throw Error('HISTORY_SYNC_CLOCK_INVALID');
      await options.assertAdmission(scope, runId);
      const current = await options.store.get(scope.organizationId, runId);
      if (!current || current.channelId !== scope.channelId || current.instanceId !== scope.instanceId)
        throw Error('HISTORY_SYNC_NOT_FOUND');
      if (current.state !== 'RUNNING') return { kind: 'INACTIVE', state: current.state } as const;

      let source: 'IDLE' | 'ACKNOWLEDGED' | 'RETRY' | 'BACKPRESSURE' = 'IDLE';
      try {
        const pages = await options.source.pending(scope, { limit: 1, runId });
        if (pages.length > 1) throw Error('HISTORY_SYNC_SOURCE_LIMIT');
        const page = pages[0];
        if (page) {
          if (page.runId !== runId || page.scopeKey !== historyCaptureScopeKey(scope)
            || page.payloadHash !== hashIdempotencyRequest(page.chunk)) throw Error('HISTORY_SYNC_SOURCE_CORRELATION');
          // No ACK before the encrypted Broker page is durably committed.
          const receipt = await acceptHistorySourceChunk(options.store, scope, runId, page.chunk, now);
          source = receipt.durablyAccepted
            ? await options.source.acknowledge(scope, page, receipt) ? 'ACKNOWLEDGED' : 'RETRY'
            : 'BACKPRESSURE';
        }
      } catch {
        // Leave the source obligation/bytes in KEEP. A failed source must not
        // freeze work already committed in the Broker while the receiver recovers.
        source = 'RETRY';
      }
      let materialization: string = 'WAITING_IDENTITY', projection: string = 'WAITING_IDENTITY',media: string = 'WAITING_IDENTITY';
      if (current.historyAccountIdentity !== null) {
        if(options.media) {
          try {media=(await options.media.runOnce(scope,runId,now)).kind;}
          catch {media='RETRY';}
        }
        try { materialization = (await options.store.persistNext(scope, runId, now)).kind; }
        catch { materialization = 'RETRY'; }
        try { projection = (await options.projector.runOnce(scope, runId, now)).kind; }
        catch { projection = 'RETRY'; }
      }
      // Baileys progress/isLatest is never promoted to a coverage-close proof.
      return { kind: 'ADVANCED', source, materialization, projection, capture: current.capture,...(options.media?{media}:{}) } as const;
    },
  };
}
