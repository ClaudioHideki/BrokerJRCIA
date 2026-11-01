import { createHash } from 'node:crypto';
export const PINNED_WEBHOOK_LF_SHA256 = '8d7dd73a3d658cca0a827fdf97f674446c33fc8372fa9f89462921215c5df090';

/** Staging string only. Selective local/global webhook suppression; other fanout source is untouched. */
export function preparePinnedWebhookOwnership(source) {
  if (typeof source !== 'string' || createHash('sha256').update(source.replaceAll('\r\n','\n')).digest('hex') !== PINNED_WEBHOOK_LF_SHA256) throw new Error('ORIGIN_WEBHOOK_SOURCE_MISMATCH');
  const marker = "    const instance = (await this.get(instanceName)) as wa.LocalWebHook;";
  const helper = `
    // JRC: installed only with a reviewed engine bootstrap. No ownership boolean is accepted.
    const jrcMayDeliver = async (destination: string): Promise<boolean> => {
      if (process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED !== 'true') return true;
      try {
        const guard = (this as unknown as { jrcOriginWebhookGuard?: {
          decide(input: unknown): Promise<string>;
        } }).jrcOriginWebhookGuard;
        if (!guard || typeof guard.decide !== 'function') throw new Error('ORIGIN_WEBHOOK_GUARD_NOT_INSTALLED');
        const decision = await guard.decide({ instanceName, event, data, destination });
        if (decision !== 'SUPPRESS_OWNED' && decision !== 'DELIVER_LEGACY') throw new Error('ORIGIN_WEBHOOK_GUARD_INVALID');
        return decision === 'DELIVER_LEGACY';
      } catch {
        // Fail closed for this destination; preserve unrelated branches and later generic fanout.
        // No error message, destination, credentials or payload enters the diagnostic.
        this.logger.error({ local: 'JRC_ORIGIN_WEBHOOK', code: 'ORIGIN_WEBHOOK_GUARD_FAILED' });
        return false;
      }
    };
`;
  const local = "        try {\n          if (instance?.enabled && regex.test(instance.url)) {";
  const global = "        try {\n          if (regex.test(globalURL)) {";
  let prepared = source.replaceAll('\r\n','\n');
  if (![marker,local,global].every(value => prepared.split(value).length === 2)) throw new Error('ORIGIN_WEBHOOK_SOURCE_MISMATCH');
  prepared = prepared.replace(marker, `${helper}\n${marker}`);
  prepared = prepared.replace(local, "        const jrcDeliverLocal = await jrcMayDeliver(baseURL);\n        try {\n          if (jrcDeliverLocal && instance?.enabled && regex.test(instance.url)) {");
  prepared = prepared.replace(global, "        const jrcDeliverGlobal = await jrcMayDeliver(globalURL);\n        try {\n          if (jrcDeliverGlobal && regex.test(globalURL)) {");
  return prepared;
}
