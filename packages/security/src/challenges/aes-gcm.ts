import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import type { RandomBytesSource } from '../tokens/opaque.js';

export interface EncryptedChallenge {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
  authTag: string;
}

function encryptionKey(key: Uint8Array): Buffer {
  const normalized = Buffer.from(key);
  if (normalized.byteLength !== 32) {
    throw new Error('Challenge encryption key must contain exactly 32 bytes');
  }
  return normalized;
}

export function encryptChallenge(
  plaintext: string,
  key: Uint8Array,
  random: RandomBytesSource = randomBytes,
): EncryptedChallenge {
  const iv = Buffer.from(random(12));
  if (iv.byteLength !== 12) {
    throw new Error('Challenge IV must contain exactly 12 bytes');
  }

  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptChallenge(payload: EncryptedChallenge, key: Uint8Array): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(key),
    Buffer.from(payload.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
