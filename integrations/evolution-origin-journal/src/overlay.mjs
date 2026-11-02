import { createHash } from 'node:crypto';

export const PINNED_SOURCE_COMMIT = 'fa09d37892cdbb1d65a250155d293d92230c5b30';
export const PINNED_SERVICE_LF_SHA256 = 'd920d4fdd3cae90cb0369ad501774388388f28475135562f6977628efa913d0c';

/** Returns a staging-only source overlay. Does not write vendor files or provide a bootstrap. */
export function preparePinnedSourceHook(source) {
  if (typeof source !== 'string' || createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex') !== PINNED_SERVICE_LF_SHA256) throw new Error('ORIGIN_SOURCE_MISMATCH');
  const marker = 'this.client.ev.process(async (events) => {';
  if (source.split(marker).length !== 2) throw new Error('ORIGIN_SOURCE_MISMATCH');
  return source.replace(marker, `${marker}
      // JRC origin capture MUST commit before the volatile Promise queue below.
      // Staging only: bootstrap and exclusive direct-webhook ownership still require integration.
      if (process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true') {
        const jrcOrigin = (this as unknown as { jrcOriginJournal?: {
          deliveryOwnership: string; capture(events: unknown): Promise<unknown>;
        } }).jrcOriginJournal;
        if (!jrcOrigin || jrcOrigin.deliveryOwnership !== 'INTEGRATION_ONLY' || typeof jrcOrigin.capture !== 'function') {
          throw new Error('ORIGIN_HOOK_NOT_INSTALLED');
        }
        const jrcCapture = await jrcOrigin.capture(events) as { enabled?: boolean; captured?: number };
        if (jrcCapture?.enabled !== true || !Number.isSafeInteger(jrcCapture.captured) || jrcCapture.captured < 0) {
          throw new Error('ORIGIN_CAPTURE_NOT_ENABLED');
        }
      }`);
}
