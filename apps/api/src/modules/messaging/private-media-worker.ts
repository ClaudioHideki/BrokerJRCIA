export interface PrivateMediaRecoveryOptions {
  mode: 'allowlist' | 'automatic';
  organizations: readonly string[];
  discover(after: string | null, limit: number): Promise<readonly string[]>;
  runOnce(organizationId: string): Promise<void>;
  belongsToShard(organizationId: string): boolean;
  signal?: AbortSignal;
  onError?: () => void;
}
/** Factual recovery only. This port cannot download from providers or send messages. */
export async function recoverPrivateMedia(options: PrivateMediaRecoveryOptions): Promise<void> {
  let cursor: string | null = null;
  let more = true;
  while (more && !options.signal?.aborted) {
    const organizations: readonly string[] = options.mode === 'automatic'
      ? await options.discover(cursor, 100) : options.organizations;
    more = options.mode === 'automatic' && organizations.length === 100;
    cursor = organizations.at(-1) ?? cursor;
    for (const organizationId of organizations) {
      if (options.signal?.aborted) return;
      if (!options.belongsToShard(organizationId)) continue;
      try { await options.runOnce(organizationId); }
      catch {
        if (!options.onError) throw new Error('PRIVATE_MEDIA_RECOVERY_FAILED');
        options.onError();
      }
    }
  }
}
