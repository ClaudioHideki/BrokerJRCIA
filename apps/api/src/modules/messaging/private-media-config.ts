import { MediaError } from '@jrc/providers';
import { createS3PrivateObjectStore, type PrivateObjectStore } from './private-object-store.js';

export interface PrivateMediaBackend { profile: string; objectStore: PrivateObjectStore; requestTimeoutMs: number }
export function loadPrivateMediaBackend(environment: NodeJS.ProcessEnv): PrivateMediaBackend | undefined {
  const invalid = (): never => { throw new MediaError('MEDIA_STORAGE_CONFIG_INVALID'); };
  const driver = environment.MEDIA_STORAGE_DRIVER || 'postgres';
  const fields = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_PROFILE', 'MEDIA_S3_REGION', 'MEDIA_S3_ACCESS_KEY_ID',
    'MEDIA_S3_SECRET_ACCESS_KEY', 'MEDIA_S3_DEDICATED_BUCKET', 'MEDIA_S3_REQUEST_TIMEOUT_MS'] as const;
  if (driver === 'postgres') {
    if (fields.some(key => Boolean(environment[key]))) invalid();
    return undefined;
  }
  if (driver !== 's3') invalid();
  const profile = environment.MEDIA_S3_PROFILE || 'broker-media-v1';
  const requestTimeoutMs = environment.MEDIA_S3_REQUEST_TIMEOUT_MS === undefined || environment.MEDIA_S3_REQUEST_TIMEOUT_MS === ''
    ? 30000 : Number(environment.MEDIA_S3_REQUEST_TIMEOUT_MS);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60000
    || environment.MEDIA_S3_DEDICATED_BUCKET !== 'true') invalid();
  try {
    const objectStore = createS3PrivateObjectStore({ endpoint: environment.MEDIA_S3_ENDPOINT ?? '',
      bucket: environment.MEDIA_S3_BUCKET ?? '', profile, region: environment.MEDIA_S3_REGION || 'us-east-1',
      accessKeyId: environment.MEDIA_S3_ACCESS_KEY_ID ?? '', secretAccessKey: environment.MEDIA_S3_SECRET_ACCESS_KEY ?? '',
      dedicatedBucket: true, requestTimeoutMs });
    return Object.freeze({ profile, objectStore, requestTimeoutMs });
  } catch { return invalid(); }
}
