import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { PairOperationActionSchema, type PairOperationAction } from '@jrc/contracts';

const CIPHER = 'aes-256-gcm';
const DEFAULT_TTL_MS = 60_000;
const PREFIX = 'jrc:pair-action:v1:';

export interface PairActionBinding {
  organizationId: string;
  integrationId: string;
  operationId: string;
}

export interface PairActionStore {
  save(input: PairActionBinding & { action: PairOperationAction }): Promise<void>;
  take(input: PairActionBinding): Promise<PairOperationAction | null>;
}

export interface PairActionRedisClient {
  set(key: string, value: string, options: { PX: number; NX: true }): Promise<string | null>;
  getDel(key: string): Promise<string | null>;
}

export interface PairActionStoreOptions {
  client: PairActionRedisClient;
  encryptionKey: string;
  now?: () => Date;
  ttlMs?: number;
}

function bindingBytes(binding: PairActionBinding): Buffer {
  return Buffer.from(`${binding.organizationId}\0${binding.integrationId}\0${binding.operationId}`, 'utf8');
}

function decodeKey(serialized: string): Buffer {
  const key = Buffer.from(serialized, 'base64');
  if (key.length !== 32 || key.toString('base64') !== serialized) throw new Error('INVALID_PAIR_ACTION_ENCRYPTION_KEY');
  return key;
}

export function createPairActionStore(options: PairActionStoreOptions): PairActionStore {
  const key = decodeKey(options.encryptionKey);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_TTL_MS)
    throw new Error('INVALID_PAIR_ACTION_TTL');
  const now = options.now ?? (() => new Date());
  const cacheKey = (binding: PairActionBinding) => `${PREFIX}${createHmac('sha256', key).update(bindingBytes(binding)).digest('base64url')}`;
  return {
    async save(input) {
      const action = PairOperationActionSchema.parse(input.action);
      const remainingMs = Math.min(ttlMs, Date.parse(action.expiresAt) - now().getTime());
      if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) return;
      const nonce = randomBytes(12);
      const cipher = createCipheriv(CIPHER, key, nonce);
      cipher.setAAD(bindingBytes(input));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(action), 'utf8'), cipher.final()]);
      const encrypted = JSON.stringify({ v: 1, nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
      await options.client.set(cacheKey(input), encrypted, { PX: remainingMs, NX: true });
    },
    async take(input) {
      const encrypted = await options.client.getDel(cacheKey(input));
      if (!encrypted) return null;
      try {
        const envelope = JSON.parse(encrypted) as { v: number; nonce: string; ciphertext: string; tag: string };
        if (envelope.v !== 1) return null;
        const decipher = createDecipheriv(CIPHER, key, Buffer.from(envelope.nonce, 'base64url'));
        decipher.setAAD(bindingBytes(input));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
        const action = PairOperationActionSchema.parse(JSON.parse(Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final(),
        ]).toString('utf8')));
        return Date.parse(action.expiresAt) > now().getTime() ? action : null;
      } catch {
        return null;
      }
    },
  };
}
