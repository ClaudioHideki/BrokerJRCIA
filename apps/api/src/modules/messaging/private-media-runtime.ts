import { MediaError } from '@jrc/providers';
import { createDurablePrivateMediaStore, type DurablePrivateMediaOptions, type DurablePrivateMediaStore } from './durable-private-media.js';
import { loadPrivateMediaBackend } from './private-media-config.js';
export function createPrivateMediaRuntime(environment: NodeJS.ProcessEnv,
  ports: Pick<DurablePrivateMediaOptions,'transact'|'cleanupTransact'>): DurablePrivateMediaStore | undefined {
  const backend=loadPrivateMediaBackend(environment);
  if(!backend) return undefined;
  try {
    return createDurablePrivateMediaStore({...ports,...backend,encryptionKey:environment.INTEGRATION_ENCRYPTION_KEY??'',
      maxStorageBytes:Number(environment.MEDIA_STORAGE_BYTES_PER_ORGANIZATION??1073741824)});
  } catch { throw new MediaError('MEDIA_STORAGE_CONFIG_INVALID'); }
}
